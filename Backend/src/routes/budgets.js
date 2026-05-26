import { query, queryOne } from "../db.js";
import {
  currentPeriodBounds, isoDate, getMasterPeriod, getPastPeriods,
  spentForBudgetInWindow, logBudgetAudit, getBudgetSnapshotsAsOf,
} from "../budget-utils.js";

/**
 * Master-period model
 * ────────────────────
 * The income tracker's period (user.income_period{_start,_days}) is the
 * MASTER cycle that governs every budget and the credit tracker too. The
 * per-budget period columns still exist in the schema but are ignored for
 * computation. This way all spent/income/allocation totals reset together.
 *
 * Periods supported: weekly | biweekly | semimonthly | monthly | yearly | custom
 *
 * Account-based budgets (account_id set) sum expense on that account; credit
 * cards in particular. Category budgets EXCLUDE credit-card transactions to
 * avoid double-counting swipe + payment.
 *
 * Sort order: budgets returned ASC by sort_order; new budgets get the next
 * highest (pushed to end).
 */

const PERIODS = ["weekly","biweekly","semimonthly","monthly","yearly","custom"];

async function sumIncomeInWindow(userId, startStr, endStr) {
  const row = await queryOne(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM transactions
     WHERE user_id = ? AND amount > 0 AND date >= ? AND date < ?`,
    [userId, startStr, endStr]
  );
  return Number(row.total) || 0;
}

async function creditUsageInWindow(userId, startStr, endStr) {
  const rows = await query(
    `SELECT a.id AS accountId, a.name AS accountName, a.institution,
            COALESCE(SUM(ABS(t.amount)), 0) AS used
     FROM accounts a
     LEFT JOIN transactions t ON t.account_id = a.id AND t.amount < 0
       AND t.date >= ? AND t.date < ?
     WHERE a.user_id = ? AND a.type = 'credit'
     GROUP BY a.id, a.name, a.institution`,
    [startStr, endStr, userId]
  );
  const cards = rows.map(r => ({
    accountId: r.accountId,
    accountName: r.accountName,
    institution: r.institution,
    used: Number(r.used) || 0,
  }));
  const total = cards.reduce((s, c) => s + c.used, 0);
  return { total, cards };
}

export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  // ── GET / — list user budgets ────────────────────────────────────
  app.get("/", async (req) => {
    // Master period drives every budget's window. If the caller supplies
    // ?atDate=YYYY-MM-DD we compute as-of that date instead (used by history).
    const atDate = req.query?.atDate || null;
    const master = await getMasterPeriod(req.user.id, atDate);

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
      b.spent = await spentForBudgetInWindow(req.user.id, b, master.startStr, master.endStr);
      b.periodStart = master.startStr;
      b.periodEnd   = master.endStr;
      // Surface the master period info on each budget so the frontend can
      // display "Resets every X days starting Y" consistently.
      b.period = master.period;
      b.period_days = master.periodDays;
    }
    return budgets;
  });

  // ── GET /trackers — income + credit usage + zero-budget summary ─
  // All numbers use the MASTER period (income tracker's settings) so they
  // line up exactly with the budgets page.
  app.get("/trackers", async (req) => {
    const atDate = req.query?.atDate || null;
    const master = await getMasterPeriod(req.user.id, atDate);
    const user = await queryOne(
      `SELECT income_period_start, credit_period, credit_period_start, credit_period_days
       FROM users WHERE id = ?`,
      [req.user.id]
    );

    const incomeTotal = await sumIncomeInWindow(req.user.id, master.startStr, master.endStr);
    const income = {
      total: incomeTotal,
      period: master.period,
      periodDays: master.periodDays,
      periodStart: master.startStr,
      periodEnd: master.endStr,
      // Anchor = what the user picked. Different from periodStart (current).
      periodAnchor: user?.income_period_start
        ? String(user.income_period_start).slice(0, 10)
        : null,
    };

    // Credit tracker — only when ≥ 1 credit account exists. Also bound to
    // master period now (one rhythm for the whole app).
    const hasCC = await queryOne(
      "SELECT 1 AS x FROM accounts WHERE user_id = ? AND type = 'credit' LIMIT 1",
      [req.user.id]
    );
    let credit = null;
    if (hasCC) {
      const cu = await creditUsageInWindow(req.user.id, master.startStr, master.endStr);
      credit = {
        ...cu,
        period: master.period,
        periodDays: master.periodDays,
        periodStart: master.startStr,
        periodEnd: master.endStr,
        periodAnchor: user?.income_period_start
          ? String(user.income_period_start).slice(0, 10)
          : null,
      };
    }

    // Zero-based-budget summary: sum of category budget amounts vs income.
    // Card budgets don't count toward allocation since they cap a payment
    // method, not an income allocation.
    const allocRow = await queryOne(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM budgets
       WHERE user_id = ? AND account_id IS NULL`,
      [req.user.id]
    );
    const allocated = Number(allocRow.total) || 0;

    return {
      income,
      credit,
      zeroBudget: {
        income: incomeTotal,
        allocated,
        remaining: incomeTotal - allocated,
      },
    };
  });

  // ── GET /history — past period snapshots (Feature: Budget History) ──
  // Returns the last N completed periods (and the current one), each with:
  //   - period bounds
  //   - per-budget spent vs amount (using the AS-OF-period-end snapshot)
  //   - income total
  //
  // Resolution model: every budget create/update/delete writes a row to
  // budget_audit. For each historical period we read the latest snapshot
  // with effective_at < periodEnd. If that snapshot's action is 'delete',
  // or no snapshot exists for that budget by then, the budget is omitted
  // from the period. This means amount edits and deletions are faithful
  // to history — last month shows last month's cap, not today's.
  //
  // Account-name lookup falls back to the live `accounts` table; if the
  // account was renamed since the period closed, the current name is
  // shown. We don't snapshot account names (out of scope for budget
  // history).
  app.get("/history", async (req) => {
    const count = Math.min(24, Math.max(1, Number(req.query?.count) || 6));
    const masterUser = await queryOne(
      `SELECT income_period, income_period_start, income_period_days
       FROM users WHERE id = ?`,
      [req.user.id]
    );
    const periods = getPastPeriods(
      masterUser?.income_period || "monthly",
      masterUser?.income_period_start || null,
      masterUser?.income_period_days || null,
      count
    );
    // Sort-order + accountName lookups come from current state; everything
    // else is snapshotted in budget_audit.
    const liveRows = await query(
      `SELECT b.id, b.sort_order AS sortOrder,
              a.name AS accountName, a.type AS accountType
       FROM budgets b
       LEFT JOIN accounts a ON a.id = b.account_id
       WHERE b.user_id = ?`,
      [req.user.id]
    );
    const liveById = new Map(liveRows.map(r => [r.id, r]));

    // Account names for budgets whose budgets row no longer exists (deleted)
    // — pull from the snapshot's account_id against accounts.
    const accountRows = await query(
      `SELECT id, name FROM accounts WHERE user_id = ?`,
      [req.user.id]
    );
    const accountNameById = new Map(accountRows.map(a => [a.id, a.name]));

    const today = isoDate(new Date(new Date().setHours(0,0,0,0)));
    const result = [];
    for (const p of periods) {
      const startStr = isoDate(p.start);
      const endStr   = isoDate(p.end);
      const isCurrent = startStr <= today && today < endStr;
      const income = await sumIncomeInWindow(req.user.id, startStr, endStr);

      // endStr is exclusive (first day NOT included). The audit cutoff is
      // the start of that day in local time — any audit row stamped before
      // then was in effect during the period.
      const snapshots = await getBudgetSnapshotsAsOf(
        req.user.id,
        `${endStr} 00:00:00`
      );

      const budgetOutcomes = [];
      for (const [budgetId, snap] of snapshots) {
        const live = liveById.get(budgetId);
        const accountName = snap.account_id
          ? accountNameById.get(snap.account_id) || null
          : null;
        // Use the snapshotted category + amount + account so amount edits
        // after the period are not back-applied.
        const spent = await spentForBudgetInWindow(
          req.user.id,
          { category: snap.category, account_id: snap.account_id },
          startStr, endStr
        );
        budgetOutcomes.push({
          id: budgetId,
          category: snap.category,
          amount: Number(snap.amount),
          accountId: snap.account_id,
          accountName,
          // Live sort_order if the budget still exists; deleted budgets
          // fall to the end.
          sortOrder: live ? live.sortOrder : Number.MAX_SAFE_INTEGER,
          spent,
        });
      }
      budgetOutcomes.sort((a, b) => (a.sortOrder - b.sortOrder) || (a.id - b.id));

      result.push({
        periodStart: startStr,
        periodEnd: endStr,
        isCurrent,
        income,
        budgets: budgetOutcomes,
      });
    }
    return result;
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

    // Explicit upsert so we can emit the correct audit action (create vs
    // update). The previous ON DUPLICATE KEY shortcut made that ambiguous.
    const existing = await queryOne(
      `SELECT id FROM budgets WHERE user_id = ? AND category = ? AND (account_id <=> ?)`,
      [req.user.id, category, account_id]
    );

    let budgetId;
    let action;
    if (existing) {
      await query(
        `UPDATE budgets SET amount = ?, period = ?, period_start = ?, period_days = ?
         WHERE id = ? AND user_id = ?`,
        [amount, period, period_start, period_days, existing.id, req.user.id]
      );
      budgetId = existing.id;
      action = "update";
    } else {
      const maxRow = await queryOne(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM budgets WHERE user_id = ?",
        [req.user.id]
      );
      const sortOrder = Number(maxRow.next) || 0;
      const result = await query(
        `INSERT INTO budgets
           (user_id, category, amount, period, period_start, period_days, account_id, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.user.id, category, amount, period,
         period_start, period_days, account_id, sortOrder]
      );
      budgetId = result.insertId;
      action = "create";
    }

    await logBudgetAudit(req.user.id, budgetId, action, {
      category, amount, period, period_start, period_days, account_id,
    });

    return queryOne(
      `SELECT * FROM budgets WHERE id = ? AND user_id = ?`,
      [budgetId, req.user.id]
    );
  });

  // ── GET /:id/transactions — list contributing transactions ──────
  // Optional ?periodStart=YYYY-MM-DD&periodEnd=YYYY-MM-DD for the history
  // view; otherwise uses the master period.
  app.get("/:id/transactions", async (req, reply) => {
    const b = await queryOne(
      `SELECT id, category, account_id FROM budgets WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!b) return reply.code(404).send({ error: "budget not found" });

    let startStr, endStr;
    if (req.query?.periodStart && req.query?.periodEnd) {
      startStr = req.query.periodStart;
      endStr   = req.query.periodEnd;
    } else {
      const master = await getMasterPeriod(req.user.id);
      startStr = master.startStr;
      endStr   = master.endStr;
    }

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
        [req.user.id, b.account_id, startStr, endStr]
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
        [req.user.id, b.category, startStr, endStr]
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
    const fresh = await queryOne(
      "SELECT * FROM budgets WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    if (fresh) {
      await logBudgetAudit(req.user.id, fresh.id, "update", {
        category: fresh.category,
        amount: fresh.amount,
        period: fresh.period,
        period_start: fresh.period_start,
        period_days: fresh.period_days,
        account_id: fresh.account_id,
      });
    }
    return fresh;
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
    // Snapshot the row BEFORE deletion so the audit row reflects the
    // state at the moment of delete. budget_audit has no FK to budgets,
    // so the snapshot lives on after the parent row is gone — that's how
    // history can still resolve periods the budget participated in.
    const snap = await queryOne(
      "SELECT * FROM budgets WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    await query("DELETE FROM budgets WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]);
    if (snap) {
      await logBudgetAudit(req.user.id, snap.id, "delete", {
        category: snap.category,
        amount: snap.amount,
        period: snap.period,
        period_start: snap.period_start,
        period_days: snap.period_days,
        account_id: snap.account_id,
      });
    }
    return { ok: true };
  });
}
