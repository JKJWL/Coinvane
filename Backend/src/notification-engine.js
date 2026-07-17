// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "./db.js";
import { enqueueMail } from "./queue.js";
import { renderNotificationDigest } from "./mailer.js";
import { getMasterPeriod, spentForBudgetInWindow } from "./budget-utils.js";

async function insertNotification(userId, n) {
  const dupe = await queryOne(
    `SELECT id FROM notifications WHERE user_id = ? AND type = ? AND title = ?
     AND DATE(created_at) = CURDATE()`,
    [userId, n.type, n.title]
  );
  if (dupe) return null;
  const r = await query(
    `INSERT INTO notifications (user_id, type, icon, color, title, body) VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, n.type, n.icon || null, n.color || null, n.title, n.body || null]
  );
  return { id: r.insertId, ...n };
}

export async function generateNotifications(userId) {
  const created = [];

  // Per-user notification prefs. Every threshold + toggle defaults to the
  // legacy hardcoded value when null so an unmigrated user row still
  // produces sensible alerts.
  const prefs = await queryOne(
    `SELECT notify_large_txn, large_txn_threshold,
            notify_income, income_threshold,
            notify_budget_warning, budget_warning_pct,
            notify_budget_exceeded, notify_goal_milestone,
            notify_bill_reminders, notify_bill_days_before,
            notify_cashflow_enabled, notify_cashflow_min,
            notification_email, email_frequency, email_weekday
     FROM users WHERE id = ?`,
    [userId]
  ) || {};
  const largeTxnOn   = prefs.notify_large_txn !== 0 && prefs.notify_large_txn !== false;
  const largeTxnAmt  = Math.max(1, Number(prefs.large_txn_threshold) || 500);
  const incomeOn     = prefs.notify_income !== 0 && prefs.notify_income !== false;
  const incomeAmt    = Math.max(1, Number(prefs.income_threshold) || 100);
  const budgetWarnOn = prefs.notify_budget_warning !== 0 && prefs.notify_budget_warning !== false;
  const budgetWarnPct = Math.min(99, Math.max(1, Number(prefs.budget_warning_pct) || 80)) / 100;
  const budgetOverOn = prefs.notify_budget_exceeded !== 0 && prefs.notify_budget_exceeded !== false;
  const goalMileOn   = prefs.notify_goal_milestone !== 0 && prefs.notify_goal_milestone !== false;
  const billRemOn    = prefs.notify_bill_reminders !== 0 && prefs.notify_bill_reminders !== false;
  const billDays     = Math.max(0, Math.min(60, Number(prefs.notify_bill_days_before) || 3));
  const cashflowOn   = prefs.notify_cashflow_enabled === 1 || prefs.notify_cashflow_enabled === true;
  const cashflowMin  = Number(prefs.notify_cashflow_min) || 0;

  // ── Budget overspend / approaching limit ────────────────────────
  const master = await getMasterPeriod(userId);
  const budgets = await query(
    `SELECT b.id, b.category, b.amount,
            b.account_id, a.name AS accountName
     FROM budgets b
     LEFT JOIN accounts a ON a.id = b.account_id
     WHERE b.user_id = ?`,
    [userId]
  );
  for (const b of budgets) {
    const spent = await spentForBudgetInWindow(userId, b, master.startStr, master.endStr);
    const pct = spent / Number(b.amount);
    const displayName = b.account_id ? (b.accountName || "Credit Card") : b.category;
    if (pct >= 1 && budgetOverOn) {
      const n = await insertNotification(userId, {
        type: "budget_exceeded", icon: "AlertTriangle", color: "red",
        title: `Budget exceeded: ${displayName}`,
        body: `You've spent $${spent.toFixed(2)} of your $${Number(b.amount).toFixed(2)} budget this period.`,
      });
      if (n) created.push(n);
    } else if (pct >= budgetWarnPct && budgetWarnOn) {
      const n = await insertNotification(userId, {
        type: "budget_warning", icon: "AlertCircle", color: "amber",
        title: `Approaching limit: ${displayName}`,
        body: `${Math.round(pct * 100)}% of your $${Number(b.amount).toFixed(2)} budget used this period.`,
      });
      if (n) created.push(n);
    }
  }

  // ── Large transaction alert (last 24h) ───────────────────────────
  if (largeTxnOn) {
    const big = await query(
      `SELECT merchant, amount, date FROM transactions
       WHERE user_id = ? AND amount < -?
         AND date >= DATE_SUB(CURDATE(), INTERVAL 1 DAY)
         AND (is_transfer = 0 OR is_transfer IS NULL)
         AND (is_scheduled = 0 OR is_scheduled IS NULL)
         AND voided_at IS NULL`,
      [userId, largeTxnAmt]
    );
    for (const t of big) {
      const n = await insertNotification(userId, {
        type: "large_transaction", icon: "TrendingDown", color: "amber",
        title: `Large transaction: ${t.merchant}`,
        body: `$${Math.abs(Number(t.amount)).toFixed(2)} on ${t.date}`,
      });
      if (n) created.push(n);
    }
  }

  // ── Income received (last 24h) ──────────────────────────────────
  // Positive transactions on non-credit accounts only — credit-card refunds
  // and card-payments aren't paychecks, so they get the same exclusion the
  // income tracker uses.
  if (incomeOn) {
    const income = await query(
      `SELECT t.merchant, t.amount, t.date
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ? AND t.amount > ?
         AND (a.type IS NULL OR a.type <> 'credit')
         AND (t.is_transfer = 0 OR t.is_transfer IS NULL)
         AND (t.is_scheduled = 0 OR t.is_scheduled IS NULL)
         AND t.voided_at IS NULL
         AND t.date >= DATE_SUB(CURDATE(), INTERVAL 1 DAY)`,
      [userId, incomeAmt]
    );
    for (const t of income) {
      const merchant = (t.merchant || "").trim() || "your account";
      const n = await insertNotification(userId, {
        type: "income_received", icon: "TrendingUp", color: "emerald",
        title: `Congrats You Got Paid! · ${merchant}`,
        body: `$${Number(t.amount).toFixed(2)} on ${t.date}`,
      });
      if (n) created.push(n);
    }
  }

  // ── Goal progress ────────────────────────────────────────────────
  const goals = await query("SELECT * FROM goals WHERE user_id = ?", [userId]);
  for (const g of goals) {
    const pct = Number(g.saved) / Number(g.target);
    if (pct >= 1 && goalMileOn) {
      const n = await insertNotification(userId, {
        type: "goal_complete", icon: "Trophy", color: "emerald",
        title: `Goal reached: ${g.name}!`,
        body: `You hit your $${Number(g.target).toFixed(2)} target.`,
      });
      if (n) created.push(n);
    } else if (pct >= 0.75 && goalMileOn) {
      const n = await insertNotification(userId, {
        type: "goal_milestone", icon: "Target", color: "blue",
        title: `${Math.round(pct * 100)}% to ${g.name}`,
        body: `$${Number(g.saved).toFixed(2)} of $${Number(g.target).toFixed(2)} saved.`,
      });
      if (n) created.push(n);
    }
  }

  // ── Bill reminders (Stage B: X days before due) ──────────────────
  //   Fires once per open bill cycle whose due_date is within N days
  //   from today. Dedup by (type, title) so a 3-day reminder for the
  //   same cycle only fires once even if the engine runs multiple
  //   times a day.
  if (billRemOn) {
    const dueSoon = await query(
      `SELECT bc.id, bc.due_date, bc.expected_amount,
              b.name AS bill_name,
              DATEDIFF(bc.due_date, CURDATE()) AS days_out
       FROM bill_cycles bc
       JOIN bills b ON b.id = bc.bill_id AND b.archived_at IS NULL
       WHERE bc.user_id = ?
         AND bc.paid_at IS NULL AND bc.skipped = 0
         AND bc.due_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)
       ORDER BY bc.due_date ASC`,
      [userId, billDays]
    );
    for (const c of dueSoon) {
      const when = Number(c.days_out) === 0 ? "today"
        : Number(c.days_out) === 1 ? "tomorrow"
        : `in ${c.days_out} days`;
      const n = await insertNotification(userId, {
        type: "bill_reminder", icon: "Calendar", color: "amber",
        title: `${c.bill_name} due ${when}`,
        body: `Expected $${Number(c.expected_amount).toFixed(2)} · due ${c.due_date}`,
      });
      if (n) created.push(n);
    }
  }

  // ── Cashflow threshold alert (Stage B) ───────────────────────────
  //   Projects forward: sums historical daily deltas + scheduled txns
  //   + open bill cycles over the next 30 days and checks whether the
  //   running non-credit account balance ever dips below the user's
  //   minimum. Fires at most once per day per user.
  if (cashflowOn) {
    const balRow = await queryOne(
      `SELECT COALESCE(SUM(balance), 0) AS bal
       FROM accounts
       WHERE user_id = ? AND (type IS NULL OR type NOT IN ('credit', 'loan'))`,
      [userId]
    );
    let running = Number(balRow?.bal || 0);
    let lowest = running;
    let lowestDay = null;
    // Scheduled outflows from transactions marked is_scheduled.
    const scheduled = await query(
      `SELECT date, SUM(amount) AS delta FROM transactions
       WHERE user_id = ? AND is_scheduled = 1
         AND date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)
         AND voided_at IS NULL
       GROUP BY date ORDER BY date ASC`,
      [userId]
    );
    // Open bill cycles due in window (assume expected_amount will leave
    // the account by due_date if still unpaid).
    const bills = await query(
      `SELECT bc.due_date AS date, -SUM(bc.expected_amount) AS delta
       FROM bill_cycles bc
       JOIN bills b ON b.id = bc.bill_id AND b.archived_at IS NULL
       WHERE bc.user_id = ? AND bc.paid_at IS NULL AND bc.skipped = 0
         AND bc.due_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)
       GROUP BY bc.due_date ORDER BY bc.due_date ASC`,
      [userId]
    );
    const perDay = new Map();
    for (const r of scheduled) perDay.set(String(r.date), (perDay.get(String(r.date)) || 0) + Number(r.delta));
    for (const r of bills)     perDay.set(String(r.date), (perDay.get(String(r.date)) || 0) + Number(r.delta));
    const dates = [...perDay.keys()].sort();
    for (const d of dates) {
      running += perDay.get(d);
      if (running < lowest) { lowest = running; lowestDay = d; }
    }
    if (lowest < cashflowMin) {
      const n = await insertNotification(userId, {
        type: "cashflow_low", icon: "TrendingDown", color: "rose",
        title: `Cash flow projected to dip below $${cashflowMin}`,
        body: `Low point of $${lowest.toFixed(2)}${lowestDay ? ` on ${lowestDay}` : ""} in the next 30 days.`,
      });
      if (n) created.push(n);
    }
  }

  // ── Email digest ─────────────────────────────────────────────────
  // email_frequency: "instant" / "daily" (default) / "weekly".
  //   instant → send whenever there are new notifications this run.
  //   daily   → same as instant (engine runs once daily). Different verbiage
  //             in the UI to set expectations.
  //   weekly  → only send when today's weekday matches user.email_weekday
  //             (0=Sun … 6=Sat, default Mon).
  if (created.length > 0 && prefs.notification_email) {
    const freq = (prefs.email_frequency || "daily").toLowerCase();
    let shouldSend = freq !== "weekly";
    if (freq === "weekly") {
      const todayDow = new Date().getDay();
      shouldSend = todayDow === ((Number(prefs.email_weekday) || 1) % 7);
    }
    if (shouldSend) {
      const u = await queryOne(`SELECT email, name FROM users WHERE id = ?`, [userId]);
      if (u) {
        const mail = renderNotificationDigest({ userName: u.name, notifications: created });
        await enqueueMail({ to: u.email, ...mail });
      }
    }
  }
  return created;
}
