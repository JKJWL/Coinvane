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
         AND date >= DATE_SUB(CURDATE(), INTERVAL 1 DAY)`,
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
