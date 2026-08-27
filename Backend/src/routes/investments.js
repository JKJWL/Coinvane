// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "../db.js";
import { makeWriteGuard } from "../joint.js";

export default async function (app) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", makeWriteGuard("investment"));

  // Holdings list, with per-row resolved basis + gain so the frontend
  // doesn't need to reproduce the per-share-vs-total heuristic. When
  // Plaid didn't report a cost_basis for a security we look for manual
  // lots on the same security_id and fall back to their weighted basis;
  // if neither exists, `resolvedBasis` is null and `gain` is 0 with
  // `basisKnown = false` so the UI can render "—" instead of a
  // misleading number.
  app.get("/holdings", async (req) => {
    const rows = await query(
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
      [req.contextUserId]
    );
    if (!rows.length) return rows;
    const lotAgg = await query(
      `SELECT security_id,
              SUM(remaining_quantity * cost_basis_per_share) AS lotBasisTotal
       FROM holding_lots
       WHERE user_id = ? AND remaining_quantity > 0
       GROUP BY security_id`,
      [req.contextUserId]
    );
    const lotBasisMap = new Map(lotAgg.map((r) => [r.security_id, Number(r.lotBasisTotal)]));
    for (const r of rows) {
      const value = Number(r.value) || 0;
      const cb = r.costBasis == null ? null : Number(r.costBasis);
      const q  = Number(r.quantity) || 0;
      let basisTotal = null;
      if (cb != null && cb > 0) {
        if (q <= 1) {
          basisTotal = cb;
        } else {
          const asPerShare = cb * q;
          const asTotal    = cb;
          if (value > 0) {
            const distPer = Math.abs(asPerShare - value);
            const distTot = Math.abs(asTotal    - value);
            basisTotal = distTot < distPer ? asTotal : asPerShare;
          } else {
            basisTotal = asPerShare;
          }
        }
      } else if (lotBasisMap.has(r.securityId)) {
        basisTotal = lotBasisMap.get(r.securityId);
      }
      r.resolvedBasis = basisTotal == null ? null : Number(basisTotal.toFixed(2));
      r.gain          = basisTotal == null ? 0    : Number((value - basisTotal).toFixed(2));
      r.basisKnown    = basisTotal != null;
    }
    return rows;
  });

  // Portfolio summary. Historically this used
  //   SUM(institution_value - (cost_basis * quantity))
  // straight off `holdings`, which mis-reported gain in three ways:
  //
  //   1. NULL cost_basis (very common on individual stocks — many brokerages
  //      just don't report it through Plaid) made the whole subtraction NULL,
  //      so the value counted in `total` but the position was silently
  //      dropped from `gain`. Net effect: ratio looks like a phantom gain.
  //   2. Plaid's cost_basis semantics are inconsistent. Docs say "per share"
  //      but Fidelity + a couple others return TOTAL cost basis. Multiplying
  //      a total by quantity yields a wildly wrong loss.
  //   3. Manual lots the user added via /lots/:securityId live in
  //      `holding_lots`, not `holdings`. The summary ignored them entirely,
  //      so a pure-manual portfolio showed $0 total, $0 gain.
  //
  // We now build the summary in JS: normalize Plaid cost_basis (per-share
  // vs total heuristic), fall back to open-lot basis when Plaid didn't
  // report one, and union in securities that only exist as manual lots.
  app.get("/summary", async (req) => {
    const holdings = await query(
      `SELECT h.security_id, h.quantity, h.cost_basis, h.institution_value
       FROM holdings h WHERE h.user_id = ?`, [req.contextUserId]
    );
    const lotAgg = await query(
      `SELECT security_id,
              SUM(remaining_quantity) AS remainingQty,
              SUM(remaining_quantity * cost_basis_per_share) AS lotBasisTotal
       FROM holding_lots
       WHERE user_id = ? AND remaining_quantity > 0
       GROUP BY security_id`,
      [req.contextUserId]
    );
    const lotBasisMap = new Map(lotAgg.map((r) => [r.security_id, r]));

    const secIds = new Set([
      ...holdings.map((h) => h.security_id),
      ...lotAgg.map((l) => l.security_id),
    ]);
    let secMap = new Map();
    if (secIds.size) {
      const secs = await query(
        `SELECT id, close_price, type FROM securities WHERE id IN (?)`,
        [Array.from(secIds)]
      );
      secMap = new Map(secs.map((s) => [s.id, s]));
    }

    const seen = new Set();
    let total = 0, gain = 0, gainKnown = 0;
    const byTypeMap = new Map();

    // Heuristic: is Plaid's cost_basis a per-share average or a total for
    // the position? For qty > 1 we can tell by which value lines up closer
    // to institution_value. For qty <= 1 the two are identical, so we just
    // use it as total.
    function resolveBasisTotal(costBasis, qty, instValue) {
      if (costBasis == null) return null;
      const cb = Number(costBasis);
      if (!(cb > 0)) return null;
      const q = Number(qty) || 0;
      if (q <= 1) return cb;
      const asPerShare = cb * q;
      const asTotal    = cb;
      // Whichever guess sits closer to institution_value wins. For
      // positions where value is unknown/zero, default to per-share
      // (Plaid's documented behaviour).
      if (!(Number(instValue) > 0)) return asPerShare;
      const distPer = Math.abs(asPerShare - Number(instValue));
      const distTot = Math.abs(asTotal    - Number(instValue));
      return distTot < distPer ? asTotal : asPerShare;
    }

    for (const h of holdings) {
      seen.add(h.security_id);
      const value = Number(h.institution_value) || 0;
      let basisTotal = resolveBasisTotal(h.cost_basis, h.quantity, value);
      if (basisTotal == null) {
        // Fall back to manual lots for this security if the user tracked
        // any purchases themselves.
        const lot = lotBasisMap.get(h.security_id);
        if (lot) basisTotal = Number(lot.lotBasisTotal) || null;
      }
      total += value;
      if (basisTotal != null) {
        gain += value - basisTotal;
        gainKnown += value;
      }
      const sec = secMap.get(h.security_id);
      if (sec) byTypeMap.set(sec.type, (byTypeMap.get(sec.type) || 0) + value);
    }

    // Union in securities that have manual lots but no Plaid holding
    // (e.g. self-hosted vehicles, treasuries entered by hand).
    for (const l of lotAgg) {
      if (seen.has(l.security_id)) continue;
      const sec = secMap.get(l.security_id);
      const price = Number(sec?.close_price || 0);
      const remaining = Number(l.remainingQty) || 0;
      const basis = Number(l.lotBasisTotal) || 0;
      const value = price > 0 ? price * remaining : basis;
      total += value;
      if (price > 0) {
        gain += value - basis;
        gainKnown += value;
      }
      if (sec) byTypeMap.set(sec.type, (byTypeMap.get(sec.type) || 0) + value);
    }

    const yearStart = `${new Date().getFullYear()}-01-01`;
    const realized = await queryOne(
      `SELECT COALESCE(SUM(realized_gain), 0) AS realized,
              COALESCE(SUM(CASE WHEN is_wash_sale = 1 THEN realized_gain ELSE 0 END), 0) AS washSale,
              COALESCE(SUM(disallowed_loss), 0) AS disallowed
       FROM lot_disposals WHERE user_id = ? AND disposal_date >= ?`,
      [req.contextUserId, yearStart]
    );

    const byType = Array.from(byTypeMap.entries())
      .map(([type, value]) => ({ type, value: Number(value.toFixed(2)) }))
      .sort((a, b) => b.value - a.value);

    return {
      total:         Number(total.toFixed(2)),
      gain:          Number(gain.toFixed(2)),
      // Fraction of the portfolio's value that has a known basis. UI can
      // show "gain is based on 87% of your portfolio" when this is < 1.
      gainCoverage:  total > 0 ? Number((gainKnown / total).toFixed(3)) : 1,
      realizedYTD:   Number(realized.realized || 0),
      washSaleYTD:   Number(realized.washSale || 0),
      disallowedYTD: Number(realized.disallowed || 0),
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
      [req.contextUserId, secId]
    );
    const disposals = await query(
      `SELECT id, lot_id AS lotId, disposal_date AS disposalDate,
              quantity, price_per_share AS pricePerShare,
              realized_gain AS realizedGain, is_wash_sale AS washSale,
              disallowed_loss AS disallowedLoss, notes
       FROM lot_disposals WHERE user_id = ? AND security_id = ?
       ORDER BY disposal_date DESC, id DESC`,
      [req.contextUserId, secId]
    );
    const price = Number(sec.close_price || 0);
    for (const l of lots) {
      const basis = Number(l.costBasisPerShare) || 0;
      // If we have no price, show 0 rather than a phantom "loss" equal to
      // the whole basis. Same when basis isn't set. UI can render "—".
      l.unrealizedGain = price > 0 && basis > 0
        ? Number(((price - basis) * Number(l.remainingQuantity)).toFixed(4))
        : 0;
      l.unrealizedKnown = price > 0 && basis > 0;
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
      [req.contextUserId, secId, account_id || null, acquired_date, q, q,
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
        [req.contextUserId]
      );
      await query(
        `INSERT INTO transactions
           (user_id, account_id, date, merchant, category, amount, note)
         VALUES (?, ?, ?, ?, 'Interest & Dividends', ?, ?)`,
        [req.contextUserId, account_id, acquired_date,
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
      [lotId, req.contextUserId]
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
       lotId, req.contextUserId]
    );
    return queryOne("SELECT * FROM holding_lots WHERE id = ?", [lotId]);
  });

  app.delete("/lots/:lotId", async (req, reply) => {
    const r = await query(
      "DELETE FROM holding_lots WHERE id = ? AND user_id = ?",
      [req.params.lotId, req.contextUserId]
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
      [lotId, req.contextUserId]
    );
    if (!lot) return reply.code(404).send({ error: "lot not found" });
    if (q > Number(lot.remaining_quantity) + 1e-8) {
      return reply.code(400).send({ error: `only ${lot.remaining_quantity} shares remain in that lot` });
    }
    const realizedGain = (px - Number(lot.cost_basis_per_share)) * q;
    // Wash-sale check: only relevant when the disposal is a loss. IRS rule:
    // a purchase of the SAME security in the ±30 day window disallows the
    // loss proportionally to matched shares. Selling 100 at a loss and
    // buying back 60 within 30 days disallows 60% of the loss, not all of
    // it. We sum matched purchase quantity across both the ±30 day
    // holding_lots (which includes reinvested dividends and manual buys)
    // and the LOT that this disposal references (we exclude it since a
    // sale from a lot doesn't taint itself).
    let washSale = 0;
    let disallowed = 0;
    if (realizedGain < 0) {
      const matches = await queryOne(
        `SELECT COALESCE(SUM(original_quantity), 0) AS matched
         FROM holding_lots
         WHERE user_id = ? AND security_id = ? AND id <> ?
           AND acquired_date BETWEEN DATE_SUB(?, INTERVAL 30 DAY)
                                 AND DATE_ADD(?, INTERVAL 30 DAY)`,
        [req.contextUserId, lot.security_id, lotId, disposal_date, disposal_date]
      );
      const matched = Number(matches?.matched || 0);
      if (matched > 0) {
        washSale = 1;
        const ratio = Math.min(matched / q, 1);
        disallowed = Math.abs(realizedGain) * ratio;
      }
    }
    const r = await query(
      `INSERT INTO lot_disposals
         (user_id, lot_id, security_id, disposal_date, quantity, price_per_share,
          realized_gain, is_wash_sale, disallowed_loss, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.contextUserId, lotId, lot.security_id, disposal_date, q, px,
       Number(realizedGain.toFixed(4)), washSale, Number(disallowed.toFixed(4)),
       notes ? String(notes).slice(0, 255) : null]
    );
    await query(
      "UPDATE holding_lots SET remaining_quantity = remaining_quantity - ? WHERE id = ?",
      [q, lotId]
    );
    return {
      id: r.insertId,
      realizedGain:   Number(realizedGain.toFixed(4)),
      isWashSale:     !!washSale,
      disallowedLoss: Number(disallowed.toFixed(4)),
    };
  });

  app.delete("/disposals/:id", async (req, reply) => {
    const d = await queryOne(
      "SELECT id, lot_id, quantity FROM lot_disposals WHERE id = ? AND user_id = ?",
      [req.params.id, req.contextUserId]
    );
    if (!d) return reply.code(404).send({ error: "not found" });
    await query(
      "UPDATE holding_lots SET remaining_quantity = remaining_quantity + ? WHERE id = ?",
      [d.quantity, d.lot_id]
    );
    await query("DELETE FROM lot_disposals WHERE id = ? AND user_id = ?",
      [req.params.id, req.contextUserId]);
    return { ok: true };
  });
}