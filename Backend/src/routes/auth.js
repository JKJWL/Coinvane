// SPDX-License-Identifier: AGPL-3.0-or-later
import { OAuth2Client } from "google-auth-library";
import { verifyMicrosoftIdToken, checkMicrosoftTenantPolicy } from "../microsoft-verify.js";
import { promises as fs } from "fs";
import path from "path";
import { query, queryOne } from "../db.js";
import { enqueueMail } from "../queue.js";
import { renderNotificationDigest, renderOneTimeLinkEmail, isEmailEnabled } from "../mailer.js";
import cryptoNode from "node:crypto";
import { audit } from "../audit.js";
import { getAllowedEmails } from "../app-settings.js";
import { plaid } from "../plaid-client.js";
import { decrypt } from "../crypto.js";
import { getVapidPublicKey, isPushConfigured, sendPush } from "../push.js";
import {
  makeRegistrationOptions,
  completeRegistration,
  makeAuthenticationOptions,
  completeAuthentication,
} from "../webauthn.js";

const ATTACHMENTS_ROOT = process.env.ATTACHMENTS_ROOT || "/data/attachments";

// "open" (default): any allowlisted Google account can sign up.
// "closed": no new users — existing users may still sign in. Use after
//           the household roster is finalised to harden the deployment.
const SIGNUP_MODE = () => process.env.SIGNUP_MODE || "open";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
// Microsoft Entra sign-in.
// No client secret — the frontend uses MSAL redirect + PKCE and we
// verify the returned ID token against Microsoft's JWKS.
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || "";
// Explicit enable/disable — evaluated at request time so an operator
// can flip it in .env + restart without dropping the client id.
// The "unset" case defaults to true when a client id IS present and
// false otherwise (feature can never be on without a client id).
const MICROSOFT_SSO_ENABLED = () => {
  const raw = process.env.MICROSOFT_SSO_ENABLED;
  if (raw === undefined || raw === "") return !!MICROSOFT_CLIENT_ID;
  return String(raw).toLowerCase() === "true" && !!MICROSOFT_CLIENT_ID;
};
// Which Microsoft accounts to accept. See microsoft-verify.js for
// exact semantics of each value.
const MICROSOFT_TENANT = () => (process.env.MICROSOFT_TENANT || "common").trim();
// Optional override for the redirect URI. When set, both the backend
// (public-config) and the frontend (MSAL config) use this value.
// When blank, the frontend falls back to window.location.origin + "/auth".
const MICROSOFT_REDIRECT_URI = () => (process.env.MICROSOFT_REDIRECT_URI || "").trim();

// Plaid feature toggle — lets an operator run Coinvane as a manual-only
// budgeting app. When disabled every /api/plaid/* route returns 404, the
// worker skips scheduling periodic syncs, and the frontend hides every
// Plaid touchpoint (link button, sync buttons, connected-banks panel,
// admin Plaid-counts card). Default is derived from PLAID_CLIENT_ID
// presence so an operator who never filled in Plaid credentials
// automatically gets manual-only mode with no extra config; an explicit
// PLAID_ENABLED=false forces disable even when credentials are present.
const PLAID_ENABLED = () => {
  const raw = process.env.PLAID_ENABLED;
  const hasCreds = !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
  if (raw === undefined || raw === "") return hasCreds;
  return String(raw).toLowerCase() === "true" && hasCreds;
};
export { PLAID_ENABLED };

// ── One-time email sign-in link (Sign In With One Time Link) ────────
// Gated by ONE_TIME_LINK_ENABLED env var so the feature stays off
// until an operator explicitly turns it on. Requires EMAIL_CONFIG
// enabled + working SMTP; the /request endpoint returns 503 with an
// operator-facing message when SMTP is off. Tokens are 48 random
// bytes (base64url = 64 chars, ~384 bits of entropy — collision-free
// at any realistic scale) and stored only as SHA-256 hex so a DB
// dump can't be used to hijack outstanding links.
const ONE_TIME_LINK_ENABLED = () =>
  String(process.env.ONE_TIME_LINK_ENABLED || "").toLowerCase() === "true";
// Strict-IP binding: the IP that requested the link must match the IP
// that opens it. Blocks a stolen-email attack where the attacker's IP
// differs from the victim's. Also blocks legitimate cross-device flow
// (request on laptop, click on phone). Default is strict per the
// operator's choice; loosen by setting ONE_TIME_LINK_STRICT_IP=false.
const ONE_TIME_LINK_STRICT_IP = () =>
  String(process.env.ONE_TIME_LINK_STRICT_IP || "true").toLowerCase() !== "false";
const ONE_TIME_LINK_EXPIRES_MIN = 15;
const ONE_TIME_LINK_TOKEN_BYTES = 48;
// Handoff-code alphabet omits look-alikes (0/O, 1/I/L). 8 chars * 30
// symbols = ~656B combinations — infeasible to brute-force in a
// 10-minute window with our 20/min rate limit.
const HANDOFF_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const HANDOFF_LENGTH = 8;
const HANDOFF_EXPIRES_MIN = 10;
function newHandoffCode() {
  // Rejection sampling to keep the distribution uniform. `buf[i] % 30`
  // would bias symbols 0-15 slightly (256 = 8*30 + 16 → those 16
  // values get an extra representation each), which CodeQL flags as
  // js/biased-cryptographic-random. We instead discard any byte in
  // the biased tail (>= floor(256/30)*30 = 240) and pull fresh bytes
  // as needed. In practice virtually every batch of 8 bytes fits
  // without a redraw (probability of rejecting a byte = 16/256 ≈ 6%).
  const A = HANDOFF_ALPHABET.length;
  const MAX = Math.floor(256 / A) * A; // 240 for A=30
  let out = "";
  while (out.length < HANDOFF_LENGTH) {
    const need = HANDOFF_LENGTH - out.length;
    // Over-fetch a bit so the average case is one round-trip to the
    // crypto RNG. `need * 2` covers the tail probability comfortably.
    const buf = cryptoNode.randomBytes(need * 2);
    for (let i = 0; i < buf.length && out.length < HANDOFF_LENGTH; i++) {
      if (buf[i] < MAX) out += HANDOFF_ALPHABET[buf[i] % A];
    }
  }
  return out;
}
function sha256Hex(s) {
  return cryptoNode.createHash("sha256").update(s).digest("hex");
}
function newOneTimeToken() {
  // base64url so the token is URL-safe without percent-encoding
  return cryptoNode.randomBytes(ONE_TIME_LINK_TOKEN_BYTES).toString("base64url");
}

async function emailAllowed(email) {
  // Allowlist now lives in the app_settings table (with fallback to the
  // ALLOWED_EMAILS env). Admin UI mutates the DB row; auth path consults
  // it on each sign-in. Empty allowlist = no restriction.
  const list = await getAllowedEmails();
  if (list.length === 0) return true;
  return list.includes((email || "").toLowerCase());
}

const DEFAULT_CATEGORIES = [
  ["Groceries", "#10b981", "Utensils"], ["Restaurants", "#f59e0b", "Coffee"],
  ["Gas & Fuel", "#ef4444", "Car"], ["Entertainment", "#ec4899", "Film"],
  ["Shopping", "#8b5cf6", "ShoppingBag"], ["Utilities", "#3b82f6", "Zap"],
  ["Subscriptions", "#06b6d4", "Repeat"], ["Health & Fitness", "#f43f5e", "Heart"],
  ["Income", "#10b981", "DollarSign"], ["Travel", "#0ea5e9", "Plane"],
  ["Home", "#a855f7", "Home"], ["Transfer", "#64748b", "ArrowUpRight"],
  ["Other", "#6b7280", "Briefcase"],
];

async function seedCategoriesFor(userId) {
  for (const [name, color, icon] of DEFAULT_CATEGORIES) {
    await query(
      "INSERT IGNORE INTO categories (user_id, name, color, icon, custom) VALUES (?, ?, ?, ?, FALSE)",
      [userId, name, color, icon]
    );
  }
}

function userPayload(u) {
  return {
    id: u.id, email: u.email, name: u.name, role: u.role, picture: u.picture,
    currency: u.currency, timezone: u.timezone,
    dark_mode: !!u.dark_mode,
    notification_email: !!u.notification_email,
    notification_push: !!u.notification_push,
    // Notification prefs
    notify_large_txn:       u.notify_large_txn       === undefined ? true  : !!u.notify_large_txn,
    large_txn_threshold:    Number(u.large_txn_threshold ?? 500),
    notify_income:          u.notify_income          === undefined ? true  : !!u.notify_income,
    income_threshold:       Number(u.income_threshold ?? 100),
    notify_budget_warning:  u.notify_budget_warning  === undefined ? true  : !!u.notify_budget_warning,
    budget_warning_pct:     Number(u.budget_warning_pct ?? 80),
    notify_budget_exceeded: u.notify_budget_exceeded === undefined ? true  : !!u.notify_budget_exceeded,
    notify_goal_milestone:  u.notify_goal_milestone  === undefined ? true  : !!u.notify_goal_milestone,
    notify_bill_reminders:  u.notify_bill_reminders  === undefined ? true  : !!u.notify_bill_reminders,
    notify_bill_days_before: Number(u.notify_bill_days_before ?? 3),
    notify_cashflow_enabled: !!u.notify_cashflow_enabled,
    notify_cashflow_min:     Number(u.notify_cashflow_min ?? 0),
    notify_budget_usage_enabled: !!u.notify_budget_usage_enabled,
    notify_budget_usage_pct: Number(u.notify_budget_usage_pct ?? 90),
    // push_frequency is always "instant" now; the cadence selector was
    // removed since batching a lock-screen alert defeats its purpose.
    // Legacy DB values are ignored on read.
    push_frequency: "instant",
    biometric_lock_enabled: !!u.biometric_lock_enabled,
    // Misc prefs
    privacy_mode:    !!u.privacy_mode,
    show_cashflow_forecast: u.show_cashflow_forecast === undefined ? true : !!u.show_cashflow_forecast,
    week_start:      Number(u.week_start ?? 0),
    email_frequency: u.email_frequency || "daily",
    email_weekday:   Number(u.email_weekday ?? 1),
    // Server-side feature flag: tells the frontend whether the email
    // subsystem is enabled (EMAIL_CONFIG=enabled). The UI greys out the
    // Email Notifs toggle and shows a warning when this is false.
    email_enabled: isEmailEnabled(),
    // Server-side feature flag: manual-only mode. When false, the
    // frontend hides every Plaid touchpoint (link button, sync buttons,
    // connected-banks panel, admin Plaid-counts card) and the backend
    // 404s every /api/plaid/* route.
    plaid_enabled: PLAID_ENABLED(),
  };
}

