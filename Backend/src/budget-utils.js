import { query, queryOne } from "./db.js";

/**
 * Shared budget period math.
 *
 * The MASTER period — what every budget and the income tracker use — lives
 * on the user record (income_period, income_period_start, income_period_days).
 * Per-budget period columns still exist in the schema but are NOT consulted
 * when computing spent. This keeps the whole system on a single rhythm so
 * "this week's groceries", "this week's income", and "this week's allocation
 * total" all line up exactly.
 *
 * Periods:
 *   "weekly"       — resets every Sunday
 *   "biweekly"     — every 14 days from period_start
 *   "semimonthly"  — 1st and 15th
 *   "monthly"      — 1st of month (default)
 *   "yearly"       — Jan 1
 *   "custom"       — every period_days days from period_start
 */
/**
 * Parse a "YYYY-MM-DD" date string as LOCAL midnight of that day.
 *
 * Critical: `new Date("2026-05-19")` parses as UTC midnight which, in
 * negative-UTC zones (US Eastern is UTC-5), represents the EVENING of
 * May 18 locally. Subsequent `setHours(0,0,0,0)` then snaps it back to
 * local midnight of May 18 — silently shifting the anchor by a day.
 * This is the bug that caused "custom date resets to today" in practice.
 */
function parseLocalDate(s) {
  if (!s) return null;
  if (s instanceof Date) {
    // If the input Date looks like UTC midnight (zero UTC h/m/s), it was
    // almost certainly built from `new Date("YYYY-MM-DD")` — which is the
    // very footgun this helper exists to neutralise. Extract the intended
    // calendar day from UTC components so a US-Eastern caller doesn't get
    // bumped to the previous day. Otherwise treat it as a local-time Date
    // and use its local components.
    const isUtcMidnight =
      s.getUTCHours() === 0
      && s.getUTCMinutes() === 0
      && s.getUTCSeconds() === 0
      && s.getUTCMilliseconds() === 0;
    if (isUtcMidnight) {
      return new Date(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
    }
    return new Date(s.getFullYear(), s.getMonth(), s.getDate());
  }
  const str = String(s).slice(0, 10);
  const [y, m, d] = str.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d); // local midnight of the given date
}

export function currentPeriodBounds(period, periodStart, periodDays, nowDate) {
  const now = nowDate ? parseLocalDate(nowDate) || new Date(nowDate) : new Date();
  now.setHours(0, 0, 0, 0);
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();

  switch (period) {
    case "weekly": {
      const dow = now.getDay();
      const start = new Date(y, m, d - dow);
      const end = new Date(start); end.setDate(start.getDate() + 7);
      return { start, end };
    }
    case "biweekly": {
      const anchor = parseLocalDate(periodStart) || (() => {
        const a = new Date(now); a.setDate(d - now.getDay()); a.setHours(0,0,0,0); return a;
      })();
      const daysSince = Math.floor((now - anchor) / 86400000);
      const cyclesSince = Math.floor(daysSince / 14);
      const start = new Date(anchor); start.setDate(anchor.getDate() + cyclesSince * 14);
      const end = new Date(start); end.setDate(start.getDate() + 14);
      return { start, end };
    }
    case "semimonthly": {
      if (d >= 15) return { start: new Date(y, m, 15), end: new Date(y, m + 1, 1) };
      return { start: new Date(y, m, 1), end: new Date(y, m, 15) };
    }
    case "yearly":
      return { start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1) };
    case "custom": {
      const len = Math.max(1, Number(periodDays) || 30);
      const anchor = parseLocalDate(periodStart) || new Date(y, m, 1);
      const daysSince = Math.floor((now - anchor) / 86400000);
      const cyclesSince = Math.floor(daysSince / len);
      const start = new Date(anchor); start.setDate(anchor.getDate() + cyclesSince * len);
      const end = new Date(start); end.setDate(start.getDate() + len);
      return { start, end };
    }
    case "monthly":
    default:
      return { start: new Date(y, m, 1), end: new Date(y, m + 1, 1) };
  }
}

/**
 * Format a Date as "YYYY-MM-DD" using LOCAL components.
 *
 * Don't use `d.toISOString().slice(0, 10)` — that uses UTC components. For
 * a Date representing local-midnight-May-19 in a positive-UTC timezone
 * (e.g. UTC+5), the UTC date is actually May 18 → that's the date string
 * that would come out, which is wrong by a day for our period math.
 */
export function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/**
 * Resolve the master period for a user (the income tracker's settings).
 * All budgets use these bounds. If the user has never configured an
 * income period, defaults to monthly.
 */
export async function getMasterPeriod(userId, nowDate) {
  const u = await queryOne(
    `SELECT income_period, income_period_start, income_period_days
     FROM users WHERE id = ?`,
    [userId]
  );
  const period = u?.income_period || "monthly";
  const periodStart = u?.income_period_start || null;
  const periodDays = u?.income_period_days || null;
  const bounds = currentPeriodBounds(period, periodStart, periodDays, nowDate);
  return {
    period, periodStart, periodDays,
    start: bounds.start, end: bounds.end,
    startStr: isoDate(bounds.start),
    endStr: isoDate(bounds.end),
  };
}

/**
 * Walk N periods back from a reference date. Returns an array of
 * { start, end } in chronological order (oldest first).
 *
 *   count=1 → just the current period
 *   count=5 → current + 4 past periods
 */
export function getPastPeriods(period, periodStart, periodDays, count, nowDate) {
  const result = [];
  let cursor = currentPeriodBounds(period, periodStart, periodDays, nowDate);
  for (let i = 0; i < count; i++) {
    result.push({ start: cursor.start, end: cursor.end });
    // Step one calendar day before this period's start; that day belongs to
    // the previous period, so currentPeriodBounds(...) will return the prior
    // one. Use Y/M/D constructor rather than `start.getTime() - 86400000` —
    // subtracting raw milliseconds shifts by 23h or 25h across DST
    // transitions, which can land us in the wrong calendar day.
    const s = cursor.start;
    const dayBefore = new Date(s.getFullYear(), s.getMonth(), s.getDate() - 1);
    cursor = currentPeriodBounds(period, periodStart, periodDays, dayBefore);
  }
  // Reverse so oldest is first
  return result.reverse();
}

/**
 * Spent within an explicit period window. The CALLER supplies the bounds
 * (typically from getMasterPeriod). Account-scoped budgets sum that
 * account's expenses; category budgets exclude credit-card accounts.
 */
export async function spentForBudgetInWindow(userId, b, startStr, endStr) {
  if (b.account_id) {
    const row = await queryOne(
      `SELECT COALESCE(SUM(ABS(t.amount)), 0) AS spent
       FROM transactions t
       WHERE t.user_id = ? AND t.account_id = ? AND t.amount < 0
         AND t.date >= ? AND t.date < ?`,
      [userId, b.account_id, startStr, endStr]
    );
    return Number(row.spent) || 0;
  }
  const row = await queryOne(
    `SELECT COALESCE(SUM(ABS(t.amount)), 0) AS spent
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.user_id = ? AND t.category = ? AND t.amount < 0
       AND t.date >= ? AND t.date < ?
       AND (a.type IS NULL OR a.type <> 'credit')`,
    [userId, b.category, startStr, endStr]
  );
  return Number(row.spent) || 0;
}

/**
 * Backwards-compat: callers that just want "current spent" using the master
 * period. New code should use spentForBudgetInWindow with explicit bounds.
 */
export async function spentForBudget(userId, b) {
  const master = await getMasterPeriod(userId);
  return spentForBudgetInWindow(userId, b, master.startStr, master.endStr);
}

/**
 * Append a snapshot row to budget_audit. Action is 'create' | 'update' |
 * 'delete'. The snapshot captures the full state after the change (or, for
 * deletes, the state immediately before deletion). The audit table is what
 * GET /budgets/history reads to reconstruct each past period accurately,
 * including amount edits that happened after the period closed.
 */
export async function logBudgetAudit(userId, budgetId, action, snapshot) {
  await query(
    `INSERT INTO budget_audit
       (user_id, budget_id, category, amount, period, period_start,
        period_days, account_id, action)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId, budgetId,
      snapshot.category,
      snapshot.amount ?? null,
      snapshot.period ?? null,
      snapshot.period_start ?? null,
      snapshot.period_days ?? null,
      snapshot.account_id ?? null,
      action,
    ]
  );
}

/**
 * For each budget id given, return the latest budget_audit snapshot with
 * effective_at < endTs. Snapshots whose latest action is 'delete' (i.e. the
 * budget had been deleted by then) are filtered out. Used by the history
 * endpoint to render each past period with the cap/category that were
 * actually in effect at the time, not the live row.
 *
 * Returns Map<budgetId, snapshotRow>. Budgets with no qualifying audit row
 * (either created later, or deleted by then) won't appear in the map.
 */
export async function getBudgetSnapshotsAsOf(userId, endTs) {
  // Latest audit per budget for this user, capped at endTs. We rank rows
  // within each budget by (effective_at DESC, id DESC) so the id break-ties
  // when two audits land in the same TIMESTAMP(3) tick (e.g. rapid edits).
  const rows = await query(
    `SELECT * FROM (
       SELECT ba.*,
              ROW_NUMBER() OVER (
                PARTITION BY ba.budget_id
                ORDER BY ba.effective_at DESC, ba.id DESC
              ) AS rn
       FROM budget_audit ba
       WHERE ba.user_id = ? AND ba.effective_at < ?
     ) ranked
     WHERE ranked.rn = 1`,
    [userId, endTs]
  );
  const map = new Map();
  for (const r of rows) {
    if (r.action === "delete") continue;
    map.set(r.budget_id, r);
  }
  return map;
}
