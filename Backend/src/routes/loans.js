// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "../db.js";

const LOAN_TYPES = new Set(["mortgage", "auto", "student", "personal", "credit_card", "other"]);

function sanitize(row) {
  if (!row) return null;
  return {
    ...row,
    principal:         Number(row.principal),
    current_balance:   Number(row.current_balance),
    apr:               Number(row.apr),
    term_months:       Number(row.term_months),
    monthly_payment:   Number(row.monthly_payment),
    escrow_tax:        Number(row.escrow_tax || 0),
    escrow_insurance:  Number(row.escrow_insurance || 0),
    escrow_pmi:        Number(row.escrow_pmi || 0),
    escrow_other:      Number(row.escrow_other || 0),
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
      escrow_tax, escrow_insurance, escrow_pmi, escrow_other,
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
          term_months, monthly_payment, start_date, linked_account_id, notes,
          escrow_tax, escrow_insurance, escrow_pmi, escrow_other)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        Math.max(0, Number(escrow_tax) || 0),
        Math.max(0, Number(escrow_insurance) || 0),
        Math.max(0, Number(escrow_pmi) || 0),
        Math.max(0, Number(escrow_other) || 0),
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
    // Escrow: undefined means "don't touch"; a number means "set to that
    // (clamped >= 0)".
    const escrowVal = (v) => v === undefined ? null : Math.max(0, Number(v) || 0);
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
         notes = COALESCE(?, notes),
         escrow_tax = COALESCE(?, escrow_tax),
         escrow_insurance = COALESCE(?, escrow_insurance),
         escrow_pmi = COALESCE(?, escrow_pmi),
         escrow_other = COALESCE(?, escrow_other)
       WHERE id = ? AND user_id = ?`,
      [
        b.name ?? null, kind,
        b.principal ?? null, b.current_balance ?? null,
        b.apr ?? null, b.term_months ?? null,
        b.monthly_payment ?? null, b.start_date ?? null,
        b.linked_account_id ?? null, b.notes ?? null,
        escrowVal(b.escrow_tax), escrowVal(b.escrow_insurance),
        escrowVal(b.escrow_pmi), escrowVal(b.escrow_other),
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
  //
  // If `account_id` is supplied (payment source — the checking account
  // the money leaves from), we also post an outflow transaction on that
  // account so the payment shows on cashflow / budgets / by-category.
  // The manual-account balance shift happens through adjustManualAccountBalance
  // in the transactions module, so import that helper here.
  app.post("/:id/payment", async (req, reply) => {
    const amount = Number(req.body?.amount);
    const paymentAccountId = req.body?.account_id ? Number(req.body.account_id) : null;
    const date = req.body?.date || new Date().toISOString().slice(0, 10);
    if (!(amount > 0)) return reply.code(400).send({ error: "amount > 0 required" });
    const loan = await queryOne(
      "SELECT id, name, current_balance FROM loans WHERE id = ? AND user_id = ? AND archived_at IS NULL",
      [req.params.id, req.user.id]
    );
    if (!loan) return reply.code(404).send({ error: "not found" });
    const next = Math.max(0, Number(loan.current_balance) - amount);
    await query(
      "UPDATE loans SET current_balance = ? WHERE id = ?",
      [next, loan.id]
    );
    // Post a ledger transaction if the caller told us where the money
    // came from. Category "Loan Payment" so it groups predictably;
    // is_transfer stays 0 because the destination isn't itself an
    // account we track (a `loans` row is separate from `accounts`).
    if (paymentAccountId) {
      const acct = await queryOne(
        "SELECT id, plaid_item_id FROM accounts WHERE id = ? AND user_id = ?",
        [paymentAccountId, req.user.id]
      );
      if (acct) {
        await query(
          `INSERT INTO transactions
             (user_id, account_id, date, merchant, category, amount, note)
           VALUES (?, ?, ?, ?, 'Loan Payment', ?, ?)`,
          [req.user.id, acct.id, date,
           `Payment · ${loan.name}`, -Math.abs(amount),
           `Applied to loan #${loan.id}`]
        );
        // Manual account balance decreases (Plaid-linked untouched).
        if (!acct.plaid_item_id) {
          await query(
            "UPDATE accounts SET balance = balance - ? WHERE id = ?",
            [Math.abs(amount), acct.id]
          );
        }
      }
    }
    return { ok: true, current_balance: next };
  });
}
