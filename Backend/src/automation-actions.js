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
import {
  getMasterPeriod,
  spentForBudgetInWindow,
} from "./budget-utils.js";

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

// ═══ Stage 4: budget rules ═══════════════════════════════════════════
//
// All four actions manipulate budgets.rollover_credit — a per-period
// adjustment layered on top of the budget's standing amount. The
// EFFECTIVE cap presented to the user (and used everywhere spending is
// compared) is amount + rollover_credit. See migrate.js comment for
// the model rationale.
//
// Nothing in this stage auto-resets rollover_credit — if a user only
// uses seasonal_bump without rollover_unused_budget, credits stack
// forever, which is legitimate ("December is always +$300 for
// groceries"). Users who want reset semantics add
// rollover_unused_budget with the appropriate maxRollover.

// Fetch budgets for an action, honoring an optional single-budget scope.
async function fetchScopedBudgets(userId, budgetId) {
  return budgetId
    ? await query(
        `SELECT id, category, amount, rollover_credit, account_id
         FROM budgets WHERE id = ? AND user_id = ?`,
        [budgetId, userId]
      )
    : await query(
        `SELECT id, category, amount, rollover_credit, account_id
         FROM budgets WHERE user_id = ?`,
        [userId]
      );
}

// ─── rollover_unused_budget ─────────────────────────────────────────
// Fires on period_rolled_over. For each in-scope budget, computes
// leftover for the period that just ended and SETS rollover_credit to
// that value (clamped to [0, maxRollover]). "Sets" not "adds" because
// on subsequent periods where nothing was left over we still want the
// old credit to drop.
registerAction("rollover_unused_budget", async (action, context, userId) => {
  const budgetId = action?.params?.budgetId ? Number(action.params.budgetId) : null;
  const maxRollover = Number.isFinite(Number(action?.params?.maxRollover))
    && Number(action.params.maxRollover) > 0
      ? Number(action.params.maxRollover)
      : Number.POSITIVE_INFINITY;
  const prevStart = context?.previousPeriodStart;
  const prevEnd   = context?.previousPeriodEnd;
  if (!prevStart || !prevEnd) {
    return { status: "skipped", summary: "No previous period bounds in context" };
  }
  const budgets = await fetchScopedBudgets(userId, budgetId);
  if (budgets.length === 0) return { status: "skipped", summary: "No budgets in scope" };
  let updated = 0;
  for (const b of budgets) {
    const spent = await spentForBudgetInWindow(userId, b, prevStart, prevEnd);
    const effectiveCap = Number(b.amount) + Number(b.rollover_credit);
    const leftover = effectiveCap - spent;
    const newCredit = Math.max(0, Math.min(leftover, maxRollover));
    if (Math.abs(newCredit - Number(b.rollover_credit)) < 0.01) continue;
    await query(
      "UPDATE budgets SET rollover_credit = ? WHERE id = ? AND user_id = ?",
      [Number(newCredit.toFixed(2)), b.id, userId]
    );
    updated++;
  }
  return {
    status: "success",
    summary: updated === 0
      ? "No budgets needed a rollover change"
      : `Rolled over on ${updated} budget${updated !== 1 ? "s" : ""}`,
  };
});

