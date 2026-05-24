import { query } from "../db.js";

export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (req) => {
    return query(
      `SELECT id, type, icon, color, title, body, read_at AS readAt, created_at AS createdAt
       FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
  });

  app.post("/:id/read", async (req) => {
    await query("UPDATE notifications SET read_at = NOW() WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]);
    return { ok: true };
  });

  app.post("/read-all", async (req) => {
    await query("UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL",
      [req.user.id]);
    return { ok: true };
  });

  app.delete("/:id", async (req) => {
    await query("DELETE FROM notifications WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]);
    return { ok: true };
  });

  app.get("/unread-count", async (req) => {
    const rows = await query(
      "SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL",
      [req.user.id]
    );
    return { count: Number(rows[0].count) };
  });
}