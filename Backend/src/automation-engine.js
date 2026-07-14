// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "./db.js";

/**
 * Per-user rule engine.
 *
 * A rule is:
 *   { id, name, trigger_type, conditions: [{field, op, value}], actions: [{kind, params}] }
 *
 * The engine is invoked from four places:
 *   - sync.js after transactions land           → trigger "transaction_arrived"
 *                                                 (or "income_landed" when amount > 0)
 *   - budgets.js when a period is detected as rolled over
 *                                               → trigger "period_rolled_over"
 *   - worker.js daily cron                      → trigger "daily_check"
 *   - transactions.js after manual create/edit if the txn is user-authored
 *                                               → trigger "transaction_arrived" (same path)
 *
 * Rule evaluation is strictly per-user. First matching rule wins for any
 * given event (user-defined sort_order), matching the way email filters
 * work — that keeps the mental model simple. The order can be reshuffled
 * by drag, and a "Recommended order" button offers a heuristic sort.
 *
 * Every fire is recorded in automation_history with status:
 *   success  → rule matched and its actions completed
 *   error    → rule matched but an action threw
 *   skipped  → rule matched but preconditions in the action prevented it
 *              (e.g. round-up to a goal that no longer exists)
 *
 * Errors ALSO set transactions.has_automation_error = TRUE when the event
 * was tied to a transaction. That flag is what surfaces the red pill on
 * the txn row; clearing it requires the user to Acknowledge in the
 * Automation history page.
 *
 * NOTHING here writes to audit_log. Personal automations stay out of the
 * admin/security audit trail per user requirement.
 */

// Action registry — filled in by later stages. Keeping this empty in the
// foundation stage means the engine wiring is fully testable end-to-end
// (rules save, fire, log a "skipped" entry) without needing all 20+
// actions plumbed at once. Each action module exports:
//   async run(action, context, userId) → { status, summary } | throws
const ACTIONS = new Map();
export function registerAction(kind, handler) {
  if (ACTIONS.has(kind)) {
    throw new Error(`automation-engine: action "${kind}" already registered`);
  }
  ACTIONS.set(kind, handler);
}

// Condition evaluators. Same rationale as ACTIONS — expand in later stages.
// Each entry: (fieldExtractor, opFn) → bool
// `context` shape varies by trigger; conditions are declared in terms of
// the DECLARED fields for that trigger (validated at rule save time).
const OPS = {
  eq:      (a, b) => String(a).toLowerCase() === String(b).toLowerCase(),
  neq:     (a, b) => String(a).toLowerCase() !== String(b).toLowerCase(),
  contains:(a, b) => String(a).toLowerCase().includes(String(b).toLowerCase()),
  gt:      (a, b) => Number(a) >  Number(b),
  gte:     (a, b) => Number(a) >= Number(b),
  lt:      (a, b) => Number(a) <  Number(b),
  lte:     (a, b) => Number(a) <= Number(b),
  in:      (a, b) => Array.isArray(b) && b.some(v => String(v).toLowerCase() === String(a).toLowerCase()),
};

// Field extractors per trigger. `context` is whatever the trigger site
// passed in — usually a transaction row for txn-shaped triggers. If we
// ever add a "budget" or "account" trigger, that field set expands here.
const FIELDS = {
  merchant:   ctx => ctx?.transaction?.merchant,
  category:   ctx => ctx?.transaction?.category,
  amount:     ctx => Number(ctx?.transaction?.amount || 0),
  absAmount:  ctx => Math.abs(Number(ctx?.transaction?.amount || 0)),
  accountId:  ctx => ctx?.transaction?.account_id,
  accountType:ctx => ctx?.transaction?.account_type,
  pending:    ctx => ctx?.transaction?.pending ? 1 : 0,
  isTransfer: ctx => ctx?.transaction?.is_transfer ? 1 : 0,
  weekday:    ctx => new Date(ctx?.transaction?.date || Date.now()).getDay(),
};

function evalOne({ field, op, value }, context) {
  const extractor = FIELDS[field];
  const fn = OPS[op];
  if (!extractor || !fn) return false;
  return fn(extractor(context), value);
}

/**
 * Load enabled rules for one user + trigger, in user-defined order.
 * Parses conditions/actions from JSON strings (defensive on malformed
 * blobs — a rule with unparseable JSON is skipped rather than 500'ing
 * the whole sync).
 */
async function loadRules(userId, triggerType) {
  const rows = await query(
    `SELECT id, name, trigger_type, conditions, actions
     FROM automation_rules
     WHERE user_id = ? AND trigger_type = ? AND enabled = 1
     ORDER BY sort_order ASC, id ASC`,
    [userId, triggerType]
  );
  const out = [];
  for (const r of rows) {
    try {
      out.push({
        id: r.id,
        name: r.name,
        trigger_type: r.trigger_type,
        conditions: r.conditions ? JSON.parse(r.conditions) : [],
        actions:    r.actions    ? JSON.parse(r.actions)    : [],
      });
    } catch { /* malformed rule — skip */ }
  }
  return out;
}

async function logHistory(userId, rule, entry) {
  await query(
    `INSERT INTO automation_history
       (user_id, rule_id, rule_name, status, summary, error_message,
        transaction_id, budget_id, goal_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      rule?.id || null,
      rule?.name || null,
      entry.status,
      (entry.summary || "").slice(0, 255),
      entry.errorMessage ? String(entry.errorMessage).slice(0, 4000) : null,
      entry.transactionId || null,
      entry.budgetId || null,
      entry.goalId || null,
    ]
  );
}

/**
 * Fire the pipeline for a single trigger event. First matching rule wins.
 *
 * Wraps every action in try/catch:
 *   - success → log a success row
 *   - throw   → log an error row AND flag the transaction (if any)
 *
 * Returns a small summary the caller can use for diagnostic logs. Never
 * throws — automation failures should never break sync itself.
 */
export async function runRulesForTrigger(userId, triggerType, context = {}) {
  let rules;
  try { rules = await loadRules(userId, triggerType); }
  catch { return { fired: 0, errors: 0 }; }
  if (!rules.length) return { fired: 0, errors: 0 };

  let fired = 0, errors = 0;
  for (const rule of rules) {
    const matches = (rule.conditions || []).every(c => evalOne(c, context));
    if (!matches) continue;
    for (const action of rule.actions || []) {
      const handler = ACTIONS.get(action.kind);
      if (!handler) {
        // Unknown action kind — treat as skipped, not error. Keeps rules
        // forward-compatible with newer engine versions than the running
        // deploy (e.g. after a partial rollback).
        await logHistory(userId, rule, {
          status: "skipped",
          summary: `Unknown action "${action.kind}"`,
          transactionId: context?.transaction?.id,
        });
        continue;
      }
      try {
        // Actions can key on rule identity for per-rule per-period
        // dedup (e.g. move_budget_slack only wants to fire once per
        // budget period per rule). Add non-enumerable-ish _rule so
        // it doesn't clash with any field extractor names.
        const res = await handler(action, { ...context, _rule: rule }, userId);
        await logHistory(userId, rule, {
          status: res?.status || "success",
          summary: res?.summary || `${action.kind} ran`,
          transactionId: context?.transaction?.id,
          budgetId: res?.budgetId,
          goalId:   res?.goalId,
        });
        fired++;
      } catch (err) {
        errors++;
        await logHistory(userId, rule, {
          status: "error",
          summary: `${action.kind} failed`,
          errorMessage: err?.message || String(err),
          transactionId: context?.transaction?.id,
        });
        if (context?.transaction?.id) {
          await query(
            "UPDATE transactions SET has_automation_error = 1 WHERE id = ? AND user_id = ?",
            [context.transaction.id, userId]
          );
        }
      }
    }
    // First matching rule wins.
    break;
  }
  return { fired, errors };
}

// Available triggers, exported so the routes can validate rule bodies.
export const TRIGGER_TYPES = [
  "transaction_arrived",
  "income_landed",
  "period_rolled_over",
  "daily_check",
  "balance_changed",
];

// Available fields + ops for the rule builder UI. Frontend renders
// dropdowns from these; server also uses the same list to validate.
export const RULE_VOCAB = {
  fields: Object.keys(FIELDS),
  ops:    Object.keys(OPS),
};
