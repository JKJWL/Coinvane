// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "../db.js";

/**
 * Custom report builder — pivot-style aggregations over transactions.
 *
 * POST /query
 *   body: {
 *     dimensions: ["category" | "merchant" | "account" | "month" | "year"],
 *     measure:    "sum" | "count" | "avg",
 *     side:       "all" | "expense" | "income",
 *     from:       "YYYY-MM-DD" (optional)
 *     to:         "YYYY-MM-DD" (optional)
 *     credit:     "include" | "exclude" (default exclude — matches budgets)
 *   }
 *   returns: { rows: [{ dim1, dim2?, value }], total }
 *
 * The dimensions list gets the SAME kind of GROUP BY the rest of the app
 * uses — one or two dimensions at most (any more is a table, not a
 * report). Everything else is a filter or measure toggle.
 *
 * Saved reports (GET / POST / DELETE) let users bookmark a builder
 * configuration for one-click reruns.
 */

const DIM_EXPR = {
  category: "t.category",
  merchant: "t.merchant",
  account:  "COALESCE(a.name, '(no account)')",
  month:    "DATE_FORMAT(t.date, '%Y-%m')",
  year:     "DATE_FORMAT(t.date, '%Y')",
};
const ALLOWED_DIMS = new Set(Object.keys(DIM_EXPR));
const ALLOWED_MEASURES = new Set(["sum", "count", "avg"]);
const ALLOWED_SIDES = new Set(["all", "expense", "income"]);

function buildQuery(userId, body) {
  const dims = (Array.isArray(body?.dimensions) ? body.dimensions : [])
    .filter(d => ALLOWED_DIMS.has(d))
    .slice(0, 2);
  if (dims.length === 0) dims.push("category");
  const measure = ALLOWED_MEASURES.has(body?.measure) ? body.measure : "sum";
  const side = ALLOWED_SIDES.has(body?.side) ? body.side : "expense";
  const credit = body?.credit === "include" ? "include" : "exclude";

  const params = [userId];
  const where = ["t.user_id = ?"];
  if (side === "expense") where.push("t.amount < 0");
  else if (side === "income") where.push("t.amount > 0");
  where.push("(t.is_transfer = 0 OR t.is_transfer IS NULL)");
  where.push("(t.is_scheduled = 0 OR t.is_scheduled IS NULL)");
  if (credit === "exclude") where.push("(a.type IS NULL OR a.type <> 'credit')");
  if (body?.from) { where.push("t.date >= ?"); params.push(body.from); }
  if (body?.to)   { where.push("t.date <= ?"); params.push(body.to); }

  const groupCols = dims.map(d => DIM_EXPR[d]);
  const selectCols = dims.map((d, i) => `${DIM_EXPR[d]} AS dim${i + 1}`);
  const valueExpr = measure === "sum"
    ? "COALESCE(SUM(ABS(t.amount)), 0)"
    : measure === "count"
    ? "COUNT(*)"
    : "COALESCE(AVG(ABS(t.amount)), 0)";
  const sql = `
    SELECT ${selectCols.join(", ")}, ${valueExpr} AS value
    FROM transactions t
    LEFT JOIN accounts a ON a.id = t.account_id
    WHERE ${where.join(" AND ")}
    GROUP BY ${groupCols.join(", ")}
    ORDER BY value DESC
    LIMIT 500
  `;
  return { sql, params, dims, measure, side };
}

export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  app.post("/query", async (req, reply) => {
    try {
      const { sql, params, dims, measure } = buildQuery(req.user.id, req.body || {});
      const rows = await query(sql, params);
      const total = rows.reduce((s, r) => s + Number(r.value || 0), 0);
      return {
        dims, measure,
        rows: rows.map(r => ({
          dim1: String(r.dim1 || ""),
          dim2: dims.length > 1 ? String(r.dim2 || "") : undefined,
          value: Number(r.value || 0),
        })),
        total: Number(total.toFixed(2)),
      };
    } catch (e) {
      req.log.error({ err: e }, "report query failed");
      return reply.code(400).send({ error: "invalid report config" });
    }
  });

  // ── Saved reports ─────────────────────────────────────────────────
  app.get("/saved", async (req) => {
    return query(
      `SELECT id, name, config, created_at AS createdAt
       FROM saved_reports WHERE user_id = ? ORDER BY name`,
      [req.user.id]
    ).then(rows => rows.map(r => ({
      ...r,
      config: safeParse(r.config),
    })));
  });

  app.post("/saved", async (req, reply) => {
    const { name, config } = req.body || {};
    if (!name || !config) return reply.code(400).send({ error: "name + config required" });
    const r = await query(
      `INSERT INTO saved_reports (user_id, name, config) VALUES (?, ?, ?)`,
      [req.user.id, String(name).slice(0, 128), JSON.stringify(config)]
    );
    return { id: r.insertId };
  });

  app.delete("/saved/:id", async (req, reply) => {
    const r = await query(
      "DELETE FROM saved_reports WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    if (!r.affectedRows) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
