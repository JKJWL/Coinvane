// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "../db.js";

export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (req) => {
    return query(
      `SELECT id, name, color, icon, custom,
              tax_schedule AS taxSchedule,
              group_name AS groupName,
              parent_id AS parentId
       FROM categories
       WHERE user_id = ? ORDER BY name`,
      [req.user.id]
    );
  });

  app.post("/", async (req, reply) => {
    const { name, color = "#6b7280", icon = "Tag", tax_schedule = null, group_name = null, parent_id = null } = req.body || {};
    if (!name) return reply.code(400).send({ error: "name required" });
    const schedule = tax_schedule && /^[ABCDE]$/.test(String(tax_schedule)) ? tax_schedule : null;
    const groupName = group_name ? String(group_name).slice(0, 64) : null;
    // Validate parent — must belong to caller. Silently drop otherwise.
    let parentId = null;
    if (parent_id) {
      const parent = await queryOne(
        "SELECT id FROM categories WHERE id = ? AND user_id = ?",
        [parent_id, req.user.id]
      );
      if (parent) parentId = parent.id;
    }
    const r = await query(
      `INSERT INTO categories (user_id, name, color, icon, custom, tax_schedule, group_name, parent_id)
       VALUES (?, ?, ?, ?, TRUE, ?, ?, ?)`,
      [req.user.id, name, color, icon, schedule, groupName, parentId]
    );
    return queryOne("SELECT * FROM categories WHERE id = ?", [r.insertId]);
  });

  app.patch("/:id", async (req) => {
    const { name, color, icon, tax_schedule, group_name, parent_id } = req.body || {};
    let schedule = tax_schedule;
    if (schedule !== undefined) {
      if (schedule === null || schedule === "") schedule = null;
      else if (!/^[ABCDE]$/.test(String(schedule))) schedule = undefined;
    }
    let groupName = group_name;
    if (groupName !== undefined) {
      groupName = groupName ? String(groupName).slice(0, 64) : null;
    }
    // parent_id: undefined = no change; null/0/"" = clear; else validate
    // and (importantly) refuse self-reference to avoid a cycle.
    let parentId = undefined;
    if (parent_id !== undefined) {
      if (!parent_id) parentId = null;
      else if (Number(parent_id) === Number(req.params.id)) parentId = null;
      else {
        const parent = await queryOne(
          "SELECT id FROM categories WHERE id = ? AND user_id = ?",
          [parent_id, req.user.id]
        );
        parentId = parent ? parent.id : null;
      }
    }
    await query(
      `UPDATE categories SET
         name = COALESCE(?, name),
         color = COALESCE(?, color),
         icon = COALESCE(?, icon),
         tax_schedule = ${schedule === undefined ? "tax_schedule" : "?"},
         group_name = ${groupName === undefined ? "group_name" : "?"},
         parent_id = ${parentId === undefined ? "parent_id" : "?"}
       WHERE id = ? AND user_id = ?`,
      [
        name ?? null, color ?? null, icon ?? null,
        ...(schedule === undefined ? [] : [schedule]),
        ...(groupName === undefined ? [] : [groupName]),
        ...(parentId === undefined ? [] : [parentId]),
        req.params.id, req.user.id,
      ]
    );
    return queryOne("SELECT * FROM categories WHERE id = ?", [req.params.id]);
  });

  app.delete("/:id", async (req) => {
    await query("DELETE FROM categories WHERE id = ? AND user_id = ? AND custom = TRUE",
      [req.params.id, req.user.id]);
    return { ok: true };
  });
}