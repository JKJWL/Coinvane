// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "../db.js";
import { audit } from "../audit.js";

/**
 * Reconciliation flow — Quicken-style statement match.
 *
 *   1. POST  /              → start a draft; captures statement date +
 *                             ending balance + starting balance snapshot
 *   2. GET   /              → list of finalized reconciliations
 *   3. GET   /:id           → draft/locked detail + transaction list with
 *                             each txn's current cleared state
 *   4. POST  /:id/toggle    → flip cleared bit on a single transaction
 *                             within the draft's window
 *   5. POST  /:id/finalize  → refuse unless difference is zero, then lock
 *                             + stamp reconciliation_id on every cleared txn
 *   6. DELETE /:id          → drop a draft (only drafts, never locked)
 *
 * Difference math:
 *   difference = statement_ending_balance
 *              - (starting_balance + sum(cleared txn amounts in window))
 *   Zero == balanced.
 *
 * Transactions in the window: all rows on the account with date <=
 * statement_date AND (cleared = 0 AND reconciliation_id IS NULL — never
 * reconciled) OR reconciliation_id = current draft (so already-checked
 * txns stay visible if the user re-opens the draft).
 */
export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  // ── List finalized + any drafts, newest first ────────────────────
  app.get("/", async (req) => {
    return query(
      `SELECT r.id, r.account_id AS accountId, a.name AS accountName,
              r.statement_date AS statementDate,
              r.statement_ending_balance AS statementEndingBalance,
              r.starting_balance AS startingBalance,
              r.cleared_total AS clearedTotal,
              r.txn_count AS txnCount, r.status,
              r.locked_at AS lockedAt, r.created_at AS createdAt
       FROM reconciliations r
       JOIN accounts a ON a.id = r.account_id
       WHERE r.user_id = ?
       ORDER BY r.status = 'draft' DESC, r.statement_date DESC, r.id DESC`,
      [req.user.id]
    );
  });

  // ── Start a new reconciliation on an account ─────────────────────
  app.post("/", async (req, reply) => {
    const { account_id, statement_date, statement_ending_balance } = req.body || {};
    const accountId = Number(account_id);
    const endingBalance = Number(statement_ending_balance);
    if (!accountId || !statement_date || !Number.isFinite(endingBalance)) {
      return reply.code(400).send({
        error: "account_id, statement_date, statement_ending_balance required",
      });
    }
    const acct = await queryOne(
      "SELECT id, balance FROM accounts WHERE id = ? AND user_id = ?",
      [accountId, req.user.id]
    );
    if (!acct) return reply.code(404).send({ error: "account not found" });

    // Any existing draft on this account? Reuse it — one draft at a time.
    const existing = await queryOne(
      "SELECT id FROM reconciliations WHERE user_id = ? AND account_id = ? AND status = 'draft'",
      [req.user.id, accountId]
    );
    if (existing) {
      await query(
        `UPDATE reconciliations
         SET statement_date = ?, statement_ending_balance = ?
         WHERE id = ? AND user_id = ?`,
        [statement_date, endingBalance, existing.id, req.user.id]
      );
      return { id: existing.id, reused: true };
    }

    // Starting balance = sum of amounts on already-reconciled cleared txns.
    // If this is the account's first pass, that sum is 0 and starting = 0.
    // In practice a user can seed a nonzero starting balance from their
    // last statement in the UI, but the default matches the "started from
    // scratch" case.
    const seed = await queryOne(
      `SELECT COALESCE(SUM(amount), 0) AS s
       FROM transactions
       WHERE user_id = ? AND account_id = ? AND reconciliation_id IS NOT NULL`,
      [req.user.id, accountId]
    );
    const startingBalance = Number(seed?.s || 0);

    const r = await query(
      `INSERT INTO reconciliations
         (user_id, account_id, statement_date, statement_ending_balance,
          starting_balance, cleared_total, txn_count, status)
       VALUES (?, ?, ?, ?, ?, 0, 0, 'draft')`,
      [req.user.id, accountId, statement_date, endingBalance, startingBalance]
    );
    await audit(req.user.id, "reconciliation.start", req, { id: r.insertId, accountId });
    return { id: r.insertId };
  });

  // ── Get one reconciliation with its window of transactions ───────
  app.get("/:id", async (req, reply) => {
    const rec = await queryOne(
      `SELECT r.*, a.name AS accountName
       FROM reconciliations r
       JOIN accounts a ON a.id = r.account_id
       WHERE r.id = ? AND r.user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!rec) return reply.code(404).send({ error: "not found" });

    // For a locked pass we show only the txns it captured.
    // For a draft we show all in-window unreconciled + already-checked-in-draft.
    let txns;
    if (rec.status === "locked") {
      txns = await query(
        `SELECT id, date, merchant, category, amount, cleared, pending
         FROM transactions
         WHERE user_id = ? AND reconciliation_id = ?
         ORDER BY date ASC, id ASC`,
        [req.user.id, rec.id]
      );
    } else {
      txns = await query(
        `SELECT id, date, merchant, category, amount, cleared, pending
         FROM transactions
         WHERE user_id = ? AND account_id = ? AND date <= ?
           AND (reconciliation_id IS NULL)
           AND (is_scheduled = 0 OR is_scheduled IS NULL)
         ORDER BY date ASC, id ASC`,
        [req.user.id, rec.account_id, rec.statement_date]
      );
    }

    const clearedTotal = txns.reduce(
      (s, t) => s + (t.cleared ? Number(t.amount) : 0), 0);
    const difference = Number(rec.statement_ending_balance)
      - (Number(rec.starting_balance) + clearedTotal);

    return {
      id: rec.id,
      accountId: rec.account_id,
      accountName: rec.accountName,
      statementDate: rec.statement_date,
      statementEndingBalance: Number(rec.statement_ending_balance),
      startingBalance: Number(rec.starting_balance),
      clearedTotal: Number(clearedTotal.toFixed(2)),
      difference: Number(difference.toFixed(2)),
      status: rec.status,
      lockedAt: rec.locked_at,
      transactions: txns.map(t => ({
        id: t.id, date: t.date, merchant: t.merchant, category: t.category,
        amount: Number(t.amount), cleared: !!t.cleared, pending: !!t.pending,
      })),
    };
  });

  // ── Toggle cleared bit on a transaction inside a draft ───────────
  app.post("/:id/toggle", async (req, reply) => {
    const { transaction_id, cleared } = req.body || {};
    const txnId = Number(transaction_id);
    if (!txnId) return reply.code(400).send({ error: "transaction_id required" });

    const rec = await queryOne(
      "SELECT id, account_id, status, statement_date FROM reconciliations WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    if (!rec) return reply.code(404).send({ error: "not found" });
    if (rec.status !== "draft") {
      return reply.code(409).send({ error: "reconciliation already finalized" });
    }
    const txn = await queryOne(
      `SELECT id, cleared, reconciliation_id, account_id, date, amount
       FROM transactions WHERE id = ? AND user_id = ?`,
      [txnId, req.user.id]
    );
    if (!txn) return reply.code(404).send({ error: "transaction not found" });
    if (txn.account_id !== rec.account_id) {
      return reply.code(400).send({ error: "transaction not on this account" });
    }
    if (txn.reconciliation_id) {
      return reply.code(409).send({ error: "already reconciled in a prior pass" });
    }
    if (String(txn.date) > String(rec.statement_date)) {
      return reply.code(400).send({ error: "transaction is after statement date" });
    }
    const next = cleared === undefined ? (txn.cleared ? 0 : 1) : (cleared ? 1 : 0);
    await query(
      "UPDATE transactions SET cleared = ? WHERE id = ? AND user_id = ?",
      [next, txnId, req.user.id]
    );
    return { id: txnId, cleared: !!next };
  });

  // ── Finalize: refuse unless zeroed, stamp reconciliation_id ──────
  app.post("/:id/finalize", async (req, reply) => {
    const rec = await queryOne(
      "SELECT * FROM reconciliations WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    if (!rec) return reply.code(404).send({ error: "not found" });
    if (rec.status === "locked") return { id: rec.id, alreadyLocked: true };

    const clearedRows = await query(
      `SELECT id, amount FROM transactions
       WHERE user_id = ? AND account_id = ? AND date <= ?
         AND cleared = 1 AND reconciliation_id IS NULL`,
      [req.user.id, rec.account_id, rec.statement_date]
    );
    const clearedTotal = clearedRows.reduce((s, t) => s + Number(t.amount), 0);
    const difference = Number(rec.statement_ending_balance)
      - (Number(rec.starting_balance) + clearedTotal);
    if (Math.abs(difference) > 0.005) {
      return reply.code(400).send({
        error: `not balanced — off by $${difference.toFixed(2)}`,
        difference: Number(difference.toFixed(2)),
      });
    }
    await query(
      `UPDATE reconciliations SET status='locked', locked_at=NOW(),
         cleared_total=?, txn_count=? WHERE id = ?`,
      [Number(clearedTotal.toFixed(2)), clearedRows.length, rec.id]
    );
    if (clearedRows.length > 0) {
      const ids = clearedRows.map(r => r.id);
      const placeholders = ids.map(() => "?").join(",");
      await query(
        `UPDATE transactions SET reconciliation_id = ?
         WHERE user_id = ? AND id IN (${placeholders})`,
        [rec.id, req.user.id, ...ids]
      );
    }
    await audit(req.user.id, "reconciliation.finalize", req, {
      id: rec.id, accountId: rec.account_id, txns: clearedRows.length,
    });
    return { id: rec.id, txns: clearedRows.length };
  });

  // ── Drop a draft ─────────────────────────────────────────────────
  app.delete("/:id", async (req, reply) => {
    const rec = await queryOne(
      "SELECT id, status, account_id FROM reconciliations WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    if (!rec) return reply.code(404).send({ error: "not found" });
    if (rec.status === "locked") {
      return reply.code(409).send({ error: "cannot delete a locked reconciliation" });
    }
    // Un-tick any cleared txns that had been checked inside this draft
    // (they never got a reconciliation_id, so we just clear the bit).
    await query(
      `UPDATE transactions SET cleared = 0
       WHERE user_id = ? AND account_id = ? AND cleared = 1 AND reconciliation_id IS NULL`,
      [req.user.id, rec.account_id]
    );
    await query("DELETE FROM reconciliations WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]);
    return { ok: true };
  });
}
