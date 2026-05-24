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

  app.delete("/:id", async (req) => {
    await query("DELETE FROM accounts WHERE id = ? AND user_id = ? AND plaid_item_id IS NULL",
      [req.params.id, req.user.id]);
    return { ok: true };
  });

  app.get("/summary", async (req) => {
    const rows = await query(
      `SELECT type, SUM(balance) AS total FROM accounts WHERE user_id = ? GROUP BY type`,
      [req.user.id]
    );
    const summary = { cash: 0, credit: 0, investment: 0, loan: 0, other: 0 };
    for (const r of rows) summary[r.type] = Number(r.total) || 0;
    summary.netWorth = summary.cash + summary.investment + summary.credit + summary.loan;
    return summary;
  });
}