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
import { query } from "./db.js";

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
export async function sendPush(userId, { title, body, url, tag, icon }) {
  if (!CONFIGURED) return { sent: 0, cleaned: 0 };
  const subs = await query(
    "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?",
    [userId]
  );
  if (!subs.length) return { sent: 0, cleaned: 0 };

  const payload = JSON.stringify({
    title: String(title || "Coinvane"),
    body:  body ? String(body) : "",
    url:   url  ? String(url)  : "/",
    tag:   tag  ? String(tag)  : undefined,
    icon:  icon || "/icon-192.png",
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
