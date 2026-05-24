import { query, queryOne } from "../db.js";

export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (req) => {
    return query(
      `SELECT id, name, color, icon, custom FROM categories
       WHERE user_id = ? ORDER BY name`,
      [req.user.id]
    );
  });

  app.post("/", async (req, reply) => {
    const { name, color = "#6b7280", icon = "Tag" } = req.body || {};
    if (!name) return reply.code(400).send({ error: "name required" });
    const r = await query(
      `INSERT INTO categories (user_id, name, color, icon, custom) VALUES (?, ?, ?, ?, TRUE)`,
      [req.user.id, name, color, icon]
    );
    return queryOne("SELECT * FROM categories WHERE id = ?", [r.insertId]);
  });

  app.patch("/:id", async (req) => {
    const { name, color, icon } = req.body || {};
    await query(
      `UPDATE categories SET
         name = COALESCE(?, name),
         color = COALESCE(?, color),
         icon = COALESCE(?, icon)
       WHERE id = ? AND user_id = ?`,
      [name ?? null, color ?? null, icon ?? null, req.params.id, req.user.id]
    );
    return queryOne("SELECT * FROM categories WHERE id = ?", [req.params.id]);
  });

  app.delete("/:id", async (req) => {
    await query("DELETE FROM categories WHERE id = ? AND user_id = ? AND custom = TRUE",
      [req.params.id, req.user.id]);
    return { ok: true };
  });
}