// SPDX-License-Identifier: AGPL-3.0-or-later
import { query } from "./db.js";
import geoip from "geoip-lite";

/**
 * Best-effort offline GeoIP lookup for an IPv4/IPv6 address. Returns a
 * short human-readable string like "Atlanta, US" or null. The MaxMind
 * GeoLite2 dataset bundled with geoip-lite ships with the package; no
 * network call is made.
 */
export function geoFromIp(ip) {
  if (!ip) return null;
  // Trim IPv6-mapped IPv4 (::ffff:1.2.3.4 → 1.2.3.4)
  const clean = String(ip).replace(/^::ffff:/, "");
  try {
    const g = geoip.lookup(clean);
    if (!g) return null;
    const parts = [g.city, g.region, g.country].filter(Boolean);
    return parts.join(", ") || null;
  } catch { return null; }
}

/**
 * Write an entry to the audit log. Best-effort — never throws.
 *
 * @param {number|null} userId
 * @param {string}      action     short event key, e.g. "auth.success"
 * @param {object}      req        Fastify request (for ip/user-agent)
 * @param {object}      [meta]     extra context, will be JSON-stringified
 * @param {object}      [opts]
 * @param {boolean}     [opts.major]  When true, the row is marked is_major=1
 *                                    so the cleanup worker retains it for
 *                                    7 days (instead of 48 h) and the admin
 *                                    UI flags it in red. Use for any high-
 *                                    impact admin action (role changes,
 *                                    user deletes, bulk data wipes).
 */
export async function audit(userId, action, req, meta = null, opts = {}) {
  try {
    const ip = req?.ip || null;
    const ua = req?.headers?.["user-agent"]?.slice(0, 255) || null;
    const metaJson = meta ? JSON.stringify(meta).slice(0, 4000) : null;
    const major = opts?.major ? 1 : 0;
    await query(
      `INSERT INTO audit_log (user_id, action, ip, user_agent, metadata, is_major)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, action.slice(0, 64), ip, ua, metaJson, major]
    );
  } catch (e) {
    // Audit must never break a request. Just log and move on.
    req?.log?.warn?.({ err: e.message }, "audit write failed");
  }
}
