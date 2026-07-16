// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared math + helpers for the bills feature. Used by both the /bills
// route handlers and the daily cron in worker.js.
import { query, queryOne } from "./db.js";

// Parse a "YYYY-MM-DD" as LOCAL midnight (not UTC). Same rationale as
// budget-utils.js::parseLocalDate — new Date("YYYY-MM-DD") is UTC and
// silently off-by-one in negative-UTC zones.
export function parseLocalDate(s) {
  if (!s) return null;
  const [y, m, d] = String(s).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
export function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function addMonths(d, n) { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; }

// Given a bill (cycle, cycle_days, cycle_anchor) and a starting date,
// return { cycle_start, cycle_end, due_date } for the cycle whose window
// contains `startingDate` (or the next one if none does).
export function computeCycleFor(bill, startingDate) {
  const anchor = parseLocalDate(bill.cycle_anchor);
  if (!anchor) throw new Error("bill.cycle_anchor invalid");
  const kind = bill.cycle;
  const days = Number(bill.cycle_days) || 30;
  let start = new Date(anchor);
  let end;
  const nextStart = (s) => {
    if (kind === "weekly")       return addDays(s, 7);
    if (kind === "biweekly")     return addDays(s, 14);
    if (kind === "semimonthly")  return s.getDate() === 1 ? new Date(s.getFullYear(), s.getMonth(), 15) : new Date(s.getFullYear(), s.getMonth() + 1, 1);
    if (kind === "monthly")      return addMonths(s, 1);
    if (kind === "yearly")       return addMonths(s, 12);
    return addDays(s, days);
  };
  // Walk forward from anchor until we land on / past startingDate.
  // Cap loop iterations to guard against pathological inputs.
  let guard = 0;
  while (guard++ < 5000) {
    end = nextStart(start);
    if (end > startingDate) break;
    start = end;
  }
  // due_date = end (last day of cycle); operator can display "due X days
  // before end" if they want to lead time.
  return {
    cycle_start: isoDate(start),
    cycle_end:   isoDate(end),
    due_date:    isoDate(end),
  };
}

// Ensure that the bill has an open (unpaid, un-skipped) cycle whose window
// contains today, OR the cycle that starts next if today is beyond the
// last known cycle. Returns the cycle row.
export async function ensureCurrentCycle(userId, bill, today = new Date()) {
  const existing = await queryOne(
    `SELECT * FROM bill_cycles
     WHERE bill_id = ? AND user_id = ?
     ORDER BY cycle_start DESC LIMIT 1`,
    [bill.id, userId]
  );
  const todayIso = isoDate(today);
  if (existing) {
    // Still within the last-known cycle? Keep it.
    if (existing.cycle_end >= todayIso) return existing;
    // Past it — create the next one. Walk forward starting from the
    // existing cycle_end so we don't skip a whole cycle if the cron
    // hasn't run for a while.
    const startFrom = parseLocalDate(existing.cycle_end);
    const next = computeCycleFor(bill, startFrom);
    return await insertCycle(userId, bill, next);
  }
  // No cycles yet — create the one containing today.
  const first = computeCycleFor(bill, today);
  return await insertCycle(userId, bill, first);
}

async function insertCycle(userId, bill, window) {
  const r = await query(
    `INSERT INTO bill_cycles
       (user_id, bill_id, cycle_start, cycle_end, due_date, expected_amount)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, bill.id, window.cycle_start, window.cycle_end, window.due_date,
     Number(bill.expected_amount) || 0]
  );
  return queryOne("SELECT * FROM bill_cycles WHERE id = ?", [r.insertId]);
}

// Try to match a transaction to an open bill cycle. Called from sync.js
// after each new transaction. Rules:
//   - transaction must be negative (an outgoing payment)
//   - merchant_pattern (LIKE) must match the txn merchant
//   - amount must be within 40% of the expected/average (bills float, but
//     a 5x deviation is almost certainly not the same bill)
//   - cycle must be open (paid_at IS NULL, skipped = 0)
// On match: cycle.paid_at, paid_amount, matched_txn_id, variance_pct
// populated. Bill's average_amount is nudged toward the paid amount
// with a simple 3-cycle rolling estimate.
export async function tryMatchTransactionToBill(userId, txn) {
  if (!txn || Number(txn.amount) >= 0) return null;
  const bills = await query(
    `SELECT * FROM bills
     WHERE user_id = ? AND archived_at IS NULL
       AND merchant_pattern IS NOT NULL AND merchant_pattern <> ''`,
    [userId]
  );
  const paidAbs = Math.abs(Number(txn.amount));
  const merchantLc = String(txn.merchant || "").toLowerCase();
  for (const bill of bills) {
    const pat = String(bill.merchant_pattern).toLowerCase();
    if (!merchantLc.includes(pat)) continue;
    const target = Number(bill.average_amount) || Number(bill.expected_amount) || 0;
    if (target > 0) {
      const ratio = paidAbs / target;
      if (ratio < 0.6 || ratio > 1.4) continue; // outside ±40% band
    }
    // Cycle to mark paid: prefer an open one whose window contains the
    // txn date; fall back to the earliest open cycle.
    const cycle = await queryOne(
      `SELECT * FROM bill_cycles
       WHERE user_id = ? AND bill_id = ?
         AND paid_at IS NULL AND skipped = 0
         AND ? BETWEEN cycle_start AND cycle_end
       ORDER BY cycle_start ASC LIMIT 1`,
      [userId, bill.id, txn.date]
    ) || await queryOne(
      `SELECT * FROM bill_cycles
       WHERE user_id = ? AND bill_id = ?
         AND paid_at IS NULL AND skipped = 0
       ORDER BY cycle_start ASC LIMIT 1`,
      [userId, bill.id]
    );
    if (!cycle) continue;
    const variance = Number(cycle.expected_amount) > 0
      ? ((paidAbs - Number(cycle.expected_amount)) / Number(cycle.expected_amount)) * 100
      : null;
    await query(
      `UPDATE bill_cycles
       SET paid_at = NOW(), paid_amount = ?, matched_txn_id = ?, variance_pct = ?
       WHERE id = ?`,
      [paidAbs, txn.id, variance, cycle.id]
    );
    // Rolling 3-cycle average update: average_amount = (avg*2 + newPaid) / 3
    const oldAvg = Number(bill.average_amount) || Number(bill.expected_amount) || paidAbs;
    const newAvg = (oldAvg * 2 + paidAbs) / 3;
    await query(
      "UPDATE bills SET average_amount = ? WHERE id = ?",
      [newAvg.toFixed(2), bill.id]
    );
    return { billId: bill.id, cycleId: cycle.id, variance };
  }
  return null;
}

// Ensure current cycles for every active bill of a user. Called by the
// daily cron. Idempotent — ensureCurrentCycle no-ops if already current.
export async function refreshUserBillCycles(userId) {
  const bills = await query(
    "SELECT * FROM bills WHERE user_id = ? AND archived_at IS NULL",
    [userId]
  );
  for (const b of bills) {
    try { await ensureCurrentCycle(userId, b); } catch { /* skip malformed */ }
  }
}