// ─── seasonal_bump ──────────────────────────────────────────────────
// Fires on period_rolled_over. If the new period's START MONTH matches
// `monthNumber` (1-12), ADD `bumpAmount` to the target budget's
// rollover_credit. Runs at most once per period boundary per rule
// (period_rolled_over itself only fires once per boundary).
registerAction("seasonal_bump", async (action, context, userId) => {
  const budgetId    = Number(action?.params?.budgetId);
  const monthNumber = Number(action?.params?.monthNumber);
  const bumpAmount  = Number(action?.params?.bumpAmount);
  if (!budgetId || !monthNumber || !Number.isFinite(bumpAmount) || bumpAmount <= 0) {
    return { status: "skipped", summary: "Missing or invalid params" };
  }
  const currentStart = context?.currentPeriodStart;
  if (!currentStart) return { status: "skipped", summary: "No current period bounds in context" };
  const currentMonth = Number(String(currentStart).slice(5, 7));
  if (currentMonth !== monthNumber) {
    return { status: "skipped", summary: `Not month ${monthNumber} (current is ${currentMonth})` };
  }
  const owned = await queryOne(
    "SELECT id, category, rollover_credit FROM budgets WHERE id = ? AND user_id = ?",
    [budgetId, userId]
  );
  if (!owned) return { status: "skipped", summary: "Target budget not found" };
  await query(
    "UPDATE budgets SET rollover_credit = rollover_credit + ? WHERE id = ? AND user_id = ?",
    [bumpAmount, budgetId, userId]
  );
  return {
    status: "success",
    summary: `Bumped "${owned.category}" by $${bumpAmount.toFixed(2)} for month ${monthNumber}`,
    budgetId,
  };
});

// ─── burn_rate_alarm ────────────────────────────────────────────────
// Fires on daily_check. When (elapsed% of period) >= timeElapsedThresholdPct
// AND (spent% of effective cap) >= warnPct, drops a notification.
// Dedup key includes the period start so a fresh period gets a fresh
// alert (rather than the previous period's suppressing it).
registerAction("burn_rate_alarm", async (action, _context, userId) => {
  const budgetId = action?.params?.budgetId ? Number(action.params.budgetId) : null;
  const warnPct = Math.max(1, Math.min(100, Number(action?.params?.warnPct) || 80));
  const timeElapsedThresholdPct =
    Math.max(1, Math.min(100, Number(action?.params?.timeElapsedThresholdPct) || 50));

  const master = await getMasterPeriod(userId);
  const totalMs = master.end - master.start;
  const elapsedMs = Math.max(0, Date.now() - master.start);
  const elapsedPct = totalMs > 0 ? (elapsedMs / totalMs) * 100 : 100;
  if (elapsedPct < timeElapsedThresholdPct) {
    return { status: "skipped", summary: "Not enough of period elapsed yet" };
  }

  const budgets = await fetchScopedBudgets(userId, budgetId);
  if (budgets.length === 0) return { status: "skipped", summary: "No budgets in scope" };
  let alerted = 0;
  for (const b of budgets) {
    const spent = await spentForBudgetInWindow(userId, b, master.startStr, master.endStr);
    const cap = Number(b.amount) + Number(b.rollover_credit);
    if (cap <= 0) continue;
    const spentPct = (spent / cap) * 100;
    if (spentPct < warnPct) continue;
    const dedupKey = `burn_rate:${b.id}:${master.startStr}`;
    if (await alreadyNotified(userId, dedupKey)) continue;
    await insertAlert(userId, {
      title: `Burn rate: ${b.category}`,
      body:
        `${spentPct.toFixed(0)}% spent with ${(100 - elapsedPct).toFixed(0)}% ` +
        `of the period left. On pace to exceed $${cap.toFixed(2)}.`,
      dedupKey,
      color: "amber",
    });
    alerted++;
  }
  return {
    status: alerted > 0 ? "success" : "skipped",
    summary: alerted > 0
      ? `Alerted on ${alerted} budget${alerted !== 1 ? "s" : ""}`
      : "No budgets over the burn-rate threshold",
  };
});

