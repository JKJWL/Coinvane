// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "../db.js";

const LOAN_TYPES = new Set(["mortgage", "auto", "student", "personal", "credit_card", "other"]);

function sanitize(row) {
  if (!row) return null;
  return {
    ...row,
    principal:        Number(row.principal),
    current_balance:  Number(row.current_balance),
    apr:              Number(row.apr),
    term_months:      Number(row.term_months),
    monthly_payment:  Number(row.monthly_payment),
    archived: !!row.archived_at,
  };
}

export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (req) => {
    const rows = await query(
      `SELECT l.*, a.name AS linked_account_name
       FROM loans l
       LEFT JOIN accounts a ON a.id = l.linked_account_id
       WHERE l.user_id = ? AND l.archived_at IS NULL
       ORDER BY l.created_at ASC`,
      [req.user.id]
    );
    return rows.map(sanitize);
  });

  app.post("/", async (req, reply) => {
    const {
      name, loan_type, principal, current_balance, apr, term_months,
      monthly_payment, start_date, linked_account_id, notes,
    } = req.body || {};
    if (!name || principal == null || current_balance == null || !start_date) {
      return reply.code(400).send({
        error: "name, principal, current_balance, start_date required",
      });
    }
    const kind = LOAN_TYPES.has(loan_type) ? loan_type : "other";
    const r = await query(
      `INSERT INTO loans
         (user_id, name, loan_type, principal, current_balance, apr,
          term_months, monthly_payment, start_date, linked_account_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        String(name).slice(0, 128),
        kind,
        Number(principal) || 0,
        Number(current_balance) || 0,
        Number(apr) || 0,
        Number(term_months) || 0,
        Number(monthly_payment) || 0,
        start_date,
        linked_account_id || null,
        notes ? String(notes).slice(0, 500) : null,
      ]
    );
    return sanitize(await queryOne("SELECT * FROM loans WHERE id = ?", [r.insertId]));
  });

  app.patch("/:id", async (req, reply) => {
    const owned = await queryOne(
      "SELECT id FROM loans WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    if (!owned) return reply.code(404).send({ error: "not found" });
    const b = req.body || {};
    const kind = b.loan_type && LOAN_TYPES.has(b.loan_type) ? b.loan_type : null;
    await query(
      `UPDATE loans SET
         name = COALESCE(?, name),
         loan_type = COALESCE(?, loan_type),
         principal = COALESCE(?, principal),
         current_balance = COALESCE(?, current_balance),
         apr = COALESCE(?, apr),
         term_months = COALESCE(?, term_months),
         monthly_payment = COALESCE(?, monthly_payment),
         start_date = COALESCE(?, start_date),
         linked_account_id = COALESCE(?, linked_account_id),
         notes = COALESCE(?, notes)
       WHERE id = ? AND user_id = ?`,
      [
        b.name ?? null, kind,
        b.principal ?? null, b.current_balance ?? null,
        b.apr ?? null, b.term_months ?? null,
        b.monthly_payment ?? null, b.start_date ?? null,
        b.linked_account_id ?? null, b.notes ?? null,
        req.params.id, req.user.id,
      ]
    );
    return sanitize(await queryOne("SELECT * FROM loans WHERE id = ?", [req.params.id]));
  });

  // Soft-delete so payoff history isn't lost.
  app.delete("/:id", async (req, reply) => {
    const r = await query(
      "UPDATE loans SET archived_at = NOW() WHERE id = ? AND user_id = ? AND archived_at IS NULL",
      [req.params.id, req.user.id]
    );
    if (!r.affectedRows) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });

  // Manual payment: decrement current_balance by amount.
  app.post("/:id/payment", async (req, reply) => {
    const amount = Number(req.body?.amount);
    if (!(amount > 0)) return reply.code(400).send({ error: "amount > 0 required" });
    const loan = await queryOne(
      "SELECT id, current_balance FROM loans WHERE id = ? AND user_id = ? AND archived_at IS NULL",
      [req.params.id, req.user.id]
    );
    if (!loan) return reply.code(404).send({ error: "not found" });
    const next = Math.max(0, Number(loan.current_balance) - amount);
    await query(
      "UPDATE loans SET current_balance = ? WHERE id = ?",
      [next, loan.id]
    );
    return { ok: true, current_balance: next };
  });
}
