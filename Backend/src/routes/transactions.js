// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "../db.js";

// Update a manual account's balance by the given delta.
// Plaid-linked accounts are NEVER touched here — their balances come from Plaid sync.
async function adjustManualAccountBalance(userId, accountId, delta) {
  if (!accountId || !delta) return;
  const acc = await queryOne(
    "SELECT id, plaid_item_id FROM accounts WHERE id = ? AND user_id = ?",
    [accountId, userId]
  );
  if (!acc || acc.plaid_item_id) return; // not ours or Plaid-managed
  await query(
    "UPDATE accounts SET balance = balance + ? WHERE id = ?",
    [delta, accountId]
  );
}

export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (req) => {
    const { limit = 100, offset = 0, category, accountId, search, from, to } = req.query;
    const where = ["t.user_id = ?"];
    const params = [req.user.id];
    if (category)  { where.push("t.category = ?"); params.push(category); }
    if (accountId) { where.push("t.account_id = ?"); params.push(accountId); }
    if (search)    { where.push("t.merchant LIKE ?"); params.push(`%${search}%`); }
    if (from)      { where.push("t.date >= ?"); params.push(from); }
    if (to)        { where.push("t.date <= ?"); params.push(to); }

    params.push(Number(limit), Number(offset));
    return query(
      `SELECT t.id, t.date, t.merchant, t.category, t.amount, t.pending, t.note,
              a.name AS accountName, a.id AS accountId, a.plaid_item_id AS plaidItemId
       FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
       WHERE ${where.join(" AND ")} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`,
      params
    );
  });

  app.post("/", async (req, reply) => {
    const { date, merchant, category, amount, accountId, note } = req.body || {};
    if (!date || !merchant || amount === undefined) {
      return reply.code(400).send({ error: "date, merchant, amount required" });
    }
    const r = await query(
      `INSERT INTO transactions (user_id, account_id, date, merchant, category, amount, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, accountId || null, date, merchant, category || "Other", amount, note || null]
    );
    // Reflect the change in the linked manual account's balance
    // (income +, expense −). Plaid accounts are skipped.
    await adjustManualAccountBalance(req.user.id, accountId, Number(amount));
    return queryOne("SELECT * FROM transactions WHERE id = ?", [r.insertId]);
  });

  app.patch("/:id", async (req) => {
    const { merchant, category, amount, note, date } = req.body || {};
    // If amount changes on a manual account txn, adjust balance by the delta
    const existing = await queryOne(
      "SELECT account_id, amount FROM transactions WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    await query(
      `UPDATE transactions SET
         merchant = COALESCE(?, merchant),
         category = COALESCE(?, category),
         amount = COALESCE(?, amount),
         note = COALESCE(?, note),
         date = COALESCE(?, date)
       WHERE id = ? AND user_id = ?`,
      [merchant ?? null, category ?? null, amount ?? null, note ?? null, date ?? null,
       req.params.id, req.user.id]
    );
    if (existing && amount !== undefined && Number(amount) !== Number(existing.amount)) {
      const delta = Number(amount) - Number(existing.amount);
      await adjustManualAccountBalance(req.user.id, existing.account_id, delta);
    }
    return queryOne("SELECT * FROM transactions WHERE id = ?", [req.params.id]);
  });

  app.delete("/:id", async (req) => {
    // Reverse the balance impact before deleting
    const existing = await queryOne(
      "SELECT account_id, amount FROM transactions WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    await query("DELETE FROM transactions WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]);
    if (existing) {
      await adjustManualAccountBalance(req.user.id, existing.account_id, -Number(existing.amount));
    }
    return { ok: true };
  });

  app.get("/by-category", async (req) => {
    const { from, to } = req.query;
    const params = [req.user.id];
    let dateClause = "";
    if (from) { dateClause += " AND t.date >= ?"; params.push(from); }
    if (to)   { dateClause += " AND t.date <= ?"; params.push(to); }
    // Credit-account expenses excluded — consistent with category budgets and
    // the income/cashflow rollups. Credit purchases get tallied via the
    // credit-usage tracker, not category totals.
    return query(
      `SELECT t.category, SUM(ABS(t.amount)) AS total, COUNT(*) AS count
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ? AND t.amount < 0
         AND (a.type IS NULL OR a.type <> 'credit')
         ${dateClause}
       GROUP BY t.category ORDER BY total DESC`,
      params
    );
  });

  app.get("/cashflow", async (req) => {
    // Credit-card transactions are excluded so the dashboard income/spending
    // bars line up with the budget + income trackers, all of which treat
    // credit accounts as their own world (see budgets.js for the same rule).
    return query(
      `SELECT DATE_FORMAT(t.date, '%Y-%m') AS month,
              SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) AS income,
              SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END) AS spending
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ?
         AND t.date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
         AND (a.type IS NULL OR a.type <> 'credit')
       GROUP BY month ORDER BY month`,
      [req.user.id]
    );
  });

  // ── Recategorise all transactions sharing a merchant name + save rule.
  //    Feature 3 — "apply to all from same name" flow.
  //    Body: { merchant, category }. Scope is strictly the calling user.
  app.post("/recategorize-merchant", async (req, reply) => {
    const { merchant, category } = req.body || {};
    if (!merchant || !category) {
      return reply.code(400).send({ error: "merchant and category required" });
    }
    // Save rule (per-user)
    await query(
      `INSERT INTO merchant_rules (user_id, merchant, category)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE category = VALUES(category)`,
      [req.user.id, merchant, category]
    );
    // Apply retroactively to all matching transactions for THIS user only
    const r = await query(
      `UPDATE transactions SET category = ?
       WHERE user_id = ? AND merchant = ?`,
      [category, req.user.id, merchant]
    );
    return { ok: true, updated: r.affectedRows || 0 };
  });

  // ── Manage merchant rules ──────────────────────────────────────
  app.get("/merchant-rules", async (req) => {
    return query(
      `SELECT id, merchant, category, created_at AS createdAt
       FROM merchant_rules WHERE user_id = ? ORDER BY merchant`,
      [req.user.id]
    );
  });

  app.delete("/merchant-rules/:id", async (req) => {
    await query("DELETE FROM merchant_rules WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]);
    return { ok: true };
  });
}
