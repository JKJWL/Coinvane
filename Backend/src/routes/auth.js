// SPDX-License-Identifier: AGPL-3.0-or-later
import { OAuth2Client } from "google-auth-library";
import { promises as fs } from "fs";
import path from "path";
import { query, queryOne } from "../db.js";
import { enqueueMail } from "../queue.js";
import { renderNotificationDigest, isEmailEnabled } from "../mailer.js";
import { audit } from "../audit.js";
import { getAllowedEmails } from "../app-settings.js";
import { plaid } from "../plaid-client.js";
import { decrypt } from "../crypto.js";
import { getVapidPublicKey } from "../push.js";

const ATTACHMENTS_ROOT = process.env.ATTACHMENTS_ROOT || "/data/attachments";

// "open" (default): any allowlisted Google account can sign up.
// "closed": no new users — existing users may still sign in. Use after
//           the household roster is finalised to harden the deployment.
const SIGNUP_MODE = () => process.env.SIGNUP_MODE || "open";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

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
    push_frequency: u.push_frequency || "daily",
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
        push_frequency,
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
           show_cashflow_forecast = 0
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