// ─── move_budget_slack ──────────────────────────────────────────────
// Fires on daily_check. Once per master period per rule.
// If the source budget's spent% is below sourceMaxUsedPct AND the
// target budget is over cap (spent > effective cap), move `amount`
// (clamped to source's available slack) from source's rollover_credit
// to target's rollover_credit.
registerAction("move_budget_slack", async (action, context, userId) => {
  const sourceBudgetId    = Number(action?.params?.sourceBudgetId);
  const targetBudgetId    = Number(action?.params?.targetBudgetId);
  const moveAmount        = Number(action?.params?.amount);
  const sourceMaxUsedPct  = Math.max(1, Math.min(100,
    Number(action?.params?.sourceMaxUsedPct) || 40));
  const requireTargetOver = action?.params?.requireTargetOver !== false; // default true

  if (!sourceBudgetId || !targetBudgetId ||
      !Number.isFinite(moveAmount) || moveAmount <= 0) {
    return { status: "skipped", summary: "Missing or invalid params" };
  }
  if (sourceBudgetId === targetBudgetId) {
    return { status: "skipped", summary: "Source and target must differ" };
  }

  const master = await getMasterPeriod(userId);
  const ruleId = context?._rule?.id;

  // Per-rule per-period dedup — if this rule already recorded a
  // successful fire in the current period, skip. This is the ONE
  // Stage 4 action that would otherwise fire daily and drain the
  // source budget dry.
  if (ruleId) {
    const already = await queryOne(
      `SELECT id FROM automation_history
       WHERE user_id = ? AND rule_id = ? AND status = 'success'
         AND fired_at >= ?
       LIMIT 1`,
      [userId, ruleId, `${master.startStr} 00:00:00`]
    );
    if (already) return { status: "skipped", summary: "Already moved this period" };
  }

  const source = await queryOne(
    "SELECT id, category, amount, rollover_credit FROM budgets WHERE id = ? AND user_id = ?",
    [sourceBudgetId, userId]
  );
  const target = await queryOne(
    "SELECT id, category, amount, rollover_credit FROM budgets WHERE id = ? AND user_id = ?",
    [targetBudgetId, userId]
  );
  if (!source || !target) return { status: "skipped", summary: "Budget not found" };

  const sourceSpent = await spentForBudgetInWindow(userId, source, master.startStr, master.endStr);
  const sourceCap = Number(source.amount) + Number(source.rollover_credit);
  const sourceUsedPct = sourceCap > 0 ? (sourceSpent / sourceCap) * 100 : 100;
  if (sourceUsedPct >= sourceMaxUsedPct) {
    return { status: "skipped", summary: `Source at ${sourceUsedPct.toFixed(0)}% — not underused enough` };
  }
  const sourceAvailable = sourceCap - sourceSpent;
  if (sourceAvailable < 0.01) return { status: "skipped", summary: "No slack available in source" };

  if (requireTargetOver) {
    const targetSpent = await spentForBudgetInWindow(userId, target, master.startStr, master.endStr);
    const targetCap = Number(target.amount) + Number(target.rollover_credit);
    if (targetSpent <= targetCap) {
      return { status: "skipped", summary: "Target not over cap yet" };
    }
  }

  const actualMove = Math.min(moveAmount, sourceAvailable);
  await query(
    "UPDATE budgets SET rollover_credit = rollover_credit - ? WHERE id = ? AND user_id = ?",
    [Number(actualMove.toFixed(2)), sourceBudgetId, userId]
  );
  await query(
    "UPDATE budgets SET rollover_credit = rollover_credit + ? WHERE id = ? AND user_id = ?",
    [Number(actualMove.toFixed(2)), targetBudgetId, userId]
  );
  return {
    status: "success",
    summary: `Moved $${actualMove.toFixed(2)} from "${source.category}" to "${target.category}"`,
    budgetId: targetBudgetId,
  };
});

// ═══ Stage 5: savings rules ══════════════════════════════════════════
//
// All four actions push money to a goal by incrementing goals.saved
// directly. Account-linked goals (goal.account_id IS NOT NULL) are
// SKIPPED — their "saved" is derived from the linked account's balance
// so any direct write would just be overwritten on next refresh, which
// silently swallows the automation. The user is told why via the
// history summary so it's not a mystery.
//
// Contribution amounts round to cents. If a computed contribution
// falls below $0.01 the action skips rather than writing a zero row.

