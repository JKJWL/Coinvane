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

  // ── Budget overspend / approaching limit ────────────────────────
  // All budgets evaluated against the MASTER period (income tracker's
  // settings). Single rhythm means alerts reset at the same time every
  // counter resets.
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
    if (pct >= 1) {
      const n = await insertNotification(userId, {
        type: "budget_exceeded", icon: "AlertTriangle", color: "red",
        title: `Budget exceeded: ${displayName}`,
        body: `You've spent $${spent.toFixed(2)} of your $${Number(b.amount).toFixed(2)} budget this period.`,
      });
      if (n) created.push(n);
    } else if (pct >= 0.8) {
      const n = await insertNotification(userId, {
        type: "budget_warning", icon: "AlertCircle", color: "amber",
        title: `Approaching limit: ${displayName}`,
        body: `${Math.round(pct * 100)}% of your $${Number(b.amount).toFixed(2)} budget used this period.`,
      });
      if (n) created.push(n);
    }
  }

  // ── Large transaction alert (last 24h) ───────────────────────────
  const big = await query(
    `SELECT merchant, amount, date FROM transactions
     WHERE user_id = ? AND amount < -500
       AND date >= DATE_SUB(CURDATE(), INTERVAL 1 DAY)`, [userId]
  );
  for (const t of big) {
    const n = await insertNotification(userId, {
      type: "large_transaction", icon: "TrendingDown", color: "amber",
      title: `Large transaction: ${t.merchant}`,
      body: `$${Math.abs(Number(t.amount)).toFixed(2)} on ${t.date}`,
    });
    if (n) created.push(n);
  }

  // ── Income received (last 24h, > $100) ──────────────────────────
  // Positive transactions on non-credit accounts only — credit-card refunds
  // and card-payments both show as amount > 0 but aren't paychecks, so they
  // get the same exclusion the income tracker uses. Title suffixes the
  // merchant so the daily de-dupe key (type + title) still allows multiple
  // paychecks from different sources on the same day.
  const income = await query(
    `SELECT t.merchant, t.amount, t.date
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.user_id = ? AND t.amount > 100
       AND (a.type IS NULL OR a.type <> 'credit')
       AND t.date >= DATE_SUB(CURDATE(), INTERVAL 1 DAY)`,
    [userId]
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

  // ── Goal progress ────────────────────────────────────────────────
  const goals = await query("SELECT * FROM goals WHERE user_id = ?", [userId]);
  for (const g of goals) {
    const pct = Number(g.saved) / Number(g.target);
    if (pct >= 1) {
      const n = await insertNotification(userId, {
        type: "goal_complete", icon: "Trophy", color: "emerald",
        title: `Goal reached: ${g.name}!`,
        body: `You hit your $${Number(g.target).toFixed(2)} target.`,
      });
      if (n) created.push(n);
    } else if (pct >= 0.75) {
      const n = await insertNotification(userId, {
        type: "goal_milestone", icon: "Target", color: "blue",
        title: `${Math.round(pct * 100)}% to ${g.name}`,
        body: `$${Number(g.saved).toFixed(2)} of $${Number(g.target).toFixed(2)} saved.`,
      });
      if (n) created.push(n);
    }
  }

  // ── Email digest (if user opted in) ─────────────────────────────
  if (created.length > 0) {
    const user = await queryOne(
      `SELECT email, name, notification_email FROM users WHERE id = ?`, [userId]
    );
    if (user?.notification_email) {
      const mail = renderNotificationDigest({ userName: user.name, notifications: created });
      await enqueueMail({ to: user.email, ...mail });
    }
  }
  return created;
}
