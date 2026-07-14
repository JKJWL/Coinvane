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

// ═══ Stage 3: alert rules ════════════════════════════════════════════
//
// Every alert action dedups via a `dedupKey`-shaped notification body
// prefix. Cron re-runs of the same condition (low balance still low,
// utilization still high) don't spam — a matching unread notification
// created within DEDUP_HOURS suppresses the re-fire.
const DEDUP_HOURS = 24;

async function alreadyNotified(userId, dedupKey) {
  const row = await queryOne(
    `SELECT id FROM notifications
     WHERE user_id = ? AND body LIKE ?
       AND created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
     LIMIT 1`,
    [userId, `%[dedup:${dedupKey}]%`, DEDUP_HOURS]
  );
  return !!row;
}
async function insertAlert(userId, { title, body, dedupKey, color = "amber", icon = "AlertCircle" }) {
  // Body embeds the dedup marker at the end so alreadyNotified() can
  // grep for it. Not shown to the user (marker is a plain suffix; the
  // frontend's notification renderer just prints body verbatim, so we
  // hide it in an HTML-comment-ish sequence users won't notice).
  const stamped = `${body}\n​[dedup:${dedupKey}]`;
  await query(
    `INSERT INTO notifications (user_id, type, icon, color, title, body)
     VALUES (?, 'automation_alert', ?, ?, ?, ?)`,
    [userId, icon, color, title, stamped]
  );
}

// ─── notify_low_balance ─────────────────────────────────────────────
// params: { accountId?, threshold }
// Scans cash / depository / other non-credit accounts. When accountId
// is set, only that one is watched.
registerAction("notify_low_balance", async (action, _context, userId) => {
  const threshold = Number(action?.params?.threshold);
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return { status: "skipped", summary: "No threshold set" };
  }
  const accountId = action?.params?.accountId
    ? Number(action.params.accountId) : null;
  const rows = await query(
    `SELECT id, name, balance FROM accounts
     WHERE user_id = ? AND type <> 'credit'
       ${accountId ? "AND id = ?" : ""}`,
    accountId ? [userId, accountId] : [userId]
  );
  let notified = 0;
  for (const a of rows) {
    if (Number(a.balance) >= threshold) continue;
    const dedupKey = `low_balance:${a.id}`;
    if (await alreadyNotified(userId, dedupKey)) continue;
    await insertAlert(userId, {
      title: `Low balance: ${a.name}`,
      body: `${a.name} is at $${Number(a.balance).toFixed(2)} — below your threshold of $${threshold.toFixed(2)}.`,
      dedupKey,
      color: "rose",
    });
    notified++;
  }
  if (notified === 0) return { status: "skipped", summary: "No accounts below threshold (or all deduped)" };
  return { status: "success", summary: `Alerted on ${notified} account${notified !== 1 ? "s" : ""}` };
});

// ─── notify_cc_utilization ──────────────────────────────────────────
// params: { accountId?, thresholdPct }
// Watches credit accounts. Skips accounts with NULL limit (can't
// compute a ratio). If accountId is set, only that card is checked.
registerAction("notify_cc_utilization", async (action, _context, userId) => {
  const thresholdPct = Math.max(1, Math.min(100, Number(action?.params?.thresholdPct) || 30));
  const accountId = action?.params?.accountId
    ? Number(action.params.accountId) : null;
  const rows = await query(
    `SELECT id, name, balance, limit_amount FROM accounts
     WHERE user_id = ? AND type = 'credit' AND limit_amount IS NOT NULL AND limit_amount > 0
       ${accountId ? "AND id = ?" : ""}`,
    accountId ? [userId, accountId] : [userId]
  );
  let notified = 0;
  for (const a of rows) {
    // Credit balances are stored as NEGATIVE amounts (see syncAccounts)
    // so utilization is |balance| / limit.
    const utilPct = (Math.abs(Number(a.balance)) / Number(a.limit_amount)) * 100;
    if (utilPct < thresholdPct) continue;
    const dedupKey = `cc_util:${a.id}`;
    if (await alreadyNotified(userId, dedupKey)) continue;
    await insertAlert(userId, {
      title: `Credit utilization: ${a.name}`,
      body: `${a.name} is at ${utilPct.toFixed(0)}% of its $${Number(a.limit_amount).toFixed(0)} limit (threshold: ${thresholdPct}%).`,
      dedupKey,
      color: "amber",
      icon: "CreditCard",
    });
    notified++;
  }
  if (notified === 0) return { status: "skipped", summary: "No cards above threshold (or all deduped)" };
  return { status: "success", summary: `Alerted on ${notified} card${notified !== 1 ? "s" : ""}` };
});