// Resolve a target goal by id + owner, returning null with a reason
// string if it's missing, foreign-owned, or account-linked.
async function fetchTargetGoal(userId, goalId) {
  if (!goalId) return { goal: null, reason: "No goal selected" };
  const g = await queryOne(
    `SELECT id, name, saved, target, account_id
     FROM goals WHERE id = ? AND user_id = ?`,
    [Number(goalId), userId]
  );
  if (!g) return { goal: null, reason: "Goal not found" };
  if (g.account_id) {
    return {
      goal: null,
      reason: "Goal is account-linked — automation contributions unsupported (balance is authoritative)",
    };
  }
  return { goal: g, reason: null };
}

// Add cents to a goal. Caller has already validated ownership + amount.
async function creditGoal(userId, goalId, amount) {
  await query(
    "UPDATE goals SET saved = saved + ? WHERE id = ? AND user_id = ?",
    [Number(Number(amount).toFixed(2)), goalId, userId]
  );
}

// ─── contribute_to_goal_pct ─────────────────────────────────────────
// Trigger: income_landed. Contributes pct% of the income transaction
// amount to a goal. Skips transfers (income_landed already filters, but
// defensive check).
registerAction("contribute_to_goal_pct", async (action, context, userId) => {
  const txn = context?.transaction;
  if (!txn?.id) return { status: "skipped", summary: "No transaction in context" };
  if (Number(txn.amount) <= 0) return { status: "skipped", summary: "Not income (amount ≤ 0)" };
  if (txn.is_transfer) return { status: "skipped", summary: "Skipping transfer" };
  const pct = Math.max(0.1, Math.min(100, Number(action?.params?.pct) || 10));
  const { goal, reason } = await fetchTargetGoal(userId, action?.params?.goalId);
  if (!goal) return { status: "skipped", summary: reason };
  const contribution = Number(txn.amount) * (pct / 100);
  if (contribution < 0.01) return { status: "skipped", summary: "Contribution below $0.01" };
  await creditGoal(userId, goal.id, contribution);
  return {
    status: "success",
    summary: `Contributed $${contribution.toFixed(2)} (${pct}%) to "${goal.name}"`,
    goalId: goal.id,
  };
});

// ─── round_up_to_goal ───────────────────────────────────────────────
// Trigger: transaction_arrived. For each expense, computes
// ceil(|amount| / roundTo) * roundTo - |amount| and adds that delta to
// the goal. Skips transfers, scheduled (defense-in-depth), and any
// row that's already exactly a multiple of roundTo. Non-credit accounts
// only — the classic round-up feature matches physical debit-card usage
// and treating card swipes as sources would double-count when the CC
// payment lands.
registerAction("round_up_to_goal", async (action, context, userId) => {
  const txn = context?.transaction;
  if (!txn?.id) return { status: "skipped", summary: "No transaction in context" };
  if (Number(txn.amount) >= 0) return { status: "skipped", summary: "Not an expense" };
  if (txn.is_transfer) return { status: "skipped", summary: "Skipping transfer" };
  if (txn.account_type === "credit") return { status: "skipped", summary: "Skipping credit-card expense" };
  const roundTo = Math.max(0.25, Math.min(100, Number(action?.params?.roundTo) || 1));
  const abs = Math.abs(Number(txn.amount));
  const roundedUp = Math.ceil(abs / roundTo) * roundTo;
  const delta = roundedUp - abs;
  if (delta < 0.01) return { status: "skipped", summary: "Already at round multiple" };
  const { goal, reason } = await fetchTargetGoal(userId, action?.params?.goalId);
  if (!goal) return { status: "skipped", summary: reason };
  await creditGoal(userId, goal.id, delta);
  return {
    status: "success",
    summary: `Round-up: $${delta.toFixed(2)} to "${goal.name}"`,
    goalId: goal.id,
  };
});

