import { query, queryOne } from "../db.js";

/**
 * Budget period model
 * ────────────────────
 *   "weekly"       — resets every Sunday
 *   "biweekly"     — resets every 14 days from period_start (defaults to last Sunday)
 *   "semimonthly"  — resets on the 1st and 15th of each month
 *   "monthly"      — resets on the 1st of each month (default)
 *   "yearly"       — resets January 1
 *   "custom"       — resets every period_days days, starting from period_start
 *
 * Account-based budgets (Feature 5):
 * When account_id is set the budget tracks spending on that account regardless
 * of category. Category budgets EXCLUDE credit-card transactions to avoid
 * double-counting (swipe + payment).
 *
 * Income tracker (Feature 4):
 * Per-user, no amount. Sums positive transactions in the chosen period.
 *
 * Credit tracker (Feature 4):
 * Per-user, no amount. Sums |amount| of expenses on credit accounts in the
 * chosen period. Only meaningful when at least one credit account exists.
 *
 * Sort order (Feature 1):
 * Budgets are returned in ascending sort_order. New budgets get next-highest.
 */

const PERIODS = ["weekly","biweekly","semimonthly","monthly","yearly","custom"];

function currentPeriodBounds(period, periodStart, periodDays, nowDate) {
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

function isoDate(d) { return d.toISOString().slice(0, 10); }

async function spentForBudget(userId, b) {
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