// ─── notify_scheduled_miss ──────────────────────────────────────────
// params: { graceDays (default 2) }
// Runs on daily_check. Finds is_scheduled=1 rows whose expected date
// was more than `graceDays` ago and haven't been adopted or marked
// arrived yet. Notifies once per row (dedup key = scheduled txn id +
// 7-day window so we don't nag daily).
registerAction("notify_scheduled_miss", async (action, _context, userId) => {
  const graceDays = Math.max(0, Math.min(30, Number(action?.params?.graceDays) || 2));
  const rows = await query(
    `SELECT id, merchant, date, amount, account_id
     FROM transactions
     WHERE user_id = ? AND is_scheduled = 1
       AND date < DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
    [userId, graceDays]
  );
  let notified = 0;
  for (const t of rows) {
    const dedupKey = `sched_miss:${t.id}`;
    // Longer dedup for scheduled-miss (7 days) so we don't nag daily
    // about a paycheck that's a week late.
    const already = await queryOne(
      `SELECT id FROM notifications
       WHERE user_id = ? AND body LIKE ?
         AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
       LIMIT 1`,
      [userId, `%[dedup:${dedupKey}]%`]
    );
    if (already) continue;
    await insertAlert(userId, {
      title: `Scheduled item hasn't arrived: ${t.merchant}`,
      body: `Expected $${Math.abs(Number(t.amount)).toFixed(2)} on ${String(t.date).slice(0, 10)} but nothing matching has been reported yet.`,
      dedupKey,
    });
    notified++;
  }
  if (notified === 0) return { status: "skipped", summary: "No overdue scheduled items" };
  return { status: "success", summary: `Flagged ${notified} overdue scheduled item${notified !== 1 ? "s" : ""}` };
});

// ─── notify_unusually_large_txn ─────────────────────────────────────
// params: { multiplier (default 3), lookbackDays (default 90) }
// Fires on transaction_arrived. Compares |amount| to the median of
// this merchant's past |amount|s over lookbackDays. Uses median for
// robustness against a single previous outlier. If we have fewer than
// 3 prior samples, skip — the ratio is too noisy to trust.
registerAction("notify_unusually_large_txn", async (action, context, userId) => {
  const txn = context?.transaction;
  if (!txn?.id) return { status: "skipped", summary: "No transaction in context" };
  const multiplier = Math.max(1.5, Math.min(20, Number(action?.params?.multiplier) || 3));
  const lookbackDays = Math.max(7, Math.min(365, Number(action?.params?.lookbackDays) || 90));
  const past = await query(
    `SELECT ABS(amount) AS abs_amount FROM transactions
     WHERE user_id = ? AND merchant = ? AND id <> ?
       AND date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       AND (is_scheduled = 0 OR is_scheduled IS NULL)
     ORDER BY ABS(amount) ASC`,
    [userId, txn.merchant, txn.id, lookbackDays]
  );
  if (past.length < 3) return { status: "skipped", summary: "Not enough merchant history yet" };
  const mid = Math.floor(past.length / 2);
  const median = past.length % 2 === 0
    ? (Number(past[mid - 1].abs_amount) + Number(past[mid].abs_amount)) / 2
    : Number(past[mid].abs_amount);
  const current = Math.abs(Number(txn.amount));
  if (current < median * multiplier) {
    return { status: "skipped", summary: `Below ${multiplier}× median (${median.toFixed(2)})` };
  }
  const dedupKey = `unusual_txn:${txn.id}`;
  if (await alreadyNotified(userId, dedupKey)) {
    return { status: "skipped", summary: "Already flagged" };
  }
  await insertAlert(userId, {
    title: `Unusually large: ${txn.merchant}`,
    body: `$${current.toFixed(2)} — ${(current / median).toFixed(1)}× the median $${median.toFixed(2)} you usually spend at ${txn.merchant}.`,
    dedupKey,
  });
  return { status: "success", summary: `Flagged: ${(current / median).toFixed(1)}× median` };
});

// Available action kinds (used by /vocab endpoint). Keep alphabetized
// so the picker shows a stable order.
export const ACTION_KINDS = [
  "add_note",
  "flag_duplicate",
  "mark_as_transfer",
  "notify_cc_utilization",
  "notify_low_balance",
  "notify_scheduled_miss",
  "notify_unusually_large_txn",
  "set_category",
  "split_txn",
];