// ─── sweep_to_goal ──────────────────────────────────────────────────
// Trigger: income_landed. Fixed-dollar version of contribute_to_goal_pct
// — after every income transaction, move `amount` to a goal. Skipped
// when the incoming income is smaller than the sweep amount so we don't
// dip a paycheck negative from an over-eager sweep.
registerAction("sweep_to_goal", async (action, context, userId) => {
  const txn = context?.transaction;
  if (!txn?.id) return { status: "skipped", summary: "No transaction in context" };
  if (Number(txn.amount) <= 0) return { status: "skipped", summary: "Not income" };
  if (txn.is_transfer) return { status: "skipped", summary: "Skipping transfer" };
  const amount = Number(action?.params?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { status: "skipped", summary: "Invalid sweep amount" };
  }
  if (Number(txn.amount) < amount) {
    return { status: "skipped", summary: `Income $${Number(txn.amount).toFixed(2)} less than sweep $${amount.toFixed(2)}` };
  }
  const { goal, reason } = await fetchTargetGoal(userId, action?.params?.goalId);
  if (!goal) return { status: "skipped", summary: reason };
  await creditGoal(userId, goal.id, amount);
  return {
    status: "success",
    summary: `Swept $${amount.toFixed(2)} from paycheck to "${goal.name}"`,
    goalId: goal.id,
  };
});

// ─── sweep_excess_income ────────────────────────────────────────────
// Trigger: period_rolled_over. Computes (income received last period) -
// (sum of category-budget caps including rollover_credit at time of
// firing). Positive delta is swept to the goal, capped by maxSweep.
// Non-credit accounts, non-transfer, non-scheduled — same filter every
// budget/income rollup uses so the calculation lines up with what the
// user sees on the Budgets tab.
registerAction("sweep_excess_income", async (action, context, userId) => {
  const prevStart = context?.previousPeriodStart;
  const prevEnd   = context?.previousPeriodEnd;
  if (!prevStart || !prevEnd) {
    return { status: "skipped", summary: "No previous period bounds in context" };
  }
  const maxSweep = Number.isFinite(Number(action?.params?.maxSweep))
    && Number(action.params.maxSweep) > 0
      ? Number(action.params.maxSweep)
      : Number.POSITIVE_INFINITY;
  const { goal, reason } = await fetchTargetGoal(userId, action?.params?.goalId);
  if (!goal) return { status: "skipped", summary: reason };
  const incomeRow = await queryOne(
    `SELECT COALESCE(SUM(t.amount), 0) AS total
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.user_id = ? AND t.amount > 0
       AND t.date >= ? AND t.date < ?
       AND (a.type IS NULL OR a.type <> 'credit')
       AND (t.is_transfer = 0 OR t.is_transfer IS NULL)
       AND (t.is_scheduled = 0 OR t.is_scheduled IS NULL)`,
    [userId, prevStart, prevEnd]
  );
  const income = Number(incomeRow.total) || 0;
  const allocRow = await queryOne(
    `SELECT COALESCE(SUM(amount + COALESCE(rollover_credit, 0)), 0) AS total
     FROM budgets WHERE user_id = ? AND account_id IS NULL`,
    [userId]
  );
  const allocated = Number(allocRow.total) || 0;
  const excess = income - allocated;
  if (excess <= 0) {
    return {
      status: "skipped",
      summary: `No excess (income $${income.toFixed(2)}, allocated $${allocated.toFixed(2)})`,
    };
  }
  const sweep = Math.min(excess, maxSweep);
  await creditGoal(userId, goal.id, sweep);
  return {
    status: "success",
    summary: `Swept $${sweep.toFixed(2)} excess income to "${goal.name}"`,
    goalId: goal.id,
  };
});

// Available action kinds (used by /vocab endpoint). Keep alphabetized
// so the picker shows a stable order.
export const ACTION_KINDS = [
  "add_note",
  "burn_rate_alarm",
  "contribute_to_goal_pct",
  "flag_duplicate",
  "mark_as_transfer",
  "move_budget_slack",
  "notify_cc_utilization",
  "notify_low_balance",
  "notify_scheduled_miss",
  "notify_unusually_large_txn",
  "rollover_unused_budget",
  "round_up_to_goal",
  "seasonal_bump",
  "set_category",
  "split_txn",
  "sweep_excess_income",
  "sweep_to_goal",
];
