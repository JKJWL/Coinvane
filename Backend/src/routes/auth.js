import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import { query, queryOne } from "../db.js";
import { enqueueMail } from "../queue.js";
import { renderInviteEmail, renderNotificationDigest, isEmailEnabled } from "../mailer.js";
import { audit } from "../audit.js";

const SIGNUP_MODE = () => process.env.SIGNUP_MODE || "invite";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// Hard allowlist — if set, ONLY these emails can sign in (case-insensitive).
// Leave empty (or unset) to disable the allowlist (not recommended for public deployments).
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

function emailAllowed(email) {
  if (ALLOWED_EMAILS.length === 0) return true;
  return ALLOWED_EMAILS.includes((email || "").toLowerCase());
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

function tokenStr() { return crypto.randomBytes(32).toString("hex"); }

function userPayload(u) {
  return {
    id: u.id, email: u.email, name: u.name, role: u.role, picture: u.picture,
    currency: u.currency, timezone: u.timezone,
    dark_mode: !!u.dark_mode,
    notification_email: !!u.notification_email,
    notification_push: !!u.notification_push,
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
    if (!emailAllowed(email)) {
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
      // New user — decide if signup is allowed
      const userCount = (await queryOne("SELECT COUNT(*) AS c FROM users"))?.c || 0;
      const mode = SIGNUP_MODE();
      let role = "user";
      let acceptInvitationId = null;

      if (userCount === 0) {
        role = "admin"; // first user is always admin
      } else if (mode === "open") {
        // allow
      } else if (mode === "invite") {
        const inv = await queryOne(
          `SELECT * FROM invitations WHERE email = ? AND accepted = FALSE AND expires_at > NOW()
           ORDER BY created_at DESC LIMIT 1`,
          [email]
        );
        if (!inv) return reply.code(403).send({ error: "No invitation found for this email" });
        acceptInvitationId = inv.id;
      } else {
        return reply.code(403).send({ error: "Signups are disabled" });
      }

      const r = await query(
        `INSERT INTO users (email, google_id, picture, name, role) VALUES (?, ?, ?, ?, ?)`,
        [email, googleId, picture, name, role]
      );
      if (acceptInvitationId) {
        await query("UPDATE invitations SET accepted = TRUE WHERE id = ?", [acceptInvitationId]);
      }
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

  // ── Send a sample email digest to the signed-in user.
  // Lets the user (and admin during setup) verify SMTP credentials are
  // configured correctly without waiting for a real notification event.
  app.post("/me/test-email", {
    preHandler: [app.authenticate],
    config: { rateLimit: { max: 3, timeWindow: "1 minute" } },
  }, async (req, reply) => {
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
    const mail = renderNotificationDigest({ userName: u.name, notifications: sample });
    try {
      await enqueueMail({ to: u.email, ...mail });
      return { ok: true, sentTo: u.email };
    } catch (e) {
      req.log.warn({ err: e.message }, "test-email failed");
      return reply.code(500).send({ error: "Could not enqueue mail. Check SMTP env vars." });
    }
  });

  // ── Profile / settings ──────────────────────────────────────────
  app.get("/me", { preHandler: [app.authenticate] }, async (req) => {
    const u = await queryOne(
      `SELECT id, email, name, role, picture, currency, timezone, dark_mode,
              notification_email, notification_push FROM users WHERE id = ?`, [req.user.id]
    );
    return userPayload(u);
  });

  app.patch("/me", { preHandler: [app.authenticate] }, async (req) => {
    const { name, currency, timezone, dark_mode, notification_email, notification_push } = req.body || {};
    await query(
      `UPDATE users SET
         name = COALESCE(?, name),
         currency = COALESCE(?, currency),
         timezone = COALESCE(?, timezone),
         dark_mode = COALESCE(?, dark_mode),
         notification_email = COALESCE(?, notification_email),
         notification_push = COALESCE(?, notification_push)
       WHERE id = ?`,
      [name ?? null, currency ?? null, timezone ?? null,
       (dark_mode === undefined ? null : (dark_mode ? 1 : 0)),
       (notification_email === undefined ? null : (notification_email ? 1 : 0)),
       (notification_push === undefined ? null : (notification_push ? 1 : 0)),
       req.user.id]
    );
    const u = await queryOne(
      `SELECT id, email, name, role, picture, currency, timezone, dark_mode,
              notification_email, notification_push FROM users WHERE id = ?`, [req.user.id]
    );
    return userPayload(u);
  });

  // ── Invitations (admin) ─────────────────────────────────────────
  app.post("/invitations", { preHandler: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== "admin") return reply.code(403).send({ error: "Admin only" });
    const { email } = req.body || {};
    if (!email) return reply.code(400).send({ error: "Email required" });

    const token = tokenStr();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await query(
      `INSERT INTO invitations (email, token, invited_by, expires_at) VALUES (?, ?, ?, ?)`,
      [email, token, req.user.id, expires]
    );

    const inviter = await queryOne("SELECT name FROM users WHERE id = ?", [req.user.id]);
    const link = `${process.env.APP_URL || ""}/`;
    try {
      await enqueueMail({ to: email, ...renderInviteEmail({ inviterName: inviter.name, link }) });
    } catch (e) { req.log.warn({ err: e.message }, "invite email enqueue failed"); }

    return { ok: true, token, link, expires_at: expires };
  });

  app.get("/invitations", { preHandler: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== "admin") return reply.code(403).send({ error: "Admin only" });
    return query(
      `SELECT id, email, accepted, expires_at, created_at FROM invitations
       ORDER BY created_at DESC LIMIT 100`
    );
  });

  app.delete("/invitations/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== "admin") return reply.code(403).send({ error: "Admin only" });
    await query("DELETE FROM invitations WHERE id = ?", [req.params.id]);
    return { ok: true };
  });

  // ── Users (admin) ───────────────────────────────────────────────
  app.get("/users", { preHandler: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== "admin") return reply.code(403).send({ error: "Admin only" });
    return query(
      `SELECT id, email, name, role, picture, created_at,
              (SELECT COUNT(*) FROM accounts WHERE user_id = users.id) AS accountCount
       FROM users ORDER BY created_at DESC`
    );
  });

  app.delete("/users/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== "admin") return reply.code(403).send({ error: "Admin only" });
    if (Number(req.params.id) === req.user.id) {
      return reply.code(400).send({ error: "Cannot delete yourself" });
    }
    await query("DELETE FROM users WHERE id = ?", [req.params.id]);
    return { ok: true };
  });
}
