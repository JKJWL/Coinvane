// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Action registry — Stage 2 (transaction hygiene).
// Later stages append here; each stage's actions live in their own
// registerAction block so it's obvious which stage introduced what.
//
// Importing this module has the SIDE EFFECT of registering every action
// with the engine. server.js and worker.js both import it at startup so
// their in-process engines can dispatch actions.
//
// Every action handler signature:
//   async handler(action, context, userId)
//     → { status?: "success"|"skipped", summary?: string, budgetId?, goalId? }
//     → OR throws an Error (engine logs "error" + flags the transaction)
//
// Handlers MUST:
//   - honour user ownership (WHERE user_id = ? on every mutation)
//   - not touch balances on scheduled rows (see routes/transactions.js
//     rationale) — the engine currently only fires on non-scheduled
//     transactions in Stage 2, so we don't guard here yet
//   - be idempotent enough that a duplicate fire from a re-sync is safe
//     (e.g. setting is_transfer=1 twice is fine; splitting the same
//     row twice is NOT — so split_txn has an explicit "already split"
//     guard using the note prefix)

import { registerAction } from "./automation-engine.js";
import { query, queryOne } from "./db.js";

// ─── mark_as_transfer ────────────────────────────────────────────────
// No params. Sets is_transfer=1 on the current transaction. Idempotent.
registerAction("mark_as_transfer", async (_action, context, userId) => {
  const txnId = context?.transaction?.id;
  if (!txnId) return { status: "skipped", summary: "No transaction in context" };
  await query(
    "UPDATE transactions SET is_transfer = 1 WHERE id = ? AND user_id = ?",
    [txnId, userId]
  );
  return { status: "success", summary: "Marked as transfer" };
});

// ─── add_note ───────────────────────────────────────────────────────
// params: { note: string, mode?: "overwrite" | "append" }
// Default mode overwrites. Cap at 500 chars so a runaway rule can't
// blow up the row.
registerAction("add_note", async (action, context, userId) => {
  const txnId = context?.transaction?.id;
  const noteRaw = String(action?.params?.note || "");
  const mode = action?.params?.mode === "append" ? "append" : "overwrite";
  if (!txnId) return { status: "skipped", summary: "No transaction in context" };
  if (!noteRaw.trim()) return { status: "skipped", summary: "No note text set" };
  const note = noteRaw.slice(0, 500);
  if (mode === "append") {
    await query(
      `UPDATE transactions
         SET note = CASE
             WHEN note IS NULL OR note = '' THEN ?
             ELSE CONCAT(note, ' — ', ?)
           END
         WHERE id = ? AND user_id = ?`,
      [note, note, txnId, userId]
    );
  } else {
    await query(
      "UPDATE transactions SET note = ? WHERE id = ? AND user_id = ?",
      [note, txnId, userId]
    );
  }
  return { status: "success", summary: `Note: "${note.slice(0, 60)}"` };
});

// ─── set_category ───────────────────────────────────────────────────
// params: { category: string }
// Overwrites the transaction's category. This CAN clobber a category
// that a merchant rule set during sync — that's by design per user's
// "user-defined order wins" answer earlier. If the user doesn't want
// an automation to override merchant rules for this merchant, they
// wouldn't include this action in the matching rule.
registerAction("set_category", async (action, context, userId) => {
  const txnId = context?.transaction?.id;
  const category = String(action?.params?.category || "").trim().slice(0, 64);
  if (!txnId) return { status: "skipped", summary: "No transaction in context" };
  if (!category) return { status: "skipped", summary: "No category set" };
  await query(
    "UPDATE transactions SET category = ? WHERE id = ? AND user_id = ?",
    [category, txnId, userId]
  );
  return { status: "success", summary: `Category → ${category}` };
});

// ─── flag_duplicate ─────────────────────────────────────────────────
// params: { withinDays?: 0-7 }
// Looks for another non-transfer, non-scheduled transaction with the
// same |amount| within `withinDays` days. If found, drops an in-app
// notification pointing at both. Never merges — user decides.
registerAction("flag_duplicate", async (action, context, userId) => {
  const txn = context?.transaction;
  if (!txn?.id) return { status: "skipped", summary: "No transaction in context" };
  const withinDays = Math.max(0, Math.min(7, Number(action?.params?.withinDays) || 0));
  const other = await queryOne(
    `SELECT id, date, merchant, account_id
     FROM transactions
     WHERE user_id = ? AND id <> ?
       AND ABS(ABS(amount) - ?) < 0.01
       AND ABS(DATEDIFF(date, ?)) <= ?
       AND (is_scheduled = 0 OR is_scheduled IS NULL)
       AND (is_transfer = 0 OR is_transfer IS NULL)
     ORDER BY ABS(DATEDIFF(date, ?)) ASC, id ASC
     LIMIT 1`,
    [userId, txn.id, Math.abs(Number(txn.amount)),
     txn.date, withinDays, txn.date]
  );
  if (!other) return { status: "skipped", summary: "No matching duplicate" };
  // Guard: if we already dropped a duplicate-flag notification for
  // this same pair, don't spam. Match on the body's txn id substrings.
  const existing = await queryOne(
    `SELECT id FROM notifications
     WHERE user_id = ? AND type = 'duplicate_flag'
       AND body LIKE ? AND body LIKE ?
     LIMIT 1`,
    [userId, `%#${txn.id}%`, `%#${other.id}%`]
  );
  if (existing) return { status: "skipped", summary: "Already flagged this pair" };
  await query(
    `INSERT INTO notifications
       (user_id, type, icon, color, title, body)
     VALUES (?, 'duplicate_flag', 'AlertCircle', 'amber', ?, ?)`,
    [
      userId,
      `Possible duplicate: ${txn.merchant}`,
      `Txn #${txn.id} ($${Math.abs(Number(txn.amount)).toFixed(2)} on ${txn.date}) ` +
      `matches Txn #${other.id} ("${other.merchant}" on ${String(other.date).slice(0,10)}).`,
    ]
  );
  return { status: "success", summary: `Flagged as duplicate of #${other.id}` };
});

// ─── split_txn ──────────────────────────────────────────────────────
// params: { splits: [{ category, amount, note? }] }
// Reduces the original transaction's amount by sum(splits) and inserts
// N child rows on the same account/date/merchant with the split's
// category + amount. The original stays anchored to its plaid_txn_id
// so future syncs don't re-create it.
//
// Guards:
//   - "already split" note-prefix guard prevents a re-fire from a
//     re-sync doubling the split
//   - sum(splits) must be <= |original amount| (or throws)
//   - each split amount > 0 and category non-empty
registerAction("split_txn", async (action, context, userId) => {
  const txn = context?.transaction;
  if (!txn?.id) return { status: "skipped", summary: "No transaction in context" };
  const splits = Array.isArray(action?.params?.splits) ? action.params.splits : [];
  const valid = splits.filter(s =>
    Number(s.amount) > 0 && String(s.category || "").trim().length > 0
  );
  if (valid.length === 0) {
    return { status: "skipped", summary: "No valid splits defined" };
  }
  // Re-fetch the row so we're not fighting stale context values.
  const row = await queryOne(
    "SELECT id, amount, note, account_id, date, merchant FROM transactions WHERE id = ? AND user_id = ?",
    [txn.id, userId]
  );
  if (!row) return { status: "skipped", summary: "Transaction gone" };
  if (row.note && row.note.includes("[Split into ")) {
    return { status: "skipped", summary: "Already split" };
  }
  const origAmount = Number(row.amount);
  const sign = origAmount >= 0 ? 1 : -1;
  const total = valid.reduce((s, x) => s + Number(x.amount), 0);
  if (total > Math.abs(origAmount) + 0.01) {
    throw new Error(
      `Split total $${total.toFixed(2)} exceeds transaction amount $${Math.abs(origAmount).toFixed(2)}`
    );
  }
  const remaining = Math.abs(origAmount) - total;
  const newNote = row.note
    ? `${row.note} [Split into ${valid.length}]`
    : `[Split into ${valid.length}]`;
  await query(
    "UPDATE transactions SET amount = ?, note = ? WHERE id = ? AND user_id = ?",
    [sign * remaining, newNote, row.id, userId]
  );
  for (const s of valid) {
    await query(
      `INSERT INTO transactions
         (user_id, account_id, date, merchant, category, amount, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId, row.account_id, row.date, row.merchant,
        String(s.category).trim().slice(0, 64),
        sign * Number(s.amount),
        (s.note ? String(s.note).slice(0, 500) : `Split from #${row.id}`),
      ]
    );
  }
  return {
    status: "success",
    summary: `Split $${Math.abs(origAmount).toFixed(2)} into ${valid.length} row(s)`,
  };
});

// Available action kinds (used by /vocab endpoint). Keep alphabetized
// so the picker shows a stable order.
export const ACTION_KINDS = [
  "add_note",
  "flag_duplicate",
  "mark_as_transfer",
  "set_category",
  "split_txn",
];
