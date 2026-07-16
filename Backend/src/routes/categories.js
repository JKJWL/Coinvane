// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "../db.js";

export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (req) => {
    return query(
      `SELECT id, name, color, icon, custom, tax_schedule AS taxSchedule FROM categories
       WHERE user_id = ? ORDER BY name`,
      [req.user.id]
    );
  });

  app.post("/", async (req, reply) => {
    const { name, color = "#6b7280", icon = "Tag", tax_schedule = null } = req.body || {};
    if (!name) return reply.code(400).send({ error: "name required" });
    const schedule = tax_schedule && /^[ABCDE]$/.test(String(tax_schedule)) ? tax_schedule : null;
    const r = await query(
      `INSERT INTO categories (user_id, name, color, icon, custom, tax_schedule) VALUES (?, ?, ?, ?, TRUE, ?)`,
      [req.user.id, name, color, icon, schedule]
    );
    return queryOne("SELECT * FROM categories WHERE id = ?", [r.insertId]);
  });

  app.patch("/:id", async (req) => {
    const { name, color, icon, tax_schedule } = req.body || {};
    // tax_schedule allowed to be null (to clear it) — validate shape.
    let schedule = tax_schedule;
    if (schedule !== undefined) {
      if (schedule === null || schedule === "") schedule = null;
      else if (!/^[ABCDE]$/.test(String(schedule))) schedule = undefined;  // ignore garbage
    }
    await query(
      `UPDATE categories SET
         name = COALESCE(?, name),
         color = COALESCE(?, color),
         icon = COALESCE(?, icon),
         tax_schedule = ${schedule === undefined ? "tax_schedule" : "?"}
       WHERE id = ? AND user_id = ?`,
      schedule === undefined
        ? [name ?? null, color ?? null, icon ?? null, req.params.id, req.user.id]
        : [name ?? null, color ?? null, icon ?? null, schedule, req.params.id, req.user.id]
    );
    return queryOne("SELECT * FROM categories WHERE id = ?", [req.params.id]);
  });

  app.delete("/:id", async (req) => {
    await query("DELETE FROM categories WHERE id = ? AND user_id = ? AND custom = TRUE",
      [req.params.id, req.user.id]);
    return { ok: true };
  });
}