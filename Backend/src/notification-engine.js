import { query, queryOne } from "./db.js";
import { enqueueMail } from "./queue.js";
import { renderNotificationDigest } from "./mailer.js";

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

  const budgets = await query(
    `SELECT b.id, b.category, b.amount,
            COALESCE((SELECT SUM(ABS(t.amount)) FROM transactions t
              WHERE t.user_id = b.user_id AND t.category = b.category AND t.amount < 0
                AND t.date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')), 0) AS spent
     FROM budgets b WHERE b.user_id = ?`, [userId]
  );
  for (const b of budgets) {
    const pct = b.spent / Number(b.amount);
    if (pct >= 1) {
      const n = await insertNotification(userId, {
        type: "budget_exceeded", icon: "AlertTriangle", color: "red",
        title: `Budget exceeded: ${b.category}`,
        body: `You've spent $${Number(b.spent).toFixed(2)} of your $${Number(b.amount).toFixed(2)} budget.`,
      });
      if (n) created.push(n);
    } else if (pct >= 0.8) {
      const n = await insertNotification(userId, {
        type: "budget_warning", icon: "AlertCircle", color: "amber",
        title: `Approaching limit: ${b.category}`,
        body: `${Math.round(pct * 100)}% of your $${Number(b.amount).toFixed(2)} budget used.`,
      });
      if (n) created.push(n);
    }
  }

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