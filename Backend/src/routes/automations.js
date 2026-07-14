// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "../db.js";
import { TRIGGER_TYPES, RULE_VOCAB } from "../automation-engine.js";

/**
 * Per-user automation rule CRUD + private history endpoints.
 *
 * NOTHING here writes to the admin audit log — automations are private
 * to the user and stay out of the security audit trail entirely. The
 * only shared surface is `has_automation_error` on the transactions row
 * which any of the user's own consumers can see (already scoped by
 * user_id in the transactions route).
 */
export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  // ── Rule builder vocabulary ─────────────────────────────────────
  // Frontend calls this once on tab mount to populate the trigger /
  // field / operator dropdowns without hard-coding vocabulary in two
  // places. Actions land in later stages; the response shape is
  // forward-compatible so we can grow it without a schema change.
  app.get("/vocab", async () => ({
    triggers: TRIGGER_TYPES,
    fields:   RULE_VOCAB.fields,
    ops:      RULE_VOCAB.ops,
    // Populated in Stages 2–6. Empty in the foundation stage — the
    // Actions picker will show "No actions available yet" until then.
    actions:  [],
  }));

  // ── Rule list ───────────────────────────────────────────────────
  app.get("/", async (req) => {
    const rows = await query(
      `SELECT id, name, trigger_type AS triggerType, conditions, actions,
              enabled, sort_order AS sortOrder,
              created_at AS createdAt, updated_at AS updatedAt
       FROM automation_rules
       WHERE user_id = ?
       ORDER BY sort_order ASC, id ASC`,
      [req.user.id]
    );
    // Parse the JSON blobs so the client doesn't have to double-parse.
    // Malformed rules surface as [] instead of throwing.
    for (const r of rows) {
      try { r.conditions = r.conditions ? JSON.parse(r.conditions) : []; }
      catch { r.conditions = []; }
      try { r.actions = r.actions ? JSON.parse(r.actions) : []; }
      catch { r.actions = []; }
    }
    return rows;
  });

  // ── Create ──────────────────────────────────────────────────────
  app.post("/", async (req, reply) => {
    const { name, triggerType, conditions = [], actions = [], enabled = true } = req.body || {};
    if (!name || !triggerType) {
      return reply.code(400).send({ error: "name and triggerType required" });
    }
    if (!TRIGGER_TYPES.includes(triggerType)) {
      return reply.code(400).send({ error: "invalid triggerType" });
    }
    // Next sort_order for this user (append at end)
    const maxRow = await queryOne(
      "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM automation_rules WHERE user_id = ?",
      [req.user.id]
    );
    const r = await query(
      `INSERT INTO automation_rules
         (user_id, name, trigger_type, conditions, actions, enabled, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, name.trim().slice(0, 128), triggerType,
       JSON.stringify(conditions), JSON.stringify(actions),
       enabled ? 1 : 0, Number(maxRow.next) || 0]
    );
    return { ok: true, id: r.insertId };
  });

  // ── Update ──────────────────────────────────────────────────────
  app.patch("/:id", async (req, reply) => {
    const { name, triggerType, conditions, actions, enabled } = req.body || {};
    const owned = await queryOne(
      "SELECT id FROM automation_rules WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    if (!owned) return reply.code(404).send({ error: "not found" });
    if (triggerType && !TRIGGER_TYPES.includes(triggerType)) {
      return reply.code(400).send({ error: "invalid triggerType" });
    }
    await query(
      `UPDATE automation_rules SET
         name          = COALESCE(?, name),
         trigger_type  = COALESCE(?, trigger_type),
         conditions    = COALESCE(?, conditions),
         actions       = COALESCE(?, actions),
         enabled       = COALESCE(?, enabled)
       WHERE id = ? AND user_id = ?`,
      [
        name ? name.trim().slice(0, 128) : null,
        triggerType || null,
        conditions !== undefined ? JSON.stringify(conditions) : null,
        actions    !== undefined ? JSON.stringify(actions)    : null,
        enabled    !== undefined ? (enabled ? 1 : 0)          : null,
        req.params.id, req.user.id,
      ]
    );
    return { ok: true };
  });

  // ── Delete ──────────────────────────────────────────────────────
  app.delete("/:id", async (req) => {
    await query(
      "DELETE FROM automation_rules WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    return { ok: true };
  });

  // ── Reorder ─────────────────────────────────────────────────────
  // Body: { ids: [ruleId1, ruleId2, …] } — must contain every one of
  // the caller's rules exactly once. Same pattern as budgets/reorder.
  app.post("/reorder", async (req, reply) => {
    const { ids } = req.body || {};
    if (!Array.isArray(ids)) {
      return reply.code(400).send({ error: "ids array required" });
    }
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      const rows = await query(
        `SELECT id FROM automation_rules WHERE user_id = ? AND id IN (${placeholders})`,
        [req.user.id, ...ids]
      );
      if (rows.length !== ids.length) {
        return reply.code(403).send({ error: "one or more ids do not belong to you" });
      }
    }
    for (let i = 0; i < ids.length; i++) {
      await query(
        "UPDATE automation_rules SET sort_order = ? WHERE id = ? AND user_id = ?",
        [i, ids[i], req.user.id]
      );
    }
    return { ok: true };
  });

  // ── History (private, per-user) ────────────────────────────────
  // Newest first. Capped at 200 rows — retention prunes to 30 days
  // daily in the worker.
  app.get("/history", async (req) => {
    return query(
      `SELECT id, rule_id AS ruleId, rule_name AS ruleName, status,
              summary, error_message AS errorMessage,
              transaction_id AS transactionId,
              budget_id AS budgetId, goal_id AS goalId,
              acknowledged, fired_at AS firedAt
       FROM automation_history
       WHERE user_id = ?
       ORDER BY fired_at DESC, id DESC
       LIMIT 200`,
      [req.user.id]
    );
  });

  // Acknowledge one error entry AND clear the sticky flag on the
  // transaction if this was the last unacknowledged error against it.
  // "Clearing an error" per user spec: the red pill on the txn only
  // vanishes when the user acknowledges here.
  app.post("/history/:id/acknowledge", async (req, reply) => {
    const row = await queryOne(
      `SELECT id, transaction_id FROM automation_history
       WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!row) return reply.code(404).send({ error: "not found" });
    await query(
      "UPDATE automation_history SET acknowledged = 1 WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    if (row.transaction_id) {
      const stillErroring = await queryOne(
        `SELECT id FROM automation_history
         WHERE user_id = ? AND transaction_id = ?
           AND status = 'error' AND acknowledged = 0
         LIMIT 1`,
        [req.user.id, row.transaction_id]
      );
      if (!stillErroring) {
        await query(
          "UPDATE transactions SET has_automation_error = 0 WHERE id = ? AND user_id = ?",
          [row.transaction_id, req.user.id]
        );
      }
    }
    return { ok: true };
  });

  // Acknowledge every unacknowledged error at once. Useful bulk action
  // after fixing a broken rule.
  app.post("/history/acknowledge-all", async (req) => {
    await query(
      `UPDATE automation_history SET acknowledged = 1
       WHERE user_id = ? AND status = 'error' AND acknowledged = 0`,
      [req.user.id]
    );
    await query(
      "UPDATE transactions SET has_automation_error = 0 WHERE user_id = ?",
      [req.user.id]
    );
    return { ok: true };
  });
}
