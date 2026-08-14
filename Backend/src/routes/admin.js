// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "../db.js";
import { getAppSetting, setAppSetting } from "../app-settings.js";
import { isEmailEnabled } from "../mailer.js";
import { geoFromIp, audit } from "../audit.js";

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

// Owner-only guard for routes that mutate global instance config.
// Admins can VIEW the admin page but only the owner can change the
// security-sensitive knobs (sync interval, allowlist).
const ownerOnly = async (req, reply) => {
  if (req.user.role !== "owner") {
    return reply.code(403).send({ error: "Owner only" });
  }
};

export default async function (app) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", async (req, reply) => {
    if (req.user.role !== "owner" && req.user.role !== "admin") {
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

  app.patch("/sync-interval", {
    preHandler: [ownerOnly],
    config: { rateLimit: ADMIN_LIMIT },
  }, async (req, reply) => {
    const n = Math.round(Number(req.body?.minutes));
    if (!Number.isFinite(n) || n < 1 || n > 1440) {
      return reply.code(400).send({ error: "minutes must be 1-1440" });
    }
    await setAppSetting("sync_interval_minutes", String(n));
    await audit(req.user.id, "admin.sync_interval_change", req, { minutes: n }, { major: true });
    return { ok: true, minutes: n, note: "Restart the worker for the new interval to take effect." };
  });

  // ── Allowlist editor (DB-backed) ─────────────────────────────
  app.get("/allowlist", { config: { rateLimit: ADMIN_LIMIT } }, async () => {
    const v = await getAppSetting("allowed_emails", "ALLOWED_EMAILS");
    const list = (v || "").split(",").map(s => s.trim()).filter(Boolean);
    return { emails: list };
  });

  app.put("/allowlist", {
    preHandler: [ownerOnly],
    config: { rateLimit: ADMIN_LIMIT },
  }, async (req, reply) => {
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
    await audit(req.user.id, "admin.allowlist_change", req, { count: cleaned.length }, { major: true });
    return { ok: true, emails: cleaned };
  });

  // ── Audit log (last 100, with geo lookup on the fly) ─────────
  app.get("/audit", { config: { rateLimit: ADMIN_LIMIT } }, async () => {
    const rows = await query(
      `SELECT al.id, al.user_id, u.email AS userEmail, al.action,
              al.ip, al.user_agent, al.metadata, al.is_major AS isMajor,
              al.created_at AS createdAt
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
      isMajor: !!r.isMajor,
      createdAt: r.createdAt,
    }));
  });

  // ── Notification cleanup (any admin) ─────────────────────────
  // Audited as major because it bulk-deletes user-visible records and
  // is one of the few destructive actions admins can take.
  app.post("/cleanup-notifications", { config: { rateLimit: ADMIN_LIMIT } }, async (req, reply) => {
    const days = Math.max(1, Math.min(365, Math.round(Number(req.body?.days) || 30)));
    const r = await query(
      `DELETE FROM notifications WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [days]
    );
    await audit(req.user.id, "admin.notifications_cleanup", req, {
      olderThanDays: days, deleted: r.affectedRows || 0,
    }, { major: true });
    return { ok: true, deleted: r.affectedRows || 0, olderThanDays: days };
  });

  // ── Admin broadcasts (D4) ─────────────────────────────────────
  // Yellow-slip banner authored by admins/owners, shown to every user
  // on desktop. Per-user dismiss is client-side (localStorage) so no
  // per-user tracking table is needed. Only admins/owners can create,
  // edit, or archive. Rate-limited to 10/min because a runaway console
  // could otherwise spam the whole user base.
  const BROADCAST_LIMIT = { max: 10, timeWindow: "1 minute" };
  const SEVERITIES = new Set(["info", "warning", "critical"]);

  app.get("/broadcasts", { config: { rateLimit: ADMIN_LIMIT } }, async () => {
    // Admin view: includes archived + expired so history is visible.
    return query(
      `SELECT b.id, b.message, b.severity, b.expires_at AS expiresAt,
              b.archived_at AS archivedAt, b.created_at AS createdAt,
              u.email AS createdByEmail
       FROM admin_broadcasts b
       LEFT JOIN users u ON u.id = b.created_by
       ORDER BY b.created_at DESC LIMIT 200`
    );
  });

  app.post("/broadcasts", { config: { rateLimit: BROADCAST_LIMIT } }, async (req, reply) => {
    const { message, severity, expires_at } = req.body || {};
    const msg = String(message || "").trim();
    if (!msg) return reply.code(400).send({ error: "message required" });
    if (msg.length > 500) return reply.code(400).send({ error: "message too long (max 500)" });
    const sev = SEVERITIES.has(severity) ? severity : "info";
    // expires_at is optional; we normalise to null/valid MySQL datetime.
    const expiresIso = expires_at ? new Date(expires_at) : null;
    const expiresVal = expiresIso && !isNaN(expiresIso.getTime())
      ? expiresIso.toISOString().slice(0, 19).replace("T", " ")
      : null;
    const r = await query(
      `INSERT INTO admin_broadcasts (message, severity, created_by, expires_at)
       VALUES (?, ?, ?, ?)`,
      [msg, sev, req.user.id, expiresVal]
    );
    await audit(req.user.id, "admin.broadcast_create", req, {
      id: r.insertId, severity: sev, len: msg.length,
    }, { major: true });
    return queryOne("SELECT * FROM admin_broadcasts WHERE id = ?", [r.insertId]);
  });

  app.patch("/broadcasts/:id", { config: { rateLimit: BROADCAST_LIMIT } }, async (req, reply) => {
    const owned = await queryOne("SELECT id FROM admin_broadcasts WHERE id = ?", [req.params.id]);
    if (!owned) return reply.code(404).send({ error: "not found" });
    const b = req.body || {};
    const msg = b.message === undefined ? null : String(b.message || "").trim().slice(0, 500);
    const sev = b.severity === undefined
      ? null : (SEVERITIES.has(b.severity) ? b.severity : "info");
    const expiresVal = b.expires_at === undefined ? undefined
      : (b.expires_at
          ? new Date(b.expires_at).toISOString().slice(0, 19).replace("T", " ")
          : null);
    await query(
      `UPDATE admin_broadcasts SET
         message = COALESCE(?, message),
         severity = COALESCE(?, severity),
         expires_at = IF(?, ?, expires_at)
       WHERE id = ?`,
      [msg, sev,
       expiresVal !== undefined ? 1 : 0, expiresVal ?? null,
       req.params.id]
    );
    await audit(req.user.id, "admin.broadcast_edit", req, { id: req.params.id });
    return queryOne("SELECT * FROM admin_broadcasts WHERE id = ?", [req.params.id]);
  });

  app.delete("/broadcasts/:id", { config: { rateLimit: BROADCAST_LIMIT } }, async (req, reply) => {
    const r = await query(
      "UPDATE admin_broadcasts SET archived_at = NOW() WHERE id = ? AND archived_at IS NULL",
      [req.params.id]
    );
    if (!r.affectedRows) return reply.code(404).send({ error: "not found" });
    await audit(req.user.id, "admin.broadcast_archive", req, { id: req.params.id });
    return { ok: true };
  });

  // ── Plaid account type counts (D5) ────────────────────────────
  // Aggregated across every user, Plaid-linked only, split by category.
  // No user-identifying info returned — this is a pure Plaid-cost
  // planning surface. Investment accounts cost more in Plaid product
  // fees than cash/credit, so we surface them separately.
  app.get("/plaid-account-counts", { config: { rateLimit: ADMIN_LIMIT } }, async () => {
    const rows = await query(
      `SELECT type, COUNT(*) AS n FROM accounts
       WHERE plaid_item_id IS NOT NULL
       GROUP BY type`
    );
    const counts = { investment: 0, cash: 0, credit: 0, loan: 0, other: 0 };
    let total = 0;
    for (const r of rows) {
      const n = Number(r.n) || 0;
      total += n;
      if (r.type === "investment")           counts.investment += n;
      else if (r.type === "credit")          counts.credit += n;
      else if (r.type === "loan")            counts.loan += n;
      else if (r.type === "cash" || r.type === "depository")
                                             counts.cash += n;
      else                                   counts.other += n;
    }
    // Item count (an "item" is one bank connection; Plaid bills per-item
    // for most products). Useful because a single item can back many
    // accounts.
    const items = await queryOne(
      "SELECT COUNT(*) AS n FROM plaid_items"
    );
    return {
      totalAccounts: total,
      itemCount: Number(items?.n) || 0,
      counts,
    };
  });
}
