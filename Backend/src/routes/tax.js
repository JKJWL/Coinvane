// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "../db.js";

/**
 * Tax reporting endpoints — year-end aggregates rolled up by IRS Schedule.
 *
 *   Schedule A → Itemized deductions (mortgage int, SALT, charity, medical)
 *   Schedule B → Interest & dividend INCOME
 *   Schedule C → Self-employment INCOME / EXPENSES
 *   Schedule D → Capital gains / losses (realized)
 *   Schedule E → Rental / royalty / partnership INCOME / EXPENSES
 *
 * A transaction rolls up to a schedule if either:
 *   - its category has tax_schedule set, OR
 *   - the transaction has is_deductible = 1 (manual override; treated
 *     as Schedule A when the category has no schedule of its own).
 */
export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  app.get("/summary", async (req) => {
    const year = Number(req.query?.year) || new Date().getFullYear();
    const rows = await query(
      `SELECT
         COALESCE(c.tax_schedule, IF(t.is_deductible = 1, 'A', NULL)) AS schedule,
         t.category,
         t.amount
       FROM transactions t
       LEFT JOIN categories c
         ON c.user_id = t.user_id AND c.name = t.category
       WHERE t.user_id = ?
         AND YEAR(t.date) = ?
         AND (t.is_transfer = 0 OR t.is_transfer IS NULL)
         AND (t.is_scheduled = 0 OR t.is_scheduled IS NULL)
         AND t.voided_at IS NULL
         AND (c.tax_schedule IS NOT NULL OR t.is_deductible = 1)`,
      [req.user.id, year]
    );

    const schedules = { A: [], B: [], C: [], D: [], E: [] };
    const totals = { A: 0, B: 0, C: 0, D: 0, E: 0 };
    const catAgg = new Map();
    for (const r of rows) {
      const s = r.schedule;
      if (!schedules[s]) continue;
      const key = `${s}::${r.category}`;
      const amt = Number(r.amount);
      const entry = catAgg.get(key) || { schedule: s, category: r.category, total: 0, count: 0 };
      entry.total += amt;
      entry.count += 1;
      catAgg.set(key, entry);
      totals[s] += amt;
    }
    for (const e of catAgg.values()) {
      e.total = Number(e.total.toFixed(2));
      schedules[e.schedule].push(e);
    }
    for (const s of Object.keys(schedules)) {
      schedules[s].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
      totals[s] = Number(totals[s].toFixed(2));
    }
    return { year, schedules, totals };
  });

  // List of schedule choices for the UI dropdown.
  app.get("/schedules", async () => ([
    { code: "A", label: "Schedule A — Itemized Deductions" },
    { code: "B", label: "Schedule B — Interest & Dividends" },
    { code: "C", label: "Schedule C — Business Profit/Loss" },
    { code: "D", label: "Schedule D — Capital Gains" },
    { code: "E", label: "Schedule E — Rental / Royalty" },
  ]));
}
