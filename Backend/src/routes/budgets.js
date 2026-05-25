import { query, queryOne } from "../db.js";
import {
  currentPeriodBounds as _cpb,
  isoDate as _iso,
  spentForBudget as _spent,
} from "../budget-utils.js";

/**
 * Budget period + tracker route. Shared period math lives in budget-utils.js
 * so the notification engine can use the same logic.
 *
 * Account-based budgets: when account_id is set the budget sums all expense
 * on that account regardless of category. Category budgets EXCLUDE credit-
 * card transactions (avoids double-counting swipe + payment).
 *
 * Sort order: budgets are returned ASC by sort_order; new budgets get the
 * next-highest value (pushed to end).
 */

const PERIODS = ["weekly","biweekly","semimonthly","monthly","yearly","custom"];

// Use the shared helpers without renaming the local references the rest of
// the file uses.
const currentPeriodBounds = _cpb;
const isoDate = _iso;
const spentForBudget = _spent;

async function incomeFor(userId, period, periodStart, periodDays) {
  const { start, end } = currentPeriodBounds(period, periodStart, periodDays);
  const row = await queryOne(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM transactions
     WHERE user_id = ? AND amount > 0 AND date >= ? AND date < ?`,
    [userId, isoDate(start), isoDate(end)]
  );
  return {
    total: Number(row.total) || 0,
    periodStart: isoDate(start),
    periodEnd: isoDate(end),
  };
}

async function creditUsageFor(userId, period, periodStart, periodDays) {
  const { start, end } = currentPeriodBounds(period, periodStart, periodDays);
  // Per credit card, sum negative tx amounts
  const rows = await query(
    `SELECT a.id AS accountId, a.name AS accountName, a.institution,
            COALESCE(SUM(ABS(t.amount)), 0) AS used
     FROM accounts a
     LEFT JOIN transactions t ON t.account_id = a.id AND t.amount < 0
       AND t.date >= ? AND t.date < ?
     WHERE a.user_id = ? AND a.type = 'credit'
     GROUP BY a.id, a.name, a.institution`,
    [isoDate(start), isoDate(end), userId]
  );
  const cards = rows.map(r => ({
    accountId: r.accountId,
    accountName: r.accountName,
    institution: r.institution,
    used: Number(r.used) || 0,
  }));
  const total = cards.reduce((s, c) => s + c.used, 0);
  return {
    total,
    cards,
    periodStart: isoDate(start),
    periodEnd: isoDate(end),
  };
}

export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  // ── GET / — list user budgets ────────────────────────────────────
  app.get("/", async (req) => {
    const budgets = await query(
      `SELECT b.id, b.category, b.amount, b.period, b.period_start, b.period_days,
              b.account_id AS accountId, b.sort_order AS sortOrder,
              a.name AS accountName, a.type AS accountType
       FROM budgets b
       LEFT JOIN accounts a ON a.id = b.account_id
       WHERE b.user_id = ?
       ORDER BY b.sort_order ASC, b.id ASC`,
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

  // ── GET /trackers — income + credit usage + zero-budget summary ─
  app.get("/trackers", async (req) => {
    const user = await queryOne(
      `SELECT income_period, income_period_start, income_period_days,
              credit_period, credit_period_start, credit_period_days
       FROM users WHERE id = ?`,
      [req.user.id]
    );

    const income = await incomeFor(
      req.user.id,
      user.income_period || "monthly",
      user.income_period_start,
      user.income_period_days
    );
    income.period = user.income_period || "monthly";
    income.periodDays = user.income_period_days;
    // ANCHOR date = what the user picked (e.g. "every Tuesday from 2026-01-13").
    // Distinct from periodStart, which is the CURRENT period's start (e.g.
    // "this week's Tuesday"). Frontend needs the anchor to pre-fill the
    // edit form correctly so picking a custom start doesn't keep
    // re-resetting to today.
    income.periodAnchor = user.income_period_start
      ? new Date(user.income_period_start).toISOString().slice(0, 10)
      : null;

    // Only return credit tracker info if user has at least one credit account.
    const hasCC = await queryOne(
      "SELECT 1 AS x FROM accounts WHERE user_id = ? AND type = 'credit' LIMIT 1",
      [req.user.id]
    );
    let credit = null;
    if (hasCC) {
      credit = await creditUsageFor(
        req.user.id,
        user.credit_period || "monthly",
        user.credit_period_start,
        user.credit_period_days
      );
      credit.period = user.credit_period || "monthly";
      credit.periodDays = user.credit_period_days;
      credit.periodAnchor = user.credit_period_start
        ? new Date(user.credit_period_start).toISOString().slice(0, 10)
        : null;
    }

    // Zero-based-budget summary: sum of all budget amounts (caps) vs income.
    // Card budgets don't count toward "money you've allocated to spend"
    // because they're caps on a payment method, not allocations of income.
    const allocRow = await queryOne(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM budgets
       WHERE user_id = ? AND account_id IS NULL`,
      [req.user.id]
    );
    const allocated = Number(allocRow.total) || 0;
    const remainingToBudget = income.total - allocated;

    return {
      income,
      credit,
      zeroBudget: {
        income: income.total,
        allocated,
        remaining: remainingToBudget,
      },
    };
  });

  // ── GET /suggestions — categories with spend but no budget yet ──
  app.get("/suggestions", async (req) => {
    // Last 90 days of spending in non-credit accounts, by category, excluding
    // categories you already have a (category-based) budget for.
    const rows = await query(
      `SELECT t.category, COUNT(*) AS uses, SUM(ABS(t.amount)) AS total
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ?
         AND t.amount < 0
         AND t.date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
         AND (a.type IS NULL OR a.type <> 'credit')
         AND t.category NOT IN (
           SELECT category FROM budgets
           WHERE user_id = ? AND account_id IS NULL
         )
       GROUP BY t.category
       ORDER BY total DESC
       LIMIT 6`,
      [req.user.id, req.user.id]
    );
    return rows.map(r => ({
      category: r.category,
      uses: Number(r.uses),
      total: Number(r.total),
    }));
  });

  // ── PATCH /tracker-settings — change income/credit tracker periods
  app.patch("/tracker-settings", async (req) => {
    const {
      income_period, income_period_days, income_period_start,
      credit_period, credit_period_days, credit_period_start,
    } = req.body || {};
    await query(
      `UPDATE users SET
         income_period       = COALESCE(?, income_period),
         income_period_days  = COALESCE(?, income_period_days),
         income_period_start = COALESCE(?, income_period_start),
         credit_period       = COALESCE(?, credit_period),
         credit_period_days  = COALESCE(?, credit_period_days),
         credit_period_start = COALESCE(?, credit_period_start)
       WHERE id = ?`,
      [income_period ?? null, income_period_days ?? null, income_period_start ?? null,
       credit_period ?? null, credit_period_days ?? null, credit_period_start ?? null,
       req.user.id]
    );
    return { ok: true };
  });

  // ── POST / — create budget ──────────────────────────────────────
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
    if (period && !PERIODS.includes(period)) {
      return reply.code(400).send({ error: "invalid period" });
    }
    if (period === "custom" && (!period_days || period_days < 1)) {
      return reply.code(400).send({ error: "period_days required for custom period" });
    }
    if (account_id) {
      const acc = await queryOne(
        "SELECT id FROM accounts WHERE id = ? AND user_id = ?",
        [account_id, req.user.id]
      );
      if (!acc) return reply.code(400).send({ error: "invalid account" });
    }

    // Next sort_order (push to end)
    const maxRow = await queryOne(
      "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM budgets WHERE user_id = ?",
      [req.user.id]
    );
    const sortOrder = Number(maxRow.next) || 0;

    await query(
      `INSERT INTO budgets
         (user_id, category, amount, period, period_start, period_days, account_id, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         amount = VALUES(amount), period = VALUES(period),
         period_start = VALUES(period_start), period_days = VALUES(period_days)`,
      [req.user.id, category, amount, period,
       period_start, period_days, account_id, sortOrder]
    );

    return queryOne(
      `SELECT * FROM budgets WHERE user_id = ? AND category = ? AND (account_id <=> ?)`,
      [req.user.id, category, account_id]
    );
  });

  // ── GET /:id/transactions — list contributing transactions ──────
  // Feature 1: tap a budget to see what's contributing to its spent total
  // in the current period. Honours the same category/account/credit rules
  // as the spent calculation.
  app.get("/:id/transactions", async (req, reply) => {
    const b = await queryOne(
      `SELECT id, category, period, period_start, period_days, account_id
       FROM budgets WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!b) return reply.code(404).send({ error: "budget not found" });

    const { start, end } = currentPeriodBounds(b.period, b.period_start, b.period_days);

    let rows;
    if (b.account_id) {
      rows = await query(
        `SELECT t.id, t.date, t.merchant, t.category, t.amount, t.pending,
                a.name AS accountName
         FROM transactions t
         LEFT JOIN accounts a ON a.id = t.account_id
         WHERE t.user_id = ? AND t.account_id = ? AND t.amount < 0
           AND t.date >= ? AND t.date < ?
         ORDER BY t.date DESC, t.id DESC`,
        [req.user.id, b.account_id, isoDate(start), isoDate(end)]
      );
    } else {
      rows = await query(
        `SELECT t.id, t.date, t.merchant, t.category, t.amount, t.pending,
                a.name AS accountName
         FROM transactions t
         LEFT JOIN accounts a ON a.id = t.account_id
         WHERE t.user_id = ? AND t.category = ? AND t.amount < 0
           AND t.date >= ? AND t.date < ?
           AND (a.type IS NULL OR a.type <> 'credit')
         ORDER BY t.date DESC, t.id DESC`,
        [req.user.id, b.category, isoDate(start), isoDate(end)]
      );
    }
    return rows;
  });

  // ── PATCH /:id — edit budget (Feature 5) ────────────────────────
  app.patch("/:id", async (req) => {
    const { amount, period, period_start, period_days } = req.body || {};
    if (period && !PERIODS.includes(period)) {
      return { error: "invalid period" };
    }
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
    return queryOne("SELECT * FROM budgets WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]);
  });

  // ── POST /reorder — drag-to-reorder (Feature 1) ─────────────────
  // Body: { ids: [budgetId1, budgetId2, ...] } in the new desired order
  app.post("/reorder", async (req, reply) => {
    const { ids } = req.body || {};
    if (!Array.isArray(ids)) return reply.code(400).send({ error: "ids array required" });
    // Verify every id belongs to this user
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      const rows = await query(
        `SELECT id FROM budgets WHERE user_id = ? AND id IN (${placeholders})`,
        [req.user.id, ...ids]
      );
      if (rows.length !== ids.length) {
        return reply.code(403).send({ error: "one or more ids do not belong to you" });
      }
    }
    // Update each row's sort_order in one shot
    for (let i = 0; i < ids.length; i++) {
      await query(
        "UPDATE budgets SET sort_order = ? WHERE id = ? AND user_id = ?",
        [i, ids[i], req.user.id]
      );
    }
    return { ok: true };
  });

  // ── DELETE /:id ─────────────────────────────────────────────────
  app.delete("/:id", async (req) => {
    await query("DELETE FROM budgets WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]);
    return { ok: true };
  });
}
