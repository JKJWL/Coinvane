// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "../db.js";

export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  app.get("/holdings", async (req) => {
    return query(
      `SELECT h.id, h.quantity, h.cost_basis AS costBasis,
              h.institution_value AS value, h.institution_price AS price,
              s.id AS securityId, s.name AS securityName, s.ticker_symbol AS ticker, s.type AS securityType,
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
    // Realized gain YTD from lot disposals — useful for Schedule D prep.
    const yearStart = `${new Date().getFullYear()}-01-01`;
    const realized = await queryOne(
      `SELECT COALESCE(SUM(realized_gain), 0) AS realized,
              COALESCE(SUM(CASE WHEN is_wash_sale = 1 THEN realized_gain ELSE 0 END), 0) AS washSale
       FROM lot_disposals WHERE user_id = ? AND disposal_date >= ?`,
      [req.user.id, yearStart]
    );
    return {
      total: Number(totals.total),
      gain: Number(totals.gain),
      realizedYTD: Number(realized.realized || 0),
      washSaleYTD: Number(realized.washSale || 0),
      byType,
    };
  });

  // ── Lots per security ─────────────────────────────────────────────
  //
  // Returns each open + closed lot for a given security along with the
  // disposals it has recorded. The "unrealized" gain per lot is computed
  // from the security's latest close_price × remaining quantity vs cost.
  app.get("/lots/:securityId", async (req, reply) => {
    const secId = Number(req.params.securityId);
    if (!secId) return reply.code(400).send({ error: "bad securityId" });
    const sec = await queryOne(
      "SELECT id, name, ticker_symbol, close_price FROM securities WHERE id = ?",
      [secId]
    );
    if (!sec) return reply.code(404).send({ error: "security not found" });

    const lots = await query(
      `SELECT l.id, l.acquired_date AS acquiredDate, l.original_quantity AS originalQuantity,
              l.remaining_quantity AS remainingQuantity, l.cost_basis_per_share AS costBasisPerShare,
              l.method, l.notes, l.account_id AS accountId, a.name AS accountName
       FROM holding_lots l
       LEFT JOIN accounts a ON a.id = l.account_id
       WHERE l.user_id = ? AND l.security_id = ?
       ORDER BY l.acquired_date ASC, l.id ASC`,
      [req.user.id, secId]
    );
    const disposals = await query(
      `SELECT id, lot_id AS lotId, disposal_date AS disposalDate,
              quantity, price_per_share AS pricePerShare,
              realized_gain AS realizedGain, is_wash_sale AS washSale, notes
       FROM lot_disposals WHERE user_id = ? AND security_id = ?
       ORDER BY disposal_date DESC, id DESC`,
      [req.user.id, secId]
    );
    const price = Number(sec.close_price || 0);
    for (const l of lots) {
      l.unrealizedGain = (price - Number(l.costBasisPerShare)) * Number(l.remainingQuantity);
    }
    return {
      security: { id: sec.id, name: sec.name, ticker: sec.ticker_symbol, price },
      lots,
      disposals,
    };
  });

  // Create a new purchase lot.
  //
  // If `reinvest: true` is set, the request represents a reinvested
  // dividend / cap gain distribution: we ALSO insert a matching
  // "Interest & Dividends" income transaction on the linked account so
  // the money shows up on the tax rollup. The paired rows share nothing
  // structurally (the ledger doesn't need to know they came from one
  // event) but Coinvane guarantees they're inserted together.
  app.post("/lots/:securityId", async (req, reply) => {
    const secId = Number(req.params.securityId);
    const { acquired_date, quantity, cost_basis_per_share, method, notes, account_id, reinvest } = req.body || {};
    if (!acquired_date || !(Number(quantity) > 0) || !(Number(cost_basis_per_share) >= 0)) {
      return reply.code(400).send({ error: "acquired_date, quantity > 0, cost_basis_per_share required" });
    }
    const sec = await queryOne("SELECT ticker, name FROM securities WHERE id = ?", [secId]);
    if (!sec) return reply.code(404).send({ error: "security not found" });
    const chosenMethod = ["fifo", "lifo", "specific"].includes(method) ? method : "specific";
    const q = Number(quantity);
    const price = Number(cost_basis_per_share);
    const r = await query(
      `INSERT INTO holding_lots
         (user_id, security_id, account_id, acquired_date, original_quantity,
          remaining_quantity, cost_basis_per_share, method, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, secId, account_id || null, acquired_date, q, q,
       price, chosenMethod,
       notes ? String(notes).slice(0, 255) : null]
    );
    // Reinvest → also record a paired dividend income transaction so
    // the money shows on cashflow and Schedule B. Ensure the Interest
    // & Dividends category row exists (with Schedule B tagging) as we
    // do in sync.js.
    if (reinvest && account_id) {
      const amt = q * price;
      await query(
        `INSERT IGNORE INTO categories (user_id, name, color, icon, custom, tax_schedule)
         VALUES (?, 'Interest & Dividends', '#10b981', 'TrendingUp', TRUE, 'B')`,
        [req.user.id]
      );
      await query(
        `INSERT INTO transactions
           (user_id, account_id, date, merchant, category, amount, note)
         VALUES (?, ?, ?, ?, 'Interest & Dividends', ?, ?)`,
        [req.user.id, account_id, acquired_date,
         `Reinvested dividend · ${sec.ticker || sec.name || "security"}`,
         amt,
         `Auto-linked to lot #${r.insertId}`]
      );
    }
    return queryOne("SELECT * FROM holding_lots WHERE id = ?", [r.insertId]);
  });

  app.patch("/lots/:lotId", async (req, reply) => {
    const lotId = Number(req.params.lotId);
    const owned = await queryOne(
      "SELECT id FROM holding_lots WHERE id = ? AND user_id = ?",
      [lotId, req.user.id]
    );
    if (!owned) return reply.code(404).send({ error: "not found" });
    const b = req.body || {};
    await query(
      `UPDATE holding_lots SET
         acquired_date = COALESCE(?, acquired_date),
         cost_basis_per_share = COALESCE(?, cost_basis_per_share),
         notes = COALESCE(?, notes),
         account_id = COALESCE(?, account_id)
       WHERE id = ? AND user_id = ?`,
      [b.acquired_date ?? null,
       b.cost_basis_per_share !== undefined ? Number(b.cost_basis_per_share) : null,
       b.notes ?? null,
       b.account_id ?? null,
       lotId, req.user.id]
    );
    return queryOne("SELECT * FROM holding_lots WHERE id = ?", [lotId]);
  });

  app.delete("/lots/:lotId", async (req, reply) => {
    const r = await query(
      "DELETE FROM holding_lots WHERE id = ? AND user_id = ?",
      [req.params.lotId, req.user.id]
    );
    if (!r.affectedRows) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });

  // Record a disposal (sale) against a specific lot. Amount of shares
  // must not exceed the lot's remaining_quantity. Wash-sale flag is
  // computed at insert: any other purchase of the same security within
  // ±30 days of disposal_date at a LOSS taints the disposal.
  app.post("/disposals", async (req, reply) => {
    const { lot_id, disposal_date, quantity, price_per_share, notes } = req.body || {};
    const lotId = Number(lot_id);
    const q = Number(quantity);
    const px = Number(price_per_share);
    if (!lotId || !disposal_date || !(q > 0) || !(px >= 0)) {
      return reply.code(400).send({ error: "lot_id, disposal_date, quantity > 0, price_per_share required" });
    }
    const lot = await queryOne(
      "SELECT id, security_id, remaining_quantity, cost_basis_per_share FROM holding_lots WHERE id = ? AND user_id = ?",
      [lotId, req.user.id]
    );
    if (!lot) return reply.code(404).send({ error: "lot not found" });
    if (q > Number(lot.remaining_quantity) + 1e-8) {
      return reply.code(400).send({ error: `only ${lot.remaining_quantity} shares remain in that lot` });
    }
    const realizedGain = (px - Number(lot.cost_basis_per_share)) * q;
    // Wash-sale check: only relevant when realized gain is a loss.
    let washSale = 0;
    if (realizedGain < 0) {
      const wash = await queryOne(
        `SELECT COUNT(*) AS c FROM holding_lots
         WHERE user_id = ? AND security_id = ? AND id <> ?
           AND acquired_date BETWEEN DATE_SUB(?, INTERVAL 30 DAY) AND DATE_ADD(?, INTERVAL 30 DAY)`,
        [req.user.id, lot.security_id, lotId, disposal_date, disposal_date]
      );
      washSale = Number(wash?.c || 0) > 0 ? 1 : 0;
    }
    const r = await query(
      `INSERT INTO lot_disposals
         (user_id, lot_id, security_id, disposal_date, quantity, price_per_share,
          realized_gain, is_wash_sale, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, lotId, lot.security_id, disposal_date, q, px,
       Number(realizedGain.toFixed(4)), washSale,
       notes ? String(notes).slice(0, 255) : null]
    );
    await query(
      "UPDATE holding_lots SET remaining_quantity = remaining_quantity - ? WHERE id = ?",
      [q, lotId]
    );
    return {
      id: r.insertId,
      realizedGain: Number(realizedGain.toFixed(4)),
      isWashSale: !!washSale,
    };
  });

  app.delete("/disposals/:id", async (req, reply) => {
    const d = await queryOne(
      "SELECT id, lot_id, quantity FROM lot_disposals WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    if (!d) return reply.code(404).send({ error: "not found" });
    await query(
      "UPDATE holding_lots SET remaining_quantity = remaining_quantity + ? WHERE id = ?",
      [d.quantity, d.lot_id]
    );
    await query("DELETE FROM lot_disposals WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]);
    return { ok: true };
  });
}