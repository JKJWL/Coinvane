// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "../db.js";
import { getAppSetting, setAppSetting } from "../app-settings.js";
import { isEmailEnabled } from "../mailer.js";
import { geoFromIp } from "../audit.js";

/**
 * Admin-only surface. Every route checks req.user.role === 'admin' and
 * 403s otherwise. Mounted under /admin in server.js.
 *
 * Endpoints:
 *   GET    /info               — app + env info card
 *   GET    /sync-interval      — current sync interval (minutes)
 *   PATCH  /sync-interval      — set sync interval (worker re-reads on restart)
 *   GET    /allowlist          — current allowlist (string[])
 *   PUT    /allowlist          — replace allowlist
 *   GET    /audit              — latest 100 audit log entries (with geo lookup)
 *   POST   /cleanup-notifications  — delete notifications older than N days
 */
// Per-route rate limit applied to every admin endpoint. The global
// 200/min already covers these, but @fastify/rate-limit's per-route
// `config.rateLimit` is what CodeQL's `js/missing-rate-limiting`
// pattern recognises, and it gives admin endpoints a stricter ceiling
// than the global one. Pure DDoS hygiene — the auth + admin role
// preHandlers are the real access gate.
const ADMIN_LIMIT = { max: 60, timeWindow: "1 minute" };

export default async function (app) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", async (req, reply) => {
    if (req.user.role !== "admin") {
      return reply.code(403).send({ error: "Admin only" });
    }
  });

  // ── App info card ────────────────────────────────────────────
  app.get("/info", { config: { rateLimit: ADMIN_LIMIT } }, async () => {
    const dbStats = await queryOne(
      `SELECT
         (SELECT COUNT(*) FROM users)        AS users,
         (SELECT COUNT(*) FROM accounts)     AS accounts,
         (SELECT COUNT(*) FROM transactions) AS transactions,
         (SELECT COUNT(*) FROM budgets)      AS budgets,
         (SELECT COUNT(*) FROM goals)        AS goals,
         (SELECT COUNT(*) FROM notifications) AS notifications,
         (SELECT COUNT(*) FROM audit_log)    AS audit_entries`
    );
    return {
      plaidEnvironment: process.env.PLAID_ENV || "production",
      emailEnabled: isEmailEnabled(),
      smtpHost: process.env.SMTP_HOST || null,
      signupMode: process.env.SIGNUP_MODE || "open",
      nodeEnv: process.env.NODE_ENV || "development",
      stats: dbStats,
    };
  });

  // ── Sync interval ────────────────────────────────────────────
  app.get("/sync-interval", { config: { rateLimit: ADMIN_LIMIT } }, async () => {
    const v = await getAppSetting("sync_interval_minutes", "SYNC_INTERVAL_MINUTES");
    return { minutes: Math.max(1, Number(v) || 60) };
  });

  app.patch("/sync-interval", { config: { rateLimit: ADMIN_LIMIT } }, async (req, reply) => {
    const n = Math.round(Number(req.body?.minutes));
    if (!Number.isFinite(n) || n < 1 || n > 1440) {
      return reply.code(400).send({ error: "minutes must be 1-1440" });
    }
    await setAppSetting("sync_interval_minutes", String(n));
    return { ok: true, minutes: n, note: "Restart the worker for the new interval to take effect." };
  });

  // ── Allowlist editor (DB-backed) ─────────────────────────────
  app.get("/allowlist", { config: { rateLimit: ADMIN_LIMIT } }, async () => {
    const v = await getAppSetting("allowed_emails", "ALLOWED_EMAILS");
    const list = (v || "").split(",").map(s => s.trim()).filter(Boolean);
    return { emails: list };
  });

  app.put("/allowlist", { config: { rateLimit: ADMIN_LIMIT } }, async (req, reply) => {
    const emails = Array.isArray(req.body?.emails) ? req.body.emails : null;
    if (!emails) return reply.code(400).send({ error: "emails: string[] required" });
    // Dedupe + lowercase + light shape validation. We avoid the simpler
    // regex `^[^\s@]+@[^\s@]+\.[^\s@]+$` because its overlapping `+`
    // quantifiers backtrack on adversarial input — CodeQL's
    // `js/polynomial-redos` flags it. Manual split-based check is both
    // faster on long input and impossible to make backtrack.
    const isValidEmail = (e) => {
      if (e.length < 3 || e.length > 254) return false;       // RFC 5321 cap
      const at = e.indexOf("@");
      if (at < 1 || at !== e.lastIndexOf("@")) return false;  // exactly one @
      const local = e.slice(0, at);
      const domain = e.slice(at + 1);
      if (!local || !domain) return false;
      if (local.includes(" ") || domain.includes(" ")) return false;
      const dot = domain.lastIndexOf(".");
      // domain must have a dot, not at the boundary, and a non-empty TLD
      return dot > 0 && dot < domain.length - 1;
    };
    const cleaned = [...new Set(
      emails.map(e => String(e || "").trim().toLowerCase()).filter(isValidEmail)
    )];
    await setAppSetting("allowed_emails", cleaned.join(","));
    return { ok: true, emails: cleaned };
  });

  // ── Audit log (last 100, with geo lookup on the fly) ─────────
  app.get("/audit", { config: { rateLimit: ADMIN_LIMIT } }, async () => {
    const rows = await query(
      `SELECT al.id, al.user_id, u.email AS userEmail, al.action,
              al.ip, al.user_agent, al.metadata, al.created_at AS createdAt
       FROM audit_log al
       LEFT JOIN users u ON u.id = al.user_id
       ORDER BY al.id DESC
       LIMIT 100`
    );
    return rows.map(r => ({
      id: r.id,
      userId: r.user_id,
      userEmail: r.userEmail,
      action: r.action,
      ip: r.ip,
      location: geoFromIp(r.ip),
      userAgent: r.user_agent,
      createdAt: r.createdAt,
    }));
  });

  // ── Notification cleanup ─────────────────────────────────────
  app.post("/cleanup-notifications", { config: { rateLimit: ADMIN_LIMIT } }, async (req, reply) => {
    const days = Math.max(1, Math.min(365, Math.round(Number(req.body?.days) || 30)));
    const r = await query(
      `DELETE FROM notifications WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [days]
    );
    return { ok: true, deleted: r.affectedRows || 0, olderThanDays: days };
  });
}
