// SPDX-License-Identifier: AGPL-3.0-or-later
import { query } from "../db.js";

export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  app.get("/holdings", async (req) => {
    return query(
      `SELECT h.id, h.quantity, h.cost_basis AS costBasis,
              h.institution_value AS value, h.institution_price AS price,
              s.name AS securityName, s.ticker_symbol AS ticker, s.type AS securityType,
              s.close_price AS closePrice,
              a.name AS accountName, a.id AS accountId
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       JOIN accounts a ON a.id = h.account_id
       WHERE h.user_id = ?
       ORDER BY h.institution_value DESC`,
      [req.user.id]
    );
  });

  app.get("/summary", async (req) => {
    const rows = await query(
      `SELECT COALESCE(SUM(institution_value), 0) AS total,
              COALESCE(SUM(institution_value - (cost_basis * quantity)), 0) AS gain
       FROM holdings WHERE user_id = ?`, [req.user.id]
    );
    const totals = rows[0] || { total: 0, gain: 0 };
    const byType = await query(
      `SELECT s.type AS type, SUM(h.institution_value) AS value
       FROM holdings h JOIN securities s ON s.id = h.security_id
       WHERE h.user_id = ? GROUP BY s.type ORDER BY value DESC`, [req.user.id]
    );
    return { total: Number(totals.total), gain: Number(totals.gain), byType };
  });
}