import { query } from "./db.js";

/**
 * Write an entry to the audit log. Best-effort — never throws.
 *
 * @param {number|null} userId
 * @param {string}      action     short event key, e.g. "auth.success"
 * @param {object}      req        Fastify request (for ip/user-agent)
 * @param {object}      [meta]     extra context, will be JSON-stringified
 */
export async function audit(userId, action, req, meta = null) {
  try {
    const ip = req?.ip || null;
    const ua = req?.headers?.["user-agent"]?.slice(0, 255) || null;
    const metaJson = meta ? JSON.stringify(meta).slice(0, 4000) : null;
    await query(
      `INSERT INTO audit_log (user_id, action, ip, user_agent, metadata)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, action.slice(0, 64), ip, ua, metaJson]
    );
  } catch (e) {
    // Audit must never break a request. Just log and move on.
    req?.log?.warn?.({ err: e.message }, "audit write failed");
  }
}