export default async function (app) {
  // ── Google Sign-In (tight rate limit — prevents auth spray) ─────
  app.post("/google", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!googleClient) {
      return reply.code(500).send({ error: "Google Sign-In is not configured on the server" });
    }
    const { id_token } = req.body || {};
    if (!id_token) return reply.code(400).send({ error: "id_token required" });

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: id_token, audience: GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch (e) {
      req.log.warn({ err: e.message, ip: req.ip }, "google verify failed");
      await audit(null, "auth.invalid_token", req, { reason: e.message });
      return reply.code(401).send({ error: "Invalid Google credential" });
    }

    const googleId = payload.sub;
    const email = payload.email;
    const emailVerified = payload.email_verified;
    const name = payload.name || (email ? email.split("@")[0] : "User");
    const picture = payload.picture || null;
    if (!email || !emailVerified) {
      return reply.code(401).send({ error: "Google email not verified" });
    }

    // ── Hard allowlist enforcement ────────────────────────────────
    if (!(await emailAllowed(email))) {
      req.log.warn({ email, ip: req.ip }, "sign-in rejected: email not in allowlist");
      await audit(null, "auth.rejected", req, { reason: "not_in_allowlist", email });
      return reply.code(403).send({ error: "This Google account is not authorized to access this instance." });
    }

    // Try by google_id, then by email
    let user = await queryOne("SELECT * FROM users WHERE google_id = ?", [googleId]);
    if (!user) user = await queryOne("SELECT * FROM users WHERE email = ?", [email]);

    if (user) {
      // Link google_id if first time signing in with Google
      if (!user.google_id) {
        await query("UPDATE users SET google_id = ?, picture = COALESCE(picture, ?) WHERE id = ?",
          [googleId, picture, user.id]);
      } else if (user.picture !== picture) {
        await query("UPDATE users SET picture = ? WHERE id = ?", [picture, user.id]);
      }
      user = await queryOne("SELECT * FROM users WHERE id = ?", [user.id]);
    } else {
      // New user — allowlist already gated entry above. Only remaining
      // check is SIGNUP_MODE=closed (lockdown after household finalised).
      const userCount = (await queryOne("SELECT COUNT(*) AS c FROM users"))?.c || 0;
      let role = "user";

      if (userCount === 0) {
        role = "owner"; // first user is always owner (single-instance pattern)
      } else if (SIGNUP_MODE() === "closed") {
        return reply.code(403).send({ error: "Signups are disabled" });
      }

      const r = await query(
        `INSERT INTO users (email, google_id, picture, name, role) VALUES (?, ?, ?, ?, ?)`,
        [email, googleId, picture, name, role]
      );
      await seedCategoriesFor(r.insertId);
      user = await queryOne("SELECT * FROM users WHERE id = ?", [r.insertId]);
    }

    const token = app.jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      { expiresIn: "30d" }
    );
    await audit(user.id, "auth.success", req, { email: user.email });
    return { token, user: userPayload(user) };
  });

  // ── Microsoft Sign-In (personal MSA accounts only) ──────────────
  // Same shape as /google: the frontend runs the MSAL popup, hands us
  // the returned ID token, we verify it against Microsoft's JWKS
  // (issuer + audience + signature + expiry), then find-or-create the
  // user by email — SAME dedup semantics as Google + One-Time-Link so
  // all three methods land on one users row per address.
  app.post("/microsoft", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!MICROSOFT_SSO_ENABLED()) {
      return reply.code(404).send({ error: "Microsoft Sign-In is disabled on this instance" });
    }
    const { id_token } = req.body || {};
    if (!id_token) return reply.code(400).send({ error: "id_token required" });

    let payload;
    try {
      payload = await verifyMicrosoftIdToken(id_token, MICROSOFT_CLIENT_ID);
    } catch (e) {
      req.log.warn({ err: e.message, ip: req.ip }, "microsoft verify failed");
      await audit(null, "auth.invalid_token", req, { reason: e.message, provider: "microsoft" });
      return reply.code(401).send({ error: "Invalid Microsoft credential" });
    }

    // Tenant-scope policy: enforce MICROSOFT_TENANT after signature is
    // trusted. This is orthogonal to the allowlist — it decides which
    // sources of tokens we accept in the first place; the allowlist
    // still decides which specific emails from those sources may sign in.
    const tenantReject = checkMicrosoftTenantPolicy(payload, MICROSOFT_TENANT());
    if (tenantReject) {
      req.log.warn({ tid: payload?.tid, policy: MICROSOFT_TENANT(), ip: req.ip }, "microsoft tenant policy reject");
      await audit(null, "auth.rejected", req, { reason: "tenant_policy", tid: payload?.tid, policy: MICROSOFT_TENANT(), provider: "microsoft" });
      return reply.code(403).send({ error: tenantReject });
    }

    // MSA ID tokens: `sub` is the durable per-app user id, `email` is
    // present when the "email" optional claim is configured on the app
    // registration (walkthrough asked the operator to enable it).
    // `preferred_username` is the fallback — for MSA it's the account
    // email in every case we've observed.
    const msId = payload.sub;
    const email = String(payload.email || payload.preferred_username || "").toLowerCase();
    const name = payload.name || (email ? email.split("@")[0] : "User");
    if (!email) {
      await audit(null, "auth.rejected", req, { reason: "no_email_claim", provider: "microsoft" });
      return reply.code(401).send({ error: "Microsoft account has no email — enable the 'email' optional claim on your app registration" });
    }

    // ── Hard allowlist enforcement ────────────────────────────────
    if (!(await emailAllowed(email))) {
      req.log.warn({ email, ip: req.ip }, "sign-in rejected: email not in allowlist");
      await audit(null, "auth.rejected", req, { reason: "not_in_allowlist", email, provider: "microsoft" });
      return reply.code(403).send({ error: "This Microsoft account is not authorized to access this instance." });
    }

    // Try by microsoft_id first (fast path for repeat sign-in), then by
    // email (converges with Google + One-Time-Link on the same row).
    let user = await queryOne("SELECT * FROM users WHERE microsoft_id = ?", [msId]);
    if (!user) user = await queryOne("SELECT * FROM users WHERE email = ?", [email]);

    if (user) {
      if (!user.microsoft_id) {
        await query("UPDATE users SET microsoft_id = ? WHERE id = ?", [msId, user.id]);
      }
      user = await queryOne("SELECT * FROM users WHERE id = ?", [user.id]);
    } else {
      const userCount = (await queryOne("SELECT COUNT(*) AS c FROM users"))?.c || 0;
      let role = "user";
      if (userCount === 0) {
        role = "owner"; // first user is always owner (single-instance pattern)
      } else if (SIGNUP_MODE() === "closed") {
        return reply.code(403).send({ error: "Signups are disabled" });
      }
      const r = await query(
        `INSERT INTO users (email, microsoft_id, name, role) VALUES (?, ?, ?, ?)`,
        [email, msId, name, role]
      );
      await seedCategoriesFor(r.insertId);
      user = await queryOne("SELECT * FROM users WHERE id = ?", [r.insertId]);
    }

    const token = app.jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      { expiresIn: "30d" }
    );
    await audit(user.id, "auth.success", req, { email: user.email, method: "microsoft" });
    return { token, user: userPayload(user) };
  });

  // ── Public config for the login screen ────────────────────────────
  // Tiny endpoint the AuthScreen hits to decide whether to render the
  // "Sign in with a one-time link" button. Unauthenticated by design
  // (login page can't have a session yet). Exposes NO user data —
  // only feature-availability booleans. Rate-limited to keep it from
  // being a probe endpoint.
  app.get("/public-config", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async () => {
    return {
      oneTimeLinkEnabled: ONE_TIME_LINK_ENABLED() && isEmailEnabled(),
      // Microsoft is enabled only when BOTH a client id is set and the
      // MICROSOFT_SSO_ENABLED flag isn't explicitly false. Frontend
      // hides the button entirely when this is false — no dead UI.
      microsoftEnabled: MICROSOFT_SSO_ENABLED(),
      microsoftClientId: MICROSOFT_SSO_ENABLED() ? MICROSOFT_CLIENT_ID : null,
      // Tenant scope — controls which authority URL the frontend
      // opens (login.microsoftonline.com/<tenant>) and matches the
      // policy the backend enforces on returned tokens.
      microsoftTenant: MICROSOFT_SSO_ENABLED() ? MICROSOFT_TENANT() : null,
      // Optional redirect URI override. Null = frontend computes
      // window.location.origin + "/auth" at runtime.
      microsoftRedirectUri: MICROSOFT_SSO_ENABLED() && MICROSOFT_REDIRECT_URI()
        ? MICROSOFT_REDIRECT_URI() : null,
      // Manual-only mode indicator. Exposed pre-login so the sign-in
      // page and initial paint know whether to render Plaid affordances
      // (the value is also on the authed /me payload as plaid_enabled).
      plaidEnabled: PLAID_ENABLED(),
    };
  });

  // ── Request a one-time sign-in link ───────────────────────────────
  // Anti-enumeration policy: ALWAYS returns {ok: true} regardless of
  // whether the email is on the allowlist. Real work happens only for
  // allowlisted addresses; unauthorized addresses get a silent no-op
  // so an attacker can't probe the roster.
  //
  // Per-route rate limit (20/min/IP) sits alongside a per-email
  // throttle enforced by counting rows in email_signin_tokens created
  // in the last hour. 5 emails/hour/email is the ceiling.
  app.post("/one-time-link/request", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    // Feature gate + SMTP gate. 503 on SMTP-off is intentional: an
    // operator who left the feature on but broke SMTP should see a
    // real error, not silent success. Only ONE_TIME_LINK_ENABLED
    // being off produces the 404 (feature is genuinely not exposed).
    if (!ONE_TIME_LINK_ENABLED()) {
      return reply.code(404).send({ error: "Feature disabled" });
    }
    if (!isEmailEnabled()) {
      return reply.code(503).send({ error: "Email is disabled on the server (EMAIL_CONFIG must be enabled)" });
    }

    const rawEmail = String(req.body?.email || "").trim().toLowerCase();
    // Light shape validation — mirrors the allowlist parser. Malformed
    // input just falls through to the silent-success path.
    const looksLikeEmail = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,64}$/.test(rawEmail);
    if (!looksLikeEmail) {
      return { ok: true }; // silent success
    }

    // Not on allowlist? Silent success, no work performed. Audit the
    // attempt so an operator can spot probing patterns.
    if (!(await emailAllowed(rawEmail))) {
      await audit(null, "signin_link.rejected", req, { reason: "not_in_allowlist", email: rawEmail });
      return { ok: true }; // silent success
    }

    // Per-email throttle: max 5 requests in the last hour, but the
    // counter RESETS on a successful sign-in. Reasoning: only
    // allowlisted addresses can trigger the mail path in the first
    // place (silent-success guard above), and a successful redeem
    // is proof this is a real user, not a stuck client or an inbox
    // flood attempt. Without reset, a user who requests 5 links then
    // signs in gets locked out for the rest of the hour when they
    // legitimately try again from another device.
    // Silent success on trip — matches the rest.
    const lastRedeem = await queryOne(
      `SELECT MAX(used_at) AS t FROM email_signin_tokens
       WHERE email = ? AND used_at IS NOT NULL`,
      [rawEmail]
    );
    const recent = await queryOne(
      `SELECT COUNT(*) AS c FROM email_signin_tokens
       WHERE email = ?
         AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
         AND created_at > COALESCE(?, '1970-01-01')`,
      [rawEmail, lastRedeem?.t || null]
    );
    if (Number(recent?.c || 0) >= 5) {
      await audit(null, "signin_link.rate_limited", req, { email: rawEmail });
      return { ok: true }; // silent success
    }

    // Generate token, store hash, mail raw token in link.
    const rawToken = newOneTimeToken();
    const tokenHash = sha256Hex(rawToken);
    await query(
      `INSERT INTO email_signin_tokens (email, token_hash, expires_at, requester_ip)
       VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), ?)`,
      [rawEmail, tokenHash, ONE_TIME_LINK_EXPIRES_MIN, req.ip || null]
    );

    const appUrl = process.env.APP_URL || "https://coinvane.local";
    // The `#signin?t=` URL fragment is read by the SPA on load. Using
    // a fragment (rather than a query param) means the raw token
    // never appears in server access logs or referrer headers.
    const url = `${appUrl.replace(/\/$/, "")}/#signin?t=${rawToken}`;
    try {
      const mail = renderOneTimeLinkEmail({
        url, requesterIp: req.ip || null,
        expiresMinutes: ONE_TIME_LINK_EXPIRES_MIN,
      });
      await enqueueMail({ to: rawEmail, ...mail });
    } catch (e) {
      // Log but still return success to the client — mail-queue
      // failure should not reveal to the requester that the email
      // is on the allowlist.
      req.log.warn({ err: e.message, email: rawEmail }, "one-time-link mail enqueue failed");
    }
    await audit(null, "signin_link.requested", req, { email: rawEmail });
    return { ok: true };
  });

  // ── Verify + redeem a one-time sign-in link ───────────────────────
  // Called by the SPA when it lands on /#signin?t=<token>. Hashes the
  // incoming token, looks up an unused-unexpired row, marks it used,
  // finds-or-creates the user by email (same dedup semantics as the
  // Google Sign-In path so no matter which method a user tried first,
  // both land on the same users row), and issues the same 30-day JWT.
  app.post("/one-time-link/verify", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!ONE_TIME_LINK_ENABLED()) {
      return reply.code(404).send({ error: "Feature disabled" });
    }
    const rawToken = String(req.body?.token || "").trim();
    if (!rawToken || rawToken.length < 32 || rawToken.length > 512) {
      return reply.code(400).send({ error: "Invalid token" });
    }
    const tokenHash = sha256Hex(rawToken);
    const row = await queryOne(
      `SELECT id, email, expires_at, used_at, requester_ip
       FROM email_signin_tokens WHERE token_hash = ?`,
      [tokenHash]
    );
    if (!row) {
      await audit(null, "signin_link.invalid", req, { reason: "unknown_token" });
      return reply.code(401).send({ error: "This link is invalid or has already been used." });
    }
    if (row.used_at) {
      await audit(null, "signin_link.invalid", req, { reason: "already_used", email: row.email });
      return reply.code(410).send({ error: "This link has already been used. Request a new one." });
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await audit(null, "signin_link.invalid", req, { reason: "expired", email: row.email });
      return reply.code(410).send({ error: "This link has expired. Request a new one." });
    }

    // ── Strict IP binding ─────────────────────────────────────────
    // The IP that requested the link must match the IP that clicks
    // it. Blocks a stolen-email replay where the attacker's public
    // IP differs from the victim's. Loosen with ONE_TIME_LINK_STRICT_IP=false
    // if the cross-device flow (request desktop, click phone) is
    // more important than this protection.
    if (ONE_TIME_LINK_STRICT_IP()) {
      const currentIp = req.ip || null;
      if (row.requester_ip && currentIp && row.requester_ip !== currentIp) {
        await audit(null, "signin_link.invalid", req, {
          reason: "ip_mismatch", email: row.email,
          requesterIp: row.requester_ip, clickIp: currentIp,
        });
        return reply.code(403).send({
          error: "This link must be opened on the same network it was requested from. Request a new one on this device.",
        });
      }
    }

    // Re-check allowlist at redeem time. Someone could have been on
    // the allowlist when the link was minted, then removed before the
    // click; deny in that case. Defense in depth.
    const email = String(row.email || "").toLowerCase();
    if (!(await emailAllowed(email))) {
      await audit(null, "signin_link.rejected", req, { reason: "not_in_allowlist_at_redeem", email });
      return reply.code(403).send({ error: "This email is no longer authorized." });
    }

    // Consume the token FIRST — even if we bail on user creation
    // below, the token is spent. Prevents replay.
    await query("UPDATE email_signin_tokens SET used_at = NOW() WHERE id = ?", [row.id]);

    // Find or create user by email — SAME lookup semantics as Google
    // Sign-In so the two paths converge on one row per email
    // regardless of which came first.
    let user = await queryOne("SELECT * FROM users WHERE email = ?", [email]);
    if (!user) {
      const userCount = (await queryOne("SELECT COUNT(*) AS c FROM users"))?.c || 0;
      let role = "user";
      if (userCount === 0) {
        role = "owner"; // first user is always owner
      } else if (SIGNUP_MODE() === "closed") {
        return reply.code(403).send({ error: "Signups are disabled" });
      }
      const name = email.split("@")[0];
      const r = await query(
        `INSERT INTO users (email, name, role) VALUES (?, ?, ?)`,
        [email, name, role]
      );
      await seedCategoriesFor(r.insertId);
      user = await queryOne("SELECT * FROM users WHERE id = ?", [r.insertId]);
    }

    const token = app.jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      { expiresIn: "30d" }
    );

    // Issue a short handoff code alongside the JWT. Purpose: iOS
    // separates Safari's storage from the installed PWA's storage,
    // and there is no browser API that hands the JWT across that
    // boundary. So we ALSO mint a short user-friendly code that
    // the user can type into the PWA's login screen to sign in
    // there without needing another email. Optional — Android
    // users won't see it because the manifest's handle_links
    // routes the click straight into the PWA.
    const handoffRaw = newHandoffCode();
    const handoffHash = sha256Hex(handoffRaw);
    try {
      // issued_ip is the IP that redeemed the one-time link. When
      // ONE_TIME_LINK_STRICT_IP is on, /handoff enforces that the
      // redemption of THIS code must come from the same IP — same
      // rule as the primary link, so an over-the-shoulder code copy
      // can't be used from a different network.
      await query(
        `INSERT INTO signin_handoff_codes (code_hash, user_id, expires_at, issued_ip)
         VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), ?)`,
        [handoffHash, user.id, HANDOFF_EXPIRES_MIN, req.ip || null]
      );
    } catch (e) {
      // Handoff is best-effort — a DB hiccup shouldn't fail the sign-in.
      req.log.warn({ err: e.message }, "handoff code insert failed");
    }

    await audit(user.id, "signin_link.verified", req, { email: user.email });
    await audit(user.id, "auth.success", req, { email: user.email, method: "one_time_link" });
    return {
      token, user: userPayload(user),
      handoffCode: handoffRaw,
      handoffExpiresMinutes: HANDOFF_EXPIRES_MIN,
    };
  });

  // ── Redeem a handoff code from the installed PWA ─────────────────
  // Second step of the cross-context sign-in flow. Browser tab already
  // consumed the one-time-link token and got a JWT; the code lets the
  // user paste that same session into the installed PWA on the same
  // device (or a different one). One-shot; expires quickly.
  app.post("/one-time-link/handoff", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!ONE_TIME_LINK_ENABLED()) {
      return reply.code(404).send({ error: "Feature disabled" });
    }
    const raw = String(req.body?.code || "").trim().toUpperCase();
    if (!raw || raw.length !== HANDOFF_LENGTH || !/^[A-Z0-9]+$/.test(raw)) {
      return reply.code(400).send({ error: "Invalid code" });
    }
    const codeHash = sha256Hex(raw);
    const row = await queryOne(
      `SELECT id, user_id, expires_at, used_at, issued_ip
       FROM signin_handoff_codes WHERE code_hash = ?`,
      [codeHash]
    );
    if (!row) {
      await audit(null, "signin_link.handoff_invalid", req, { reason: "unknown_code" });
      return reply.code(401).send({ error: "This code is invalid or has already been used." });
    }
    if (row.used_at) {
      await audit(null, "signin_link.handoff_invalid", req, { reason: "already_used" });
      return reply.code(410).send({ error: "This code has already been used." });
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await audit(null, "signin_link.handoff_invalid", req, { reason: "expired" });
      return reply.code(410).send({ error: "This code has expired. Sign in again from the browser." });
    }

    // ── Strict IP binding on the handoff too ──────────────────────
    // Same rule as the primary link: the IP that received the code
    // must match the IP that redeems it. Blocks the copy-and-share
    // attack where an over-the-shoulder viewer / screenshot leak
    // could redeem the code from a different network. Same escape
    // hatch (ONE_TIME_LINK_STRICT_IP=false loosens everywhere).
    if (ONE_TIME_LINK_STRICT_IP()) {
      const currentIp = req.ip || null;
      if (row.issued_ip && currentIp && row.issued_ip !== currentIp) {
        await audit(null, "signin_link.handoff_invalid", req, {
          reason: "ip_mismatch",
          issuedIp: row.issued_ip, redeemIp: currentIp,
        });
        return reply.code(403).send({
          error: "This code must be entered on the same network it was issued on.",
        });
      }
    }
    // Consume first — replay prevention.
    await query("UPDATE signin_handoff_codes SET used_at = NOW() WHERE id = ?", [row.id]);
    const user = await queryOne("SELECT * FROM users WHERE id = ?", [row.user_id]);
    if (!user) {
      // User was deleted between issue and redeem — treat as invalid.
      return reply.code(401).send({ error: "This code is no longer valid." });
    }
    const token = app.jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      { expiresIn: "30d" }
    );
    await audit(user.id, "signin_link.handoff_redeemed", req, { email: user.email });
    await audit(user.id, "auth.success", req, { email: user.email, method: "handoff_code" });
    return { token, user: userPayload(user) };
  });

  // ── Send a sample email digest to the signed-in admin.
  // Used to verify SMTP credentials. Admin-only because every fired test
  // costs one outbound email from the user's transactional-mail quota,
  // and there's no business reason a regular member needs to send themselves
  // a sample. Rate-limited to 3/min as an extra DDoS hygiene measure on
  // top of the role gate.
  app.post("/me/test-email", {
    preHandler: [app.authenticate],
    config: { rateLimit: { max: 3, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (req.user.role !== "owner") {
      return reply.code(403).send({ error: "Owner only" });
    }
    if (!isEmailEnabled()) {
      return reply.code(503).send({ error: "Email is disabled (EMAIL_CONFIG is not enabled on the server)" });
    }
    const u = await queryOne("SELECT email, name FROM users WHERE id = ?", [req.user.id]);
    if (!u) return reply.code(404).send({ error: "user not found" });
    const sample = [
      { type: "budget_warning", color: "amber",
        title: "Approaching limit: Restaurants",
        body: "82% of your $200.00 budget used this period." },
      { type: "large_transaction", color: "amber",
        title: "Large transaction: Whole Foods",
        body: "$284.16 on " + new Date().toISOString().slice(0, 10) },
      { type: "goal_milestone", color: "sky",
        title: "75% to Emergency Fund",
        body: "$3,750.00 of $5,000.00 saved." },
    ];
    const mail = renderNotificationDigest({
      userName: u.name, notifications: sample,
      disclaimer: "The Content Within This Email is A Test And Is Not Real",
    });
    try {
      await enqueueMail({ to: u.email, ...mail });
      return { ok: true, sentTo: u.email };
    } catch (e) {
      req.log.warn({ err: e.message }, "test-email failed");
      return reply.code(500).send({ error: "Could not enqueue mail. Check SMTP env vars." });
    }
  });

  // ── Owner-only: send a sample/test email to ANY user. ─────────
  // Used from the Members section in the Admin panel so the owner can
  // verify a specific user's address resolves through SMTP without
  // logging in as them. Same canned 3-notification payload as
  // /me/test-email, with the same TEST disclaimer banner so the
  // recipient knows it isn't real notification data.
  app.post("/users/:id/test-email", {
    preHandler: [app.authenticate],
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (req.user.role !== "owner") {
      return reply.code(403).send({ error: "Owner only" });
    }
    if (!isEmailEnabled()) {
      return reply.code(503).send({ error: "Email is disabled (EMAIL_CONFIG is not enabled on the server)" });
    }
    const u = await queryOne(
      "SELECT email, name FROM users WHERE id = ?", [req.params.id]
    );
    if (!u) return reply.code(404).send({ error: "user not found" });
    const sample = [
      { type: "budget_warning", color: "amber",
        title: "Approaching limit: Restaurants",
        body: "82% of your $200.00 budget used this period." },
      { type: "large_transaction", color: "amber",
        title: "Large transaction: Whole Foods",
        body: "$284.16 on " + new Date().toISOString().slice(0, 10) },
      { type: "goal_milestone", color: "sky",
        title: "75% to Emergency Fund",
        body: "$3,750.00 of $5,000.00 saved." },
    ];
    const mail = renderNotificationDigest({
      userName: u.name, notifications: sample,
      disclaimer: "The Content Within This Email is A Test And Is Not Real",
    });
    try {
      await enqueueMail({ to: u.email, ...mail });
      await audit(req.user.id, "admin.test_email", req, {
        targetId: Number(req.params.id), targetEmail: u.email,
      });
      return { ok: true, sentTo: u.email };
    } catch (e) {
      req.log.warn({ err: e.message }, "user test-email failed");
      return reply.code(500).send({ error: "Could not enqueue mail. Check SMTP env vars." });
    }
  });

  // ── Send a sample push notification to the signed-in admin. ─────
  // Mirrors /me/test-email — verifies the full pipeline (VAPID keys,
  // browser subscription, service worker) end-to-end. Admin-only for
  // the same reason (rate/quota hygiene). Returns {sent, cleaned} from
  // sendPush so the UI can distinguish "no devices enrolled" (sent=0)
  // from "server not configured" (503).
  app.post("/me/test-push", {
    preHandler: [app.authenticate],
    config: { rateLimit: { max: 3, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (req.user.role !== "owner") {
      return reply.code(403).send({ error: "Owner only" });
    }
    if (!isPushConfigured()) {
      return reply.code(503).send({ error: "Push is disabled (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set)" });
    }
    try {
      const subId = Number(req.body?.subscriptionId) || undefined;
      const title = "Coinvane test notification";
      const body = subId
        ? "Targeted to a single device. Tap 'Mark all read' in the bell to clear the badge."
        : "If you can see this, push is wired up correctly. Tap 'Mark all read' in the bell to clear the badge.";
      // Insert a real notification row so the bell surfaces the test
      // AND the badge count reflects genuine unread state. Marking it
      // read is then the ONLY way to clear the badge, which lets us
      // rule out "app is auto-clearing the badge on open" as an
      // explanation for a missing PWA icon dot.
      await query(
        `INSERT INTO notifications (user_id, type, icon, color, title, body)
         VALUES (?, 'test_push', 'Bell', 'violet', ?, ?)`,
        [req.user.id, title, body]
      );
      const r = await sendPush(req.user.id, {
        title, body,
        tag: "test_push",
        url: "/",
        // Omit badge — sendPush will look up the real unread count now
        // that the test row exists, so the number on the icon matches
        // what the bell shows.
        subscriptionId: subId,
      });
      if (r.sent === 0) {
        return reply.code(409).send({
          error: subId
            ? "That device didn't receive the push — it may have been revoked or the endpoint expired."
            : "No push-enabled devices for this account. Enable push in Settings first.",
          cleaned: r.cleaned,
        });
      }
      return { ok: true, targeted: !!subId, ...r };
    } catch (e) {
      req.log.warn({ err: e.message }, "test-push failed");
      return reply.code(500).send({ error: "Could not send push. Check server logs." });
    }
  });

  // ── Owner-only: send a sample push to ANY user. ─────────────────
  // Same shape as /users/:id/test-email. Useful for the members panel
  // when someone reports "notifications aren't reaching me" — the owner
  // can trigger one from their end and audit the result without logging
  // in as the target.
  app.post("/users/:id/test-push", {
    preHandler: [app.authenticate],
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (req.user.role !== "owner") {
      return reply.code(403).send({ error: "Owner only" });
    }
    if (!isPushConfigured()) {
      return reply.code(503).send({ error: "Push is disabled (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set)" });
    }
    const u = await queryOne(
      "SELECT id, email FROM users WHERE id = ?", [req.params.id]
    );
    if (!u) return reply.code(404).send({ error: "user not found" });
    try {
      const title = "Coinvane test notification";
      const body = "This is a test from your workspace owner. Push is working. Open the bell to mark it read.";
      // Insert a real notification row so the recipient sees the test
      // in their bell — same rationale as /me/test-push above.
      await query(
        `INSERT INTO notifications (user_id, type, icon, color, title, body)
         VALUES (?, 'test_push', 'Bell', 'violet', ?, ?)`,
        [u.id, title, body]
      );
      const r = await sendPush(u.id, {
        title, body,
        tag: "test_push",
        url: "/",
      });
      await audit(req.user.id, "admin.test_push", req, {
        targetId: u.id, targetEmail: u.email, sent: r.sent, cleaned: r.cleaned,
      });
      if (r.sent === 0) {
        return reply.code(409).send({
          error: `${u.email} has no push-enabled devices. They need to enable push in Settings first.`,
          cleaned: r.cleaned,
        });
      }
      return { ok: true, sentTo: u.email, ...r };
    } catch (e) {
      req.log.warn({ err: e.message }, "user test-push failed");
      return reply.code(500).send({ error: "Could not send push. Check server logs." });
    }
  });

  // ── Profile / settings ──────────────────────────────────────────
  const ME_COLUMNS = `id, email, name, role, picture, currency, timezone, dark_mode,
        notification_email, notification_push,
        notify_large_txn, large_txn_threshold,
        notify_income, income_threshold,
        notify_budget_warning, budget_warning_pct,
        notify_budget_exceeded, notify_goal_milestone,
        notify_bill_reminders, notify_bill_days_before,
        notify_cashflow_enabled, notify_cashflow_min,
        notify_budget_usage_enabled, notify_budget_usage_pct,
        push_frequency, biometric_lock_enabled,
        privacy_mode, show_cashflow_forecast, week_start, email_frequency, email_weekday`;

  app.get("/me", { preHandler: [app.authenticate] }, async (req) => {
    const u = await queryOne(`SELECT ${ME_COLUMNS} FROM users WHERE id = ?`, [req.user.id]);
    return userPayload(u);
  });

  // Active admin broadcasts visible to this user. Not gated on role —
  // every authenticated user reads their own list. Filters out archived
  // + expired rows; per-user dismiss is client-side (localStorage).
  app.get("/me/broadcasts", { preHandler: [app.authenticate] }, async () => {
    return query(
      `SELECT id, message, severity, created_at AS createdAt
       FROM admin_broadcasts
       WHERE archived_at IS NULL
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY id DESC LIMIT 10`
    );
  });

  // ── Web Push subscriptions (D10) ─────────────────────────────
  // Public: the VAPID application-server public key the browser needs
  // to open a PushManager subscription. Not authenticated on purpose
  // so the SW registration path doesn't need a session-scoped fetch.
  app.get("/push/vapid-public-key", async () => {
    return { key: getVapidPublicKey() || null };
  });

  // Enroll a browser/PWA. Body = the full PushSubscription.toJSON()
  // shape the frontend gets from PushManager.subscribe(). We store
  // endpoint + keys keyed by endpoint (unique) so re-subscribing the
  // same device just overwrites the row.
  app.post("/me/push-subscriptions", { preHandler: [app.authenticate] }, async (req, reply) => {
    const b = req.body || {};
    const endpoint = String(b.endpoint || "");
    const p256dh   = String(b.keys?.p256dh || "");
    const auth     = String(b.keys?.auth   || "");
    if (!endpoint || !p256dh || !auth) {
      return reply.code(400).send({ error: "endpoint + keys required" });
    }
    const ua = String(req.headers["user-agent"] || "").slice(0, 255);
    await query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE p256dh = VALUES(p256dh), auth = VALUES(auth),
                                user_agent = VALUES(user_agent), user_id = VALUES(user_id)`,
      [req.user.id, endpoint.slice(0, 500), p256dh.slice(0, 255), auth.slice(0, 255), ua]
    );
    return { ok: true };
  });

  // Unsubscribe just this device (by endpoint), or all this user's
  // devices when endpoint is omitted. Used by Settings → "Sign out
  // this device from push" / "Turn push off everywhere".
  app.delete("/me/push-subscriptions", { preHandler: [app.authenticate] }, async (req) => {
    const endpoint = req.body?.endpoint || req.query?.endpoint;
    if (endpoint) {
      await query(
        "DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?",
        [req.user.id, String(endpoint)]
      );
    } else {
      await query("DELETE FROM push_subscriptions WHERE user_id = ?", [req.user.id]);
    }
    return { ok: true };
  });

  // Manage-devices list. Endpoint URL isn't returned — it's opaque and
  // long — just id + user_agent + timestamps.
  app.get("/me/push-subscriptions", { preHandler: [app.authenticate] }, async (req) => {
    return query(
      `SELECT id, user_agent AS userAgent,
              last_used_at AS lastUsedAt, created_at AS createdAt
       FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC`,
      [req.user.id]
    );
  });

  // Revoke by ROW ID — the manage-devices UI knows ids but not the
  // opaque endpoint URLs (they're kept server-side). Scoped to the
  // caller's user_id so an id-collision attempt just 404s.
  app.delete("/me/push-subscriptions/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
    const r = await query(
      "DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    if (!r.affectedRows) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });

  // ── WebAuthn biometric app-lock (D12) ────────────────────────
  // Two ceremonies: register (adds a device via FaceID/TouchID) and
  // authenticate (unlocks after the app was locked). Rate-limited to
  // prevent enumeration + brute force attempts against the challenge
  // JWT.
  const WEBAUTHN_LIMIT = { max: 20, timeWindow: "1 minute" };

  app.post("/webauthn/register-options", {
    preHandler: [app.authenticate], config: { rateLimit: WEBAUTHN_LIMIT },
  }, async (req, reply) => {
    try { return await makeRegistrationOptions(req); }
    catch (e) {
      return reply.code(e.expose ? 400 : 500).send({ error: e.message });
    }
  });

  app.post("/webauthn/register", {
    preHandler: [app.authenticate], config: { rateLimit: WEBAUTHN_LIMIT },
  }, async (req, reply) => {
    try {
      const r = await completeRegistration(req, req.body || {});
      await audit(req.user.id, "webauthn.register", req, {}, { major: true });
      return r;
    } catch (e) {
      req.log.warn({ err: e.message }, "webauthn register failed");
      return reply.code(e.expose ? 400 : 500).send({ error: e.message });
    }
  });

  app.post("/webauthn/auth-options", {
    preHandler: [app.authenticate], config: { rateLimit: WEBAUTHN_LIMIT },
  }, async (req, reply) => {
    try { return await makeAuthenticationOptions(req); }
    catch (e) {
      return reply.code(e.expose ? 400 : 500).send({ error: e.message });
    }
  });

  app.post("/webauthn/verify", {
    preHandler: [app.authenticate], config: { rateLimit: WEBAUTHN_LIMIT },
  }, async (req, reply) => {
    try { return await completeAuthentication(req, req.body || {}); }
    catch (e) {
      req.log.warn({ err: e.message }, "webauthn verify failed");
      return reply.code(e.expose ? 400 : 500).send({ error: e.message });
    }
  });

  // List enrolled devices (id, name, timestamps only — no keys).
  app.get("/webauthn/credentials", { preHandler: [app.authenticate] }, async (req) => {
    return query(
      `SELECT id, device_name AS deviceName,
              created_at AS createdAt, last_used_at AS lastUsedAt
       FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC`,
      [req.user.id]
    );
  });

  // Revoke one device. If the last one goes, we also flip
  // biometric_lock_enabled off so the user isn't locked out of their app.
  app.delete("/webauthn/credentials/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
    const r = await query(
      "DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    if (!r.affectedRows) return reply.code(404).send({ error: "not found" });
    const remaining = await queryOne(
      "SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?",
      [req.user.id]
    );
    if (!Number(remaining?.n)) {
      await query(
        "UPDATE users SET biometric_lock_enabled = 0 WHERE id = ?",
        [req.user.id]
      );
    }
    await audit(req.user.id, "webauthn.revoke", req, { id: req.params.id });
    return { ok: true, remaining: Number(remaining?.n) || 0 };
  });

  // Toggle biometric_lock on/off without dropping credentials.
  app.patch("/webauthn/lock-enabled", { preHandler: [app.authenticate] }, async (req, reply) => {
    const enabled = req.body?.enabled ? 1 : 0;
    if (enabled) {
      const has = await queryOne(
        "SELECT id FROM webauthn_credentials WHERE user_id = ? LIMIT 1",
        [req.user.id]
      );
      if (!has) return reply.code(400).send({ error: "Enroll a device first" });
    }
    await query(
      "UPDATE users SET biometric_lock_enabled = ? WHERE id = ?",
      [enabled, req.user.id]
    );
    return { ok: true, enabled: !!enabled };
  });

  // ── Clear-all-my-data (D8) ────────────────────────────────────
  // Nuclear reset for a user who wants to start fresh (or stop using
  // the app but wipe their financial footprint). Deletes every
  // user_id-scoped row across the schema, revokes every Plaid item,
  // and unlinks every attachment file on disk. The users row itself
  // stays — this is "clear my data", not "delete my account", so the
  // user can immediately start over without re-onboarding through the
  // allowlist.
  //
  // Guards:
  //   - typed email confirmation (case-insensitive, exact match)
  //   - per-user rate limit: 3 per hour (paranoid; this is destructive)
  //   - audited as a major event (7-day retention)
  //   - owner CAN self-wipe (unlike /users/:id which forbids self-delete);
  //     the owner's role/allowlist stays intact so re-sign-in works
  app.post("/me/clear-data", {
    preHandler: [app.authenticate],
    config: { rateLimit: { max: 3, timeWindow: "1 hour" } },
  }, async (req, reply) => {
    const me = await queryOne("SELECT id, email FROM users WHERE id = ?", [req.user.id]);
    if (!me) return reply.code(404).send({ error: "user not found" });
    const typed = String(req.body?.confirm || "").trim().toLowerCase();
    if (!typed || typed !== String(me.email).toLowerCase()) {
      return reply.code(400).send({ error: "Type your email to confirm" });
    }

    const userId = me.id;

    // 1. Revoke every Plaid item so tokens can't be reused. Best-effort;
    //    a Plaid API failure doesn't stop the DB wipe.
    try {
      const items = await query(
        "SELECT access_token_enc FROM plaid_items WHERE user_id = ?", [userId]
      );
      for (const it of items) {
        try { await plaid.itemRemove({ access_token: decrypt(it.access_token_enc) }); }
        catch (e) { req.log.warn({ err: e.message }, "plaid revoke failed during clear-data"); }
      }
    } catch { /* swallow — proceed with DB wipe */ }

    // 2. Wipe attachment files before DB rows so we still have the paths.
    try {
      const rows = await query(
        "SELECT attachment_path FROM transactions WHERE user_id = ? AND attachment_path IS NOT NULL",
        [userId]
      );
      for (const r of rows) {
        try { await fs.unlink(path.join(ATTACHMENTS_ROOT, r.attachment_path)); } catch { /* file already gone */ }
      }
      // Also try to remove the per-user attachments dir (empty after unlinks).
      try { await fs.rmdir(path.join(ATTACHMENTS_ROOT, String(userId))); } catch { /* non-empty or missing */ }
    } catch { /* proceed anyway */ }

    // 3. Delete DB rows. Order: children before parents, then anything
    //    the FK cascade would tidy up on its own. Wrapped in per-table
    //    try/catch so an older DB missing a table can't stall the sweep.
    const tables = [
      "lot_disposals", "holding_lots", "holdings",
      "bill_cycles", "bills",
      "split_template_lines", "split_templates",
      "asset_damage_events", "assets",
      "reconciliations",
      "budget_audit",
      "notifications",
      "automation_rules",
      "merchant_rules",
      "saved_views",
      "saved_reports",
      "goals",
      "notes",
      "loans",
      "budgets",
      "transactions",
      "categories",
      "accounts",
      "plaid_items",
      "attachment_upload_log",
      "push_subscriptions",
      "webauthn_credentials",
    ];
    for (const t of tables) {
      try { await query(`DELETE FROM ${t} WHERE user_id = ?`, [userId]); }
      catch { /* table absent on legacy DBs; keep sweeping */ }
    }

    // 4. Reset a small handful of user-row preferences so a fresh start
    //    doesn't inherit stale income-tracker anchors, notification
    //    counts, cashflow forecast toggles, etc. Keeps role, email,
    //    google_id, name, picture, currency, timezone, dark_mode.
    try {
      await query(
        `UPDATE users SET
           income_period = 'monthly', income_period_start = NULL, income_period_days = NULL,
           credit_period = 'monthly', credit_period_start = NULL, credit_period_days = NULL,
           last_period_start = NULL,
           show_cashflow_forecast = 0,
           biometric_lock_enabled = 0
         WHERE id = ?`,
        [userId]
      );
    } catch { /* older schemas may lack some cols */ }

    await audit(userId, "user.clear_data", req, { by: "self" }, { major: true });
    return { ok: true };
  });

  // Coerce a body field to (1 | 0 | null). null means "don't update".
  const bool = (v) => (v === undefined ? null : (v ? 1 : 0));
  // Clamp + coerce an integer in [min, max], or null if undefined.
  const int = (v, min, max) => {
    if (v === undefined || v === null || v === "") return null;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return null;
    return Math.min(max, Math.max(min, n));
  };

  app.patch("/me", { preHandler: [app.authenticate] }, async (req) => {
    const b = req.body || {};
    const allowedFreq = ["instant", "daily", "weekly"];
    const freq = b.email_frequency && allowedFreq.includes(b.email_frequency)
      ? b.email_frequency : null;
    const pushFreq = b.push_frequency && allowedFreq.includes(b.push_frequency)
      ? b.push_frequency : null;
    await query(
      `UPDATE users SET
         name = COALESCE(?, name),
         currency = COALESCE(?, currency),
         timezone = COALESCE(?, timezone),
         dark_mode = COALESCE(?, dark_mode),
         notification_email = COALESCE(?, notification_email),
         notification_push = COALESCE(?, notification_push),
         notify_large_txn = COALESCE(?, notify_large_txn),
         large_txn_threshold = COALESCE(?, large_txn_threshold),
         notify_income = COALESCE(?, notify_income),
         income_threshold = COALESCE(?, income_threshold),
         notify_budget_warning = COALESCE(?, notify_budget_warning),
         budget_warning_pct = COALESCE(?, budget_warning_pct),
         notify_budget_exceeded = COALESCE(?, notify_budget_exceeded),
         notify_goal_milestone = COALESCE(?, notify_goal_milestone),
         notify_bill_reminders = COALESCE(?, notify_bill_reminders),
         notify_bill_days_before = COALESCE(?, notify_bill_days_before),
         notify_cashflow_enabled = COALESCE(?, notify_cashflow_enabled),
         notify_cashflow_min = COALESCE(?, notify_cashflow_min),
         notify_budget_usage_enabled = COALESCE(?, notify_budget_usage_enabled),
         notify_budget_usage_pct = COALESCE(?, notify_budget_usage_pct),
         privacy_mode = COALESCE(?, privacy_mode),
         show_cashflow_forecast = COALESCE(?, show_cashflow_forecast),
         week_start = COALESCE(?, week_start),
         email_frequency = COALESCE(?, email_frequency),
         email_weekday = COALESCE(?, email_weekday),
         push_frequency = COALESCE(?, push_frequency)
       WHERE id = ?`,
      [
        b.name ?? null, b.currency ?? null, b.timezone ?? null,
        bool(b.dark_mode), bool(b.notification_email), bool(b.notification_push),
        bool(b.notify_large_txn),       int(b.large_txn_threshold, 1, 1_000_000),
        bool(b.notify_income),          int(b.income_threshold, 1, 1_000_000),
        bool(b.notify_budget_warning),  int(b.budget_warning_pct, 1, 99),
        bool(b.notify_budget_exceeded), bool(b.notify_goal_milestone),
        bool(b.notify_bill_reminders),  int(b.notify_bill_days_before, 0, 60),
        bool(b.notify_cashflow_enabled), int(b.notify_cashflow_min, 0, 100_000_000),
        bool(b.notify_budget_usage_enabled), int(b.notify_budget_usage_pct, 1, 200),
        bool(b.privacy_mode),           bool(b.show_cashflow_forecast),
        int(b.week_start, 0, 6),
        freq,                           int(b.email_weekday, 0, 6),
        pushFreq,
        req.user.id,
      ]
    );
    const u = await queryOne(`SELECT ${ME_COLUMNS} FROM users WHERE id = ?`, [req.user.id]);
    return userPayload(u);
  });

  // ── Users (owner + admin) ───────────────────────────────────────
  // Any owner/admin can list members. Members table is read-only for
  // regular users.
  app.get("/users", { preHandler: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== "owner" && req.user.role !== "admin") {
      return reply.code(403).send({ error: "Admin only" });
    }
    return query(
      `SELECT id, email, name, role, picture, created_at,
              (SELECT COUNT(*) FROM accounts WHERE user_id = users.id) AS accountCount
       FROM users ORDER BY created_at DESC`
    );
  });

  // Delete a user — permission matrix:
  //   self:        nobody can delete themselves through this endpoint
  //   owner:       cannot be deleted by anyone
  //   admin:       only the owner can delete
  //   member:      owner or admin can delete
  // Every successful delete is audited as a major event so the row
  // survives the 7-day major-retention window.
  app.delete("/users/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== "owner" && req.user.role !== "admin") {
      return reply.code(403).send({ error: "Admin only" });
    }
    const targetId = Number(req.params.id);
    if (targetId === req.user.id) {
      return reply.code(400).send({ error: "Cannot delete yourself" });
    }
    const target = await queryOne(
      "SELECT id, email, role FROM users WHERE id = ?", [targetId]
    );
    if (!target) return reply.code(404).send({ error: "User not found" });
    if (target.role === "owner") {
      return reply.code(403).send({ error: "The owner cannot be deleted" });
    }
    if (target.role === "admin" && req.user.role !== "owner") {
      return reply.code(403).send({ error: "Only the owner can remove admins" });
    }
    await query("DELETE FROM users WHERE id = ?", [targetId]);
    await audit(req.user.id, "admin.user_delete", req, {
      targetId, targetEmail: target.email, targetRole: target.role,
    }, { major: true });
    return { ok: true };
  });

  // Owner-only: promote a member to admin or demote an admin to member.
  // 'owner' is never an option — there is exactly one owner per instance
  // and ownership transfer isn't implemented (manual DB edit if needed).
  app.patch("/users/:id/role", { preHandler: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== "owner") {
      return reply.code(403).send({ error: "Owner only" });
    }
    const newRole = String(req.body?.role || "");
    if (!["admin", "user"].includes(newRole)) {
      return reply.code(400).send({ error: "role must be 'admin' or 'user'" });
    }
    const targetId = Number(req.params.id);
    if (targetId === req.user.id) {
      return reply.code(400).send({ error: "Cannot change your own role" });
    }
    const target = await queryOne("SELECT id, email, role FROM users WHERE id = ?", [targetId]);
    if (!target) return reply.code(404).send({ error: "User not found" });
    if (target.role === "owner") {
      return reply.code(403).send({ error: "Owner role cannot be changed" });
    }
    if (target.role === newRole) {
      return { ok: true, unchanged: true };
    }
    await query("UPDATE users SET role = ? WHERE id = ?", [newRole, targetId]);
    await audit(req.user.id, "admin.role_change", req, {
      targetId, targetEmail: target.email,
      from: target.role, to: newRole,
    }, { major: true });
    return { ok: true };
  });
}
