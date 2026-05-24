import { query, queryOne } from "../db.js";

/**
 * Budget period model
 * ────────────────────
 * Each budget has one of these period kinds:
 *
 *   "weekly"       — resets every Sunday
 *   "biweekly"     — resets every 14 days from period_start (defaults to last Sunday)
 *   "semimonthly"  — resets on the 1st and 15th of each month
 *   "monthly"      — resets on the 1st of each month  (default; back-compat)
 *   "yearly"       — resets January 1
 *   "custom"       — resets every period_days days, starting from period_start
 *
 * Account-based budgets (Feature 5):
 * When account_id is set, the budget tracks spending on that specific account
 * (typically a credit card) regardless of category. This lets you cap usage on
 * "My Discover card" e.g. at $1,500/month.
 *
 * Category-based budgets EXCLUDE credit-card transactions to avoid double-
 * counting (the swipe + the eventual CC payment shouldn't both hit the budget).
 */

function currentPeriodBounds(period, periodStart, periodDays, nowDate) {
  const now = nowDate ? new Date(nowDate) : new Date();
  now.setHours(0, 0, 0, 0);
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();

  switch (period) {
    case "weekly": {
      // Reset on Sunday
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
      if (d >= 15) {
        return { start: new Date(y, m, 15), end: new Date(y, m + 1, 1) };
      }
      return { start: new Date(y, m, 1), end: new Date(y, m, 15) };
    }
    case "yearly": {
      return { start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1) };
    }
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

function isoDate(d) { return d.toISOString().slice(0, 10); }

/**
 * Calculate spent for one budget within its current period.
 *
 * - account_id set  → sum |amount| of all expenses on that account
 * - account_id null → sum |amount| of expenses in that category,
 *                     EXCLUDING credit-card account transactions
 */
async function spentForBudget(userId, budget) {
  const { start, end } = currentPeriodBounds(
    budget.period, budget.period_start, budget.period_days
  );

  if (budget.account_id) {
    const row = await queryOne(
      `SELECT COALESCE(SUM(ABS(t.amount)), 0) AS spent
       FROM transactions t
       WHERE t.user_id = ? AND t.account_id = ? AND t.amount < 0
         AND t.date >= ? AND t.date < ?`,
      [userId, budget.account_id, isoDate(start), isoDate(end)]
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
    [userId, budget.category, isoDate(start), isoDate(end)]
  );
  return Number(row.spent) || 0;
}

export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (req) => {
    const budgets = await query(
      `SELECT b.id, b.category, b.amount, b.period, b.period_start, b.period_days,
              b.account_id AS accountId, a.name AS accountName, a.type AS accountType
       FROM budgets b
       LEFT JOIN accounts a ON a.id = b.account_id
       WHERE b.user_id = ?
       ORDER BY b.category, a.name`,
      [req.user.id]
    );
    for (const b of budgets) {
      b.spent = await spentForBudget(req.user.id, b);
      const { start, end } = currentPeriodBounds(b.period, b.period_start, b.period_days);
      b.periodStart = isoDate(start);
      b.periodEnd   = isoDate(end);
    }
    return budgets;
  });

  app.post("/", async (req, reply) => {
    const {
      category, amount,
      period = "monthly",
      period_start = null,
      period_days  = null,
      account_id   = null,
    } = req.body || {};

    if (!category || !amount) {
      return reply.code(400).send({ error: "category and amount required" });
    }
    if (period === "custom" && (!period_days || period_days < 1)) {
      return reply.code(400).send({ error: "period_days required for custom period" });
    }

    // Verify account belongs to user (if specified)
    if (account_id) {
      const acc = await queryOne(
        "SELECT id FROM accounts WHERE id = ? AND user_id = ?",
        [account_id, req.user.id]
      );
      if (!acc) return reply.code(400).send({ error: "invalid account" });
    }

    await query(
      `INSERT INTO budgets
         (user_id, category, amount, period, period_start, period_days, account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         amount = VALUES(amount), period = VALUES(period),
         period_start = VALUES(period_start), period_days = VALUES(period_days)`,
      [req.user.id, category, amount, period,
       period_start, period_days, account_id]
    );

    const row = await queryOne(
      `SELECT * FROM budgets WHERE user_id = ? AND category = ?
         AND (account_id <=> ?)`,
      [req.user.id, category, account_id]
    );
    return row;
  });

  app.patch("/:id", async (req) => {
    const { amount, period, period_start, period_days } = req.body || {};
    await query(
      `UPDATE budgets SET
         amount = COALESCE(?, amount),
         period = COALESCE(?, period),
         period_start = COALESCE(?, period_start),
         period_days = COALESCE(?, period_days)
       WHERE id = ? AND user_id = ?`,
      [amount ?? null, period ?? null, period_start ?? null, period_days ?? null,
       req.params.id, req.user.id]
    );
    return queryOne("SELECT * FROM budgets WHERE id = ?", [req.params.id]);
  });

  app.delete("/:id", async (req) => {
    await query("DELETE FROM budgets WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]);
    return { ok: true };
  });
}
