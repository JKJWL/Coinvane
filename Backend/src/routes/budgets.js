import { query, queryOne } from "../db.js";

export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (req) => {
    return query(
      `SELECT b.id, b.category, b.amount, b.period,
              COALESCE((SELECT SUM(ABS(t.amount)) FROM transactions t
                WHERE t.user_id = b.user_id AND t.category = b.category AND t.amount < 0
                  AND t.date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')), 0) AS spent
       FROM budgets b WHERE b.user_id = ? ORDER BY b.category`,
      [req.user.id]
    );
  });

  app.post("/", async (req, reply) => {
    const { category, amount, period = "monthly" } = req.body || {};
    if (!category || !amount) return reply.code(400).send({ error: "category and amount required" });
    await query(
      `INSERT INTO budgets (user_id, category, amount, period) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE amount = VALUES(amount), period = VALUES(period)`,
      [req.user.id, category, amount, period]
    );
    return queryOne("SELECT * FROM budgets WHERE user_id = ? AND category = ?",
      [req.user.id, category]);
  });

  app.patch("/:id", async (req) => {
    const { amount } = req.body || {};
    await query("UPDATE budgets SET amount = ? WHERE id = ? AND user_id = ?",
      [amount, req.params.id, req.user.id]);
    return queryOne("SELECT * FROM budgets WHERE id = ?", [req.params.id]);
  });

  app.delete("/:id", async (req) => {
    await query("DELETE FROM budgets WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]);
    return { ok: true };
  });
}