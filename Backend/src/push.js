// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Web Push helper — sends notifications to browsers/PWAs that have
// enrolled via `POST /auth/me/push-subscriptions`. Wraps the `web-push`
// library and handles subscription cleanup when the browser reports a
// stale endpoint (HTTP 404 / 410).
//
// VAPID keys live in .env:
//   VAPID_PUBLIC_KEY   — the base64url-encoded EC public key
//   VAPID_PRIVATE_KEY  — the base64url-encoded EC private key
//   VAPID_SUBJECT      — a mailto: or https: URL identifying you
// Generate once with `npx web-push generate-vapid-keys` and paste in.
// If any is missing, sendPush() no-ops (silently) so a fresh deploy
// without keys still works — just doesn't push.
import webpush from "web-push";
import { query, queryOne } from "./db.js";

const PUB     = process.env.VAPID_PUBLIC_KEY  || "";
const PRIV    = process.env.VAPID_PRIVATE_KEY || "";
const SUBJECT = process.env.VAPID_SUBJECT     || "mailto:admin@example.com";
let CONFIGURED = false;
try {
  if (PUB && PRIV) {
    webpush.setVapidDetails(SUBJECT, PUB, PRIV);
    CONFIGURED = true;
  }
} catch (e) {
  console.warn("[push] VAPID configuration invalid:", e.message);
}

export function isPushConfigured() { return CONFIGURED; }
export function getVapidPublicKey() { return PUB; }

/**
 * Push cadence used to have instant/daily/weekly parity with email,
 * but the "daily" and "weekly" options were confusing because the
 * push channel is inherently real-time — batching a lock-screen alert
 * to 8AM tomorrow defeats its purpose. Push is now always instant.
 * Kept as a helper so callers don't need to know the policy inline.
 * `freq` and `weekday` are ignored; kept in the signature so the two
 * existing call sites stay unchanged. `context` is also unused now
 * (both inline and cron pushes always fire).
 */
export function shouldPushNow(/* freq, weekday, context */) {
  return true;
}

/**
 * When multiple notifications land in the same run (typical for the
 * daily cron sweep), we send exactly ONE push — the highest-priority
 * one — instead of stacking a lock-screen full of banners. The bell
 * still shows every row; only the OS-level notification is collapsed.
 *
 * Higher number = more urgent. Anything not in the map defaults to 0
 * so unknown types sort to the bottom instead of the top.
 */
const PUSH_PRIORITY = {
  large_transaction:  100,  // real money went out unexpectedly
  cashflow_low:        90,  // projected to go negative soon
  budget_exceeded:     80,  // past limit right now
  bill_reminder:       70,  // deadline approaching
  budget_warning:      60,  // approaching limit
  budget_usage_high:   55,  // overall budget usage high
  goal_complete:       40,  // positive milestone
  goal_milestone:      30,  // progress toward goal
  income_received:     20,  // positive news, least urgent
  test_push:           10,  // developer test
};

export function pickTopPush(notifications) {
  if (!Array.isArray(notifications) || notifications.length === 0) return null;
  let top = notifications[0];
  let topScore = PUSH_PRIORITY[top.type] ?? 0;
  for (let i = 1; i < notifications.length; i++) {
    const n = notifications[i];
    const s = PUSH_PRIORITY[n.type] ?? 0;
    if (s > topScore) { top = n; topScore = s; }
  }
  return top;
}

/**
 * Send a push notification to every subscription belonging to a user.
 * Payload is opaque to the push service (E2E encrypted); the service
 * worker JSON.parses it and calls showNotification(). Silent no-op if
 * VAPID isn't configured, so notification-engine can call this
 * unconditionally.
 *
 * Cleans up stale subscriptions on 404 / 410 (browser rotated the
 * endpoint or the user revoked permission) so we don't keep hammering
 * dead URLs.
 */
export async function sendPush(userId, { title, body, url, tag, icon, badge, subscriptionId }) {
  if (!CONFIGURED) return { sent: 0, cleaned: 0 };
  // Optional subscriptionId narrows the fanout to exactly one device.
  // Used by the per-device "send test" button so the caller can prove
  // whether a specific installation (their iPhone, their laptop, etc.)
  // receives + renders the push independently of other enrolled
  // devices for the same user.
  const subs = subscriptionId
    ? await query(
        "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? AND id = ?",
        [userId, subscriptionId]
      )
    : await query(
        "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?",
        [userId]
      );
  if (!subs.length) return { sent: 0, cleaned: 0 };

  // If the caller didn't pass an explicit badge count, look up the
  // user's current unread total. Included in the payload so the SW
  // can call navigator.setAppBadge() to surface the red dot on the
  // installed PWA icon (Android Chrome, iOS 16.4+ Safari, macOS
  // dock, Windows/ChromeOS taskbar). Falls back to undefined on
  // query failure so the SW knows to skip the badge update rather
  // than clobber a good count with 0.
  let badgeCount = badge;
  if (badgeCount === undefined) {
    try {
      const row = await queryOne(
        "SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL",
        [userId]
      );
      badgeCount = Number(row?.c || 0);
    } catch { /* leave undefined — SW will no-op the badge call */ }
  }

  const payload = JSON.stringify({
    title: String(title || "Coinvane"),
    body:  body ? String(body) : "",
    url:   url  ? String(url)  : "/",
    tag:   tag  ? String(tag)  : undefined,
    icon:  icon || "/icon-192.png",
    badge: typeof badgeCount === "number" ? badgeCount : undefined,
    // A dated timestamp so the SW notification's default sort works.
    ts:    Date.now(),
  });

  let sent = 0, cleaned = 0;
  for (const s of subs) {
    const subscription = {
      endpoint: s.endpoint,
      keys: { p256dh: s.p256dh, auth: s.auth },
    };
    try {
      await webpush.sendNotification(subscription, payload);
      sent++;
      // Best-effort last-used stamp for the "manage devices" UI.
      await query(
        "UPDATE push_subscriptions SET last_used_at = NOW() WHERE id = ?",
        [s.id]
      );
    } catch (e) {
      const status = e?.statusCode;
      if (status === 404 || status === 410) {
        // Browser rotated the endpoint or user revoked permission.
        // Delete so we don't retry every alert.
        try {
          await query("DELETE FROM push_subscriptions WHERE id = ?", [s.id]);
          cleaned++;
        } catch { /* swallow — DB hiccup shouldn't block other sends */ }
      } else {
        console.warn(`[push] send failed (${status || "?"}):`, e.message);
      }
    }
  }
  return { sent, cleaned };
}
