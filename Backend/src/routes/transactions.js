import { query, queryOne } from "../db.js";

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
              a.name AS accountName, a.id AS accountId
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
    return queryOne("SELECT * FROM transactions WHERE id = ?", [r.insertId]);
  });

  app.patch("/:id", async (req) => {
    const { merchant, category, amount, note, date } = req.body || {};
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
    return queryOne("SELECT * FROM transactions WHERE id = ?", [req.params.id]);
  });

  app.delete("/:id", async (req) => {
    await query("DELETE FROM transactions WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]);
    return { ok: true };
  });

  app.get("/by-category", async (req) => {
    const { from, to } = req.query;
    const params = [req.user.id];
    let dateClause = "";
    if (from) { dateClause += " AND date >= ?"; params.push(from); }
    if (to)   { dateClause += " AND date <= ?"; params.push(to); }
    return query(
      `SELECT category, SUM(ABS(amount)) AS total, COUNT(*) AS count
       FROM transactions WHERE user_id = ? AND amount < 0 ${dateClause}
       GROUP BY category ORDER BY total DESC`,
      params
    );
  });

  app.get("/cashflow", async (req) => {
    return query(
      `SELECT DATE_FORMAT(date, '%Y-%m') AS month,
              SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
              SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) AS spending
       FROM transactions WHERE user_id = ?
         AND date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
       GROUP BY month ORDER BY month`,
      [req.user.id]
    );
  });
}