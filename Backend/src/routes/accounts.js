// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "../db.js";

export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (req) => {
    return query(
      `SELECT id, name, type, subtype, balance, limit_amount AS limitAmount,
              institution, last_sync_at AS lastSyncAt, plaid_item_id AS plaidItemId
       FROM accounts WHERE user_id = ? ORDER BY type, name`,
      [req.user.id]
    );
  });

  app.post("/", async (req, reply) => {
    const { name, type, subtype, balance, institution } = req.body || {};
    if (!name || !type) return reply.code(400).send({ error: "name and type required" });
    const r = await query(
      `INSERT INTO accounts (user_id, name, type, subtype, balance, institution)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.user.id, name, type, subtype || null, balance || 0, institution || null]
    );
    return queryOne("SELECT * FROM accounts WHERE id = ?", [r.insertId]);
  });

  app.patch("/:id", async (req, reply) => {
    const { name, balance } = req.body || {};
    await query(
      `UPDATE accounts SET name = COALESCE(?, name), balance = COALESCE(?, balance)
       WHERE id = ? AND user_id = ?`,
      [name ?? null, balance ?? null, req.params.id, req.user.id]
    );
    return queryOne("SELECT * FROM accounts WHERE id = ?", [req.params.id]);
  });

  app.delete("/:id", async (req, reply) => {
    // Look up the target first so we can return a meaningful error instead
    // of a silent no-op. Plaid-linked accounts must be removed via
    // /api/plaid/items/:id (which handles token revoke + cascade cleanup),
    // not from here.
    const acct = await queryOne(
      "SELECT id, plaid_item_id FROM accounts WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    if (!acct) return reply.code(404).send({ error: "account not found" });
    if (acct.plaid_item_id) {
      return reply.code(409).send({
        error: "this is a Plaid-linked account; disconnect it from the Plaid items endpoint",
      });
    }
    // Clean up transactions tied to this account FIRST. The schema's FK is
    // ON DELETE SET NULL so without this the transactions would persist as
    // orphans and skew budget / income calculations.
    await query(
      "DELETE FROM transactions WHERE user_id = ? AND account_id = ?",
      [req.user.id, req.params.id]
    );
    await query(
      "DELETE FROM accounts WHERE id = ? AND user_id = ? AND plaid_item_id IS NULL",
      [req.params.id, req.user.id]
    );
    return { ok: true };
  });

  app.get("/summary", async (req) => {
    const rows = await query(
      `SELECT type, SUM(balance) AS total FROM accounts WHERE user_id = ? GROUP BY type`,
      [req.user.id]
    );
    const summary = { cash: 0, credit: 0, investment: 0, loan: 0, other: 0, assets: 0 };
    for (const r of rows) summary[r.type] = Number(r.total) || 0;
    // Assets (vehicles, valuables, etc.) roll into net worth too.
    const assetSum = await queryOne(
      "SELECT COALESCE(SUM(current_value), 0) AS total FROM assets WHERE user_id = ? AND archived_at IS NULL",
      [req.user.id]
    );
    summary.assets = Number(assetSum?.total || 0);
    summary.netWorth = summary.cash + summary.investment + summary.credit + summary.loan + summary.assets;
    return summary;
  });

  /**
   * Net worth history (?range=wtd|mtd|ytd|1m|3m|1y|all)
   *
   * Reconstructs historical net worth from current balances by walking
   * transactions backward. For each day in the range:
   *   net_worth(day) = current_net_worth - sum(transactions after that day)
   *
   * Approximation: assumes the *current* account balances are correct and
   * that transactions are the only thing changing them. For Plaid-linked
   * accounts this is a close approximation; for manual accounts it's exact
   * (since manual transactions adjust the balance directly).
   */
  app.get("/networth-history", async (req) => {
    const range = String(req.query.range || "mtd").toLowerCase();
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    let start;
    if (range === "wtd") {
      start = new Date(now);
      start.setDate(now.getDate() - now.getDay()); // last Sunday
    } else if (range === "mtd") {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
    } else if (range === "ytd") {
      start = new Date(now.getFullYear(), 0, 1);
    } else if (range === "1m") {
      start = new Date(now); start.setMonth(now.getMonth() - 1);
    } else if (range === "3m") {
      start = new Date(now); start.setMonth(now.getMonth() - 3);
    } else if (range === "1y") {
      start = new Date(now); start.setFullYear(now.getFullYear() - 1);
    } else if (range === "all") {
      const oldest = await queryOne(
        "SELECT MIN(date) AS d FROM transactions WHERE user_id = ?", [req.user.id]
      );
      start = oldest?.d ? new Date(oldest.d) : new Date(now.getFullYear(), 0, 1);
    } else {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    const sum = await queryOne(
      "SELECT COALESCE(SUM(balance), 0) AS net FROM accounts WHERE user_id = ?",
      [req.user.id]
    );
    // Assets (vehicles, valuables, property) contribute to net worth too.
    // We don't have historical valuation snapshots, so treat the current
    // asset total as a flat baseline added to every point in the series.
    // Better than excluding them entirely — and depreciating assets are
    // refreshed via /assets/refresh, so the "current" number tracks reality.
    const assetSum = await queryOne(
      "SELECT COALESCE(SUM(current_value), 0) AS total FROM assets WHERE user_id = ? AND archived_at IS NULL",
      [req.user.id]
    );
    const accountsNet = Number(sum?.net) || 0;
    const assetsNet = Number(assetSum?.total) || 0;
    const currentNet = accountsNet + assetsNet;

    // Pull all transactions in the window; we walk forward from start.
    const startStr = start.toISOString().slice(0, 10);
    const txns = await query(
      `SELECT date, SUM(amount) AS delta
       FROM transactions
       WHERE user_id = ? AND date >= ?
       GROUP BY date ORDER BY date ASC`,
      [req.user.id, startStr]
    );

    // Build a date -> delta map
    const deltaByDate = new Map();
    for (const t of txns) deltaByDate.set(String(t.date), Number(t.delta) || 0);

    // Total delta from start..today
    const totalDelta = Array.from(deltaByDate.values()).reduce((a, b) => a + b, 0);
    let runningNet = currentNet - totalDelta; // net worth at start

    const points = [];
    const cursor = new Date(start);
    while (cursor <= now) {
      const k = cursor.toISOString().slice(0, 10);
      runningNet += deltaByDate.get(k) || 0;
      points.push({ date: k, net: Number(runningNet.toFixed(2)) });
      cursor.setDate(cursor.getDate() + 1);
    }

    return { range, start: startStr, points, current: currentNet };
  });
}