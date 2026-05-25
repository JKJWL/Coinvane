import { query, queryOne } from "./db.js";

/**
 * Shared budget period math. Used by both the budgets route (for display)
 * and the notification engine (for "you went over budget" detection).
 *
 * Periods:
 *   "weekly"       — resets every Sunday
 *   "biweekly"     — every 14 days from period_start
 *   "semimonthly"  — 1st and 15th
 *   "monthly"      — 1st of month (default)
 *   "yearly"       — Jan 1
 *   "custom"       — every period_days days from period_start
 */
export function currentPeriodBounds(period, periodStart, periodDays, nowDate) {
  const now = nowDate ? new Date(nowDate) : new Date();
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
      const anchor = periodStart ? new Date(periodStart) : (() => {
        const a = new Date(now); a.setDate(d - now.getDay()); return a;
      })();
      anchor.setHours(0, 0, 0, 0);
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
      const anchor = periodStart ? new Date(periodStart) : new Date(y, m, 1);
      anchor.setHours(0, 0, 0, 0);
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

export function isoDate(d) { return d.toISOString().slice(0, 10); }

/**
 * Returns spent amount for a budget within its current period.
 * Account-scoped budgets sum that account's expenses.
 * Category budgets sum that category's expenses EXCLUDING credit-card accounts.
 */
export async function spentForBudget(userId, b) {
  const { start, end } = currentPeriodBounds(b.period, b.period_start, b.period_days);
  if (b.account_id) {
    const row = await queryOne(
      `SELECT COALESCE(SUM(ABS(t.amount)), 0) AS spent
       FROM transactions t
       WHERE t.user_id = ? AND t.account_id = ? AND t.amount < 0
         AND t.date >= ? AND t.date < ?`,
      [userId, b.account_id, isoDate(start), isoDate(end)]
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
    [userId, b.category, isoDate(start), isoDate(end)]
  );
  return Number(row.spent) || 0;
}
