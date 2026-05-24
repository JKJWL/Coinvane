import { query, queryOne } from "../db.js";

export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (req) => {
    return query(
      `SELECT id, name, target, saved, deadline, icon, color, created_at AS createdAt
       FROM goals WHERE user_id = ? ORDER BY created_at DESC`,
      [req.user.id]
    );
  });

  app.post("/", async (req, reply) => {
    const { name, target, saved = 0, deadline, icon = "Target", color = "#0ea5e9" } = req.body || {};
    if (!name || !target) return reply.code(400).send({ error: "name and target required" });
    const r = await query(
      `INSERT INTO goals (user_id, name, target, saved, deadline, icon, color)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, name, target, saved, deadline || null, icon, color]
    );
    return queryOne("SELECT * FROM goals WHERE id = ?", [r.insertId]);
  });

  app.patch("/:id", async (req) => {
    const { name, target, saved, deadline, icon, color } = req.body || {};
    await query(
      `UPDATE goals SET
         name = COALESCE(?, name),
         target = COALESCE(?, target),
         saved = COALESCE(?, saved),
         deadline = COALESCE(?, deadline),
         icon = COALESCE(?, icon),
         color = COALESCE(?, color)
       WHERE id = ? AND user_id = ?`,
      [name ?? null, target ?? null, saved ?? null, deadline ?? null, icon ?? null, color ?? null,
       req.params.id, req.user.id]
    );
    return queryOne("SELECT * FROM goals WHERE id = ?", [req.params.id]);
  });

  app.delete("/:id", async (req) => {
    await query("DELETE FROM goals WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]);
    return { ok: true };
  });
}

