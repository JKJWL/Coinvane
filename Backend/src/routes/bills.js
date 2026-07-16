// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "../db.js";
import { ensureCurrentCycle, refreshUserBillCycles } from "../bill-utils.js";

// Whitelist of cycle kinds. Anything else falls back to "monthly".
const CYCLE_KINDS = new Set(["weekly", "biweekly", "semimonthly", "monthly", "yearly", "custom"]);

function sanitize(row) {
  return {
    ...row,
    autopay: !!row.autopay,
    expected_amount: Number(row.expected_amount),
    average_amount: row.average_amount == null ? null : Number(row.average_amount),
    min_payment: row.min_payment == null ? null : Number(row.min_payment),
  };
}

export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  // List every active bill + its current cycle state. `historyCount`
  // pulls the last N cycles per bill for a "how variance has trended"
  // view. Default 0 = current cycle only.
  app.get("/", async (req) => {
    const historyCount = Math.max(0, Math.min(12, Number(req.query?.historyCount) || 0));
    const bills = await query(
      `SELECT * FROM bills WHERE user_id = ? AND archived_at IS NULL
       ORDER BY created_at ASC`,
      [req.user.id]
    );
    // Guarantee an open cycle exists for each bill (idempotent).
    // Falls back cleanly if a bill has malformed cycle math.
    for (const b of bills) {
      try { await ensureCurrentCycle(req.user.id, b); } catch { /* skip */ }
    }
    const out = [];
    for (const b of bills) {
      const current = await queryOne(
        `SELECT * FROM bill_cycles
         WHERE bill_id = ? AND user_id = ?
         ORDER BY cycle_start DESC LIMIT 1`,
        [b.id, req.user.id]
      );
      const history = historyCount > 0 ? await query(
        `SELECT * FROM bill_cycles
         WHERE bill_id = ? AND user_id = ?
         ORDER BY cycle_start DESC LIMIT ?`,
        [b.id, req.user.id, historyCount]
      ) : [];
      out.push({ ...sanitize(b), current, history });
    }
    return out;
  });

  app.post("/", async (req, reply) => {
    const {
      name, category, cycle, cycle_days, cycle_anchor, expected_amount,
      account_id, autopay, account_hint, min_payment, merchant_pattern, notes,
    } = req.body || {};
    if (!name || !cycle_anchor) {
      return reply.code(400).send({ error: "name and cycle_anchor required" });
    }
    const kind = CYCLE_KINDS.has(cycle) ? cycle : "monthly";
    const r = await query(
      `INSERT INTO bills
         (user_id, name, category, cycle, cycle_days, cycle_anchor,
          expected_amount, account_id, autopay, account_hint,
          min_payment, merchant_pattern, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        String(name).slice(0, 128),
        String(category || "Bills").slice(0, 64),
        kind,
        cycle_days ? Number(cycle_days) : null,
        cycle_anchor,
        Number(expected_amount) || 0,
        account_id || null,
        autopay ? 1 : 0,
        account_hint ? String(account_hint).slice(0, 32) : null,
        min_payment != null ? Number(min_payment) : null,
        merchant_pattern ? String(merchant_pattern).slice(0, 128) : null,
        notes ? String(notes).slice(0, 500) : null,
      ]
    );
    const row = await queryOne("SELECT * FROM bills WHERE id = ?", [r.insertId]);
    // Open the first cycle immediately so the UI has something to render.
    await ensureCurrentCycle(req.user.id, row);
    return sanitize(row);
  });

  app.patch("/:id", async (req, reply) => {
    const owned = await queryOne(
      "SELECT id FROM bills WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    if (!owned) return reply.code(404).send({ error: "not found" });
    const b = req.body || {};
    const kind = b.cycle && CYCLE_KINDS.has(b.cycle) ? b.cycle : null;
    await query(
      `UPDATE bills SET
         name = COALESCE(?, name),
         category = COALESCE(?, category),
         cycle = COALESCE(?, cycle),
         cycle_days = COALESCE(?, cycle_days),
         cycle_anchor = COALESCE(?, cycle_anchor),
         expected_amount = COALESCE(?, expected_amount),
         account_id = COALESCE(?, account_id),
         autopay = COALESCE(?, autopay),
         account_hint = COALESCE(?, account_hint),
         min_payment = COALESCE(?, min_payment),
         merchant_pattern = COALESCE(?, merchant_pattern),
         notes = COALESCE(?, notes)
       WHERE id = ? AND user_id = ?`,
      [
        b.name ?? null,
        b.category ?? null,
        kind,
        b.cycle_days ?? null,
        b.cycle_anchor ?? null,
        b.expected_amount ?? null,
        b.account_id ?? null,
        b.autopay != null ? (b.autopay ? 1 : 0) : null,
        b.account_hint ?? null,
        b.min_payment ?? null,
        b.merchant_pattern ?? null,
        b.notes ?? null,
        req.params.id, req.user.id,
      ]
    );
    return sanitize(await queryOne("SELECT * FROM bills WHERE id = ?", [req.params.id]));
  });

  // Soft-delete: archive so historical cycles remain queryable.
  app.delete("/:id", async (req, reply) => {
    const r = await query(
      "UPDATE bills SET archived_at = NOW() WHERE id = ? AND user_id = ? AND archived_at IS NULL",
      [req.params.id, req.user.id]
    );
    if (!r.affectedRows) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });

  // Manual fallback: mark the current cycle paid with an amount. If no
  // amount is provided, uses the bill's expected amount so a one-tap
  // "mark paid" works for autopay bills that don't vary.
  app.post("/:id/mark-paid", async (req, reply) => {
    const bill = await queryOne(
      "SELECT * FROM bills WHERE id = ? AND user_id = ? AND archived_at IS NULL",
      [req.params.id, req.user.id]
    );
    if (!bill) return reply.code(404).send({ error: "not found" });
    const cycle = await ensureCurrentCycle(req.user.id, bill);
    if (cycle.paid_at) return reply.code(409).send({ error: "already paid" });
    const amount = Number(req.body?.amount) || Number(bill.expected_amount) || 0;
    const variance = Number(cycle.expected_amount) > 0
      ? ((amount - Number(cycle.expected_amount)) / Number(cycle.expected_amount)) * 100
      : null;
    await query(
      `UPDATE bill_cycles
       SET paid_at = NOW(), paid_amount = ?, variance_pct = ?
       WHERE id = ?`,
      [amount, variance, cycle.id]
    );
    return { ok: true, cycleId: cycle.id };
  });

  // Manual undo — flip the current cycle back to unpaid. Useful if the
  // auto-matcher grabbed the wrong transaction.
  app.post("/:id/mark-unpaid", async (req, reply) => {
    const bill = await queryOne(
      "SELECT id FROM bills WHERE id = ? AND user_id = ? AND archived_at IS NULL",
      [req.params.id, req.user.id]
    );
    if (!bill) return reply.code(404).send({ error: "not found" });
    const cycle = await queryOne(
      `SELECT id FROM bill_cycles
       WHERE bill_id = ? AND user_id = ?
       ORDER BY cycle_start DESC LIMIT 1`,
      [bill.id, req.user.id]
    );
    if (!cycle) return reply.code(404).send({ error: "no cycle" });
    await query(
      `UPDATE bill_cycles
       SET paid_at = NULL, paid_amount = NULL, matched_txn_id = NULL, variance_pct = NULL
       WHERE id = ?`,
      [cycle.id]
    );
    return { ok: true };
  });

  // Manual skip: mark the current cycle skipped (doesn't count as unpaid
  // for "due this week" purposes). Useful for "took a month off my gym".
  app.post("/:id/skip", async (req, reply) => {
    const bill = await queryOne(
      "SELECT * FROM bills WHERE id = ? AND user_id = ? AND archived_at IS NULL",
      [req.params.id, req.user.id]
    );
    if (!bill) return reply.code(404).send({ error: "not found" });
    const cycle = await ensureCurrentCycle(req.user.id, bill);
    await query("UPDATE bill_cycles SET skipped = 1 WHERE id = ?", [cycle.id]);
    return { ok: true };
  });

  // Force a refresh of every bill's current cycle. Manual fallback for
  // "the cron didn't run and I want to see my upcoming bills now".
  app.post("/refresh-cycles", async (req) => {
    await refreshUserBillCycles(req.user.id);
    return { ok: true };
  });
}
