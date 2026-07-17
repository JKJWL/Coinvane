// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "../db.js";
import { decrypt } from "../crypto.js";

/**
 * Full account-data export as a PDF report. Server-side rendered with
 * pdfkit (no headless browser dependency, no DOM). Streamed to the client.
 *
 * Contents:
 *   - Cover (user + generated-on)
 *   - Summary card (net worth, totals by type)
 *   - Accounts table
 *   - Budgets table
 *   - Goals table
 *   - Transactions table (last 500, newest first — full export is too
 *     unwieldy in PDF; CSV export covers the unbounded case)
 *   - Notes (decrypted, title + body)
 */
export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  app.get("/full.pdf", async (req, reply) => {
    const PDFDocument = (await import("pdfkit")).default;
    const userId = req.user.id;

    const me = await queryOne(
      `SELECT email, name, currency FROM users WHERE id = ?`, [userId]
    );
    const accounts = await query(
      `SELECT name, type, subtype, balance, institution
       FROM accounts WHERE user_id = ? ORDER BY type, name`, [userId]
    );
    const budgets = await query(
      `SELECT b.category, b.amount, a.name AS accountName
       FROM budgets b LEFT JOIN accounts a ON a.id = b.account_id
       WHERE b.user_id = ? ORDER BY b.sort_order, b.id`, [userId]
    );
    const goals = await query(
      `SELECT name, target, saved, deadline FROM goals WHERE user_id = ? ORDER BY id`,
      [userId]
    );
    const txns = await query(
      `SELECT t.date, t.merchant, t.category, t.amount, a.name AS accountName
       FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ? AND t.voided_at IS NULL
       ORDER BY t.date DESC, t.id DESC LIMIT 500`, [userId]
    );
    const notes = await query(
      `SELECT title, content FROM notes WHERE user_id = ? ORDER BY id`, [userId]
    );

    const fmt = (n) => "$" + Number(n || 0).toFixed(2);
    const totals = accounts.reduce((acc, a) => {
      const v = Number(a.balance) || 0;
      if (a.type === "credit") acc.credit += v;
      else if (a.type === "investment" || a.type === "brokerage") acc.investment += v;
      else acc.cash += v;
      return acc;
    }, { cash: 0, credit: 0, investment: 0 });
    const netWorth = totals.cash + totals.investment - Math.abs(totals.credit);

    reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="coinvane-export.pdf"`);

    const doc = new PDFDocument({ size: "LETTER", margin: 50 });
    reply.send(doc);

    // ── Cover ────────────────────────────────────────────────────
    doc.fontSize(22).fillColor("#7c3aed").text("Coinvane", { continued: false });
    doc.fontSize(10).fillColor("#64748b").text("Full data export", { continued: false });
    doc.moveDown(1.5);
    doc.fontSize(11).fillColor("#0f172a")
      .text(`Account: ${me?.name || me?.email}`)
      .text(`Generated: ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`);
    doc.moveDown(1);

    // ── Summary ──────────────────────────────────────────────────
    doc.fontSize(14).fillColor("#0f172a").text("Summary");
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor("#475569")
      .text(`Net worth: ${fmt(netWorth)}`)
      .text(`Cash & savings: ${fmt(totals.cash)}`)
      .text(`Investments: ${fmt(totals.investment)}`)
      .text(`Credit card debt: ${fmt(Math.abs(totals.credit))}`)
      .text(`Accounts: ${accounts.length}  ·  Transactions: ${txns.length}  ·  Budgets: ${budgets.length}  ·  Goals: ${goals.length}`);
    doc.moveDown(1);

    const section = (title) => {
      if (doc.y > 700) doc.addPage();
      doc.moveDown(0.5);
      doc.fontSize(13).fillColor("#0f172a").text(title);
      doc.moveDown(0.3);
      doc.fontSize(9).fillColor("#0f172a");
    };
    const row = (cols) => {
      if (doc.y > 720) doc.addPage();
      doc.text(cols.join("   ·   "), { lineGap: 1 });
    };

    // ── Accounts ─────────────────────────────────────────────────
    section("Accounts");
    if (accounts.length === 0) doc.fillColor("#94a3b8").text("None.");
    for (const a of accounts) {
      row([`${a.institution || "Manual"} — ${a.name}`, a.type + (a.subtype ? "/" + a.subtype : ""), fmt(a.balance)]);
    }

    // ── Budgets ──────────────────────────────────────────────────
    section("Budgets");
    if (budgets.length === 0) doc.fillColor("#94a3b8").text("None.");
    for (const b of budgets) {
      row([b.accountName ? `[${b.accountName}]` : b.category, fmt(b.amount)]);
    }

    // ── Goals ────────────────────────────────────────────────────
    section("Goals");
    if (goals.length === 0) doc.fillColor("#94a3b8").text("None.");
    for (const g of goals) {
      const pct = Math.round((Number(g.saved) / Number(g.target)) * 100);
      row([g.name, `${fmt(g.saved)} / ${fmt(g.target)} (${pct}%)`, g.deadline || ""]);
    }

    // ── Transactions ─────────────────────────────────────────────
    section("Transactions (last 500)");
    if (txns.length === 0) doc.fillColor("#94a3b8").text("None.");
    for (const t of txns) {
      const sign = Number(t.amount) >= 0 ? "+" : "−";
      row([
        String(t.date).slice(0, 10),
        (t.merchant || "").slice(0, 32),
        t.category || "",
        (t.accountName || "—").slice(0, 22),
        `${sign}${fmt(Math.abs(Number(t.amount)))}`,
      ]);
    }

    // ── Notes ────────────────────────────────────────────────────
    section("Notes");
    if (notes.length === 0) doc.fillColor("#94a3b8").text("None.");
    for (const n of notes) {
      doc.moveDown(0.4);
      doc.fillColor("#0f172a").fontSize(10).text(n.title || "(untitled)");
      doc.fontSize(9).fillColor("#475569");
      // Notes content uses an "enc:v1:" prefix when encrypted at rest.
      let body = n.content || "";
      if (body.startsWith("enc:v1:")) {
        try { body = decrypt(body.slice(7)); }
        catch { body = "[encrypted — could not decrypt]"; }
      }
      doc.text(body || "", { lineGap: 1 });
    }

    doc.end();
    return reply;
  });

  // ── Monthly summary PDF ──────────────────────────────────────────
  // Single-month view: income vs expenses, categories, top merchants.
  // Query: ?month=YYYY-MM (defaults to current month).
  app.get("/monthly.pdf", async (req, reply) => {
    const PDFDocument = (await import("pdfkit")).default;
    const userId = req.user.id;
    const now = new Date();
    const monthParam = String(req.query?.month || "").match(/^\d{4}-\d{2}$/)?.[0]
      || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const [y, m] = monthParam.split("-").map(Number);
    const from = `${y}-${String(m).padStart(2, "0")}-01`;
    const nextMonth = new Date(y, m, 1);
    const to = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}-01`;

    const summary = await queryOne(
      `SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
              SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) AS spending
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ? AND t.date >= ? AND t.date < ?
         AND (a.type IS NULL OR a.type <> 'credit')
         AND (t.is_transfer = 0 OR t.is_transfer IS NULL)
         AND (t.is_scheduled = 0 OR t.is_scheduled IS NULL)
         AND t.voided_at IS NULL`,
      [userId, from, to]
    );
    const cats = await query(
      `SELECT category, SUM(ABS(amount)) AS total, COUNT(*) AS count
       FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ? AND t.amount < 0 AND t.date >= ? AND t.date < ?
         AND (a.type IS NULL OR a.type <> 'credit')
         AND (t.is_transfer = 0 OR t.is_transfer IS NULL)
         AND t.voided_at IS NULL
       GROUP BY category ORDER BY total DESC`,
      [userId, from, to]
    );
    const topMerchants = await query(
      `SELECT merchant, SUM(ABS(amount)) AS total, COUNT(*) AS count
       FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ? AND t.amount < 0 AND t.date >= ? AND t.date < ?
         AND (a.type IS NULL OR a.type <> 'credit')
         AND (t.is_transfer = 0 OR t.is_transfer IS NULL)
         AND t.voided_at IS NULL
       GROUP BY merchant ORDER BY total DESC LIMIT 15`,
      [userId, from, to]
    );

    const fmt = (n) => "$" + Number(n || 0).toFixed(2);
    reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="coinvane-monthly-${monthParam}.pdf"`);
    const doc = new PDFDocument({ size: "LETTER", margin: 50 });
    reply.send(doc);

    doc.fontSize(22).fillColor("#7c3aed").text("Monthly Summary");
    doc.fontSize(11).fillColor("#64748b").text(monthParam);
    doc.moveDown(1);

    const income = Number(summary?.income || 0);
    const spending = Number(summary?.spending || 0);
    const net = income - spending;
    doc.fontSize(14).fillColor("#0f172a").text("Totals");
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor("#475569")
      .text(`Income:   ${fmt(income)}`)
      .text(`Spending: ${fmt(spending)}`)
      .text(`Net:      ${net >= 0 ? "+" : "−"}${fmt(Math.abs(net))}`);
    doc.moveDown(1);

    doc.fontSize(13).fillColor("#0f172a").text("Spending by category");
    doc.moveDown(0.3);
    doc.fontSize(9);
    if (cats.length === 0) doc.fillColor("#94a3b8").text("None.");
    for (const c of cats) {
      const pct = spending > 0 ? Math.round((Number(c.total) / spending) * 100) : 0;
      doc.fillColor("#0f172a").text(`${c.category}   ·   ${fmt(c.total)}   ·   ${c.count} txn   ·   ${pct}%`);
    }
    doc.moveDown(1);

    doc.fontSize(13).fillColor("#0f172a").text("Top merchants");
    doc.moveDown(0.3);
    doc.fontSize(9);
    if (topMerchants.length === 0) doc.fillColor("#94a3b8").text("None.");
    for (const m of topMerchants) {
      doc.fillColor("#0f172a").text(`${(m.merchant || "").slice(0, 40)}   ·   ${fmt(m.total)}   ·   ${m.count} txn`);
    }
    doc.end();
    return reply;
  });

  // ── Year-over-year category comparison PDF ───────────────────────
  // Groups spending by category for two calendar years and shows the delta.
  app.get("/category-yoy.pdf", async (req, reply) => {
    const PDFDocument = (await import("pdfkit")).default;
    const now = new Date();
    const thisYear = Number(req.query?.year) || now.getFullYear();
    const lastYear = thisYear - 1;
    const yearTotals = async (y) => query(
      `SELECT category, SUM(ABS(amount)) AS total
       FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ? AND t.amount < 0 AND YEAR(t.date) = ?
         AND (a.type IS NULL OR a.type <> 'credit')
         AND (t.is_transfer = 0 OR t.is_transfer IS NULL)
         AND t.voided_at IS NULL
       GROUP BY category`,
      [req.user.id, y]
    );
    const [curr, prev] = await Promise.all([yearTotals(thisYear), yearTotals(lastYear)]);
    const map = new Map();
    for (const r of prev) map.set(r.category, { category: r.category, prev: Number(r.total), curr: 0 });
    for (const r of curr) {
      const e = map.get(r.category) || { category: r.category, prev: 0, curr: 0 };
      e.curr = Number(r.total);
      map.set(r.category, e);
    }
    const rows = [...map.values()].sort((a, b) => b.curr - a.curr);

    const fmt = (n) => "$" + Number(n || 0).toFixed(2);
    reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="coinvane-yoy-${thisYear}.pdf"`);
    const doc = new PDFDocument({ size: "LETTER", margin: 50 });
    reply.send(doc);

    doc.fontSize(22).fillColor("#7c3aed").text("Year-over-Year");
    doc.fontSize(11).fillColor("#64748b").text(`${lastYear} vs ${thisYear}`);
    doc.moveDown(1);
    doc.fontSize(9).fillColor("#0f172a");
    if (rows.length === 0) doc.fillColor("#94a3b8").text("No data in the compared years.");
    for (const r of rows) {
      const delta = r.curr - r.prev;
      const pct = r.prev > 0 ? Math.round(((r.curr - r.prev) / r.prev) * 100) : (r.curr > 0 ? 100 : 0);
      const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "·";
      doc.fillColor("#0f172a").text(
        `${(r.category || "").slice(0, 24).padEnd(24)}   ${fmt(r.prev).padStart(10)}   →   ${fmt(r.curr).padStart(10)}   ${arrow}${pct >= 0 ? "+" : ""}${pct}%`
      );
    }
    doc.end();
    return reply;
  });

  // ── Budget performance PDF ───────────────────────────────────────
  app.get("/budgets.pdf", async (req, reply) => {
    const PDFDocument = (await import("pdfkit")).default;
    const budgets = await query(
      `SELECT b.category, b.amount, a.name AS accountName, b.rollover_credit
       FROM budgets b LEFT JOIN accounts a ON a.id = b.account_id
       WHERE b.user_id = ? ORDER BY b.sort_order, b.id`,
      [req.user.id]
    );
    // MTD spending per category for a rough "on-track" view.
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const spend = await query(
      `SELECT category, SUM(ABS(amount)) AS total
       FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ? AND t.amount < 0 AND t.date >= ?
         AND (a.type IS NULL OR a.type <> 'credit')
         AND (t.is_transfer = 0 OR t.is_transfer IS NULL)
         AND t.voided_at IS NULL
       GROUP BY category`,
      [req.user.id, monthStart]
    );
    const spent = new Map(spend.map(s => [s.category, Number(s.total)]));
    const fmt = (n) => "$" + Number(n || 0).toFixed(2);
    reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="coinvane-budgets.pdf"`);
    const doc = new PDFDocument({ size: "LETTER", margin: 50 });
    reply.send(doc);

    doc.fontSize(22).fillColor("#7c3aed").text("Budget Performance");
    doc.fontSize(11).fillColor("#64748b").text(`Month-to-date · ${monthStart.slice(0, 7)}`);
    doc.moveDown(1);
    doc.fontSize(9).fillColor("#0f172a");
    if (budgets.length === 0) doc.fillColor("#94a3b8").text("No budgets set.");
    for (const b of budgets) {
      const spentAmount = spent.get(b.category) || 0;
      const cap = Number(b.amount) + Number(b.rollover_credit || 0);
      const pct = cap > 0 ? Math.round((spentAmount / cap) * 100) : 0;
      const over = spentAmount > cap;
      doc.fillColor(over ? "#dc2626" : "#0f172a").text(
        `${(b.category || "").slice(0, 20).padEnd(20)}   ${fmt(spentAmount).padStart(10)} / ${fmt(cap).padStart(10)}   ${pct}%${over ? "  OVER" : ""}`
      );
    }
    doc.end();
    return reply;
  });

  // ── Tax summary PDF (year-end IRS Schedule rollup) ───────────────
  //   Groups deductible-flagged transactions + tax-scheduled category
  //   transactions into IRS Schedule buckets (A/B/C/D/E) and renders a
  //   filing-companion summary. Not filing-grade — this is meant to be
  //   handed to a CPA or dropped alongside your 1040 as reference.
  app.get("/tax-summary.pdf", async (req, reply) => {
    const PDFDocument = (await import("pdfkit")).default;
    const year = Number(req.query?.year) || new Date().getFullYear();
    const rows = await query(
      `SELECT
         COALESCE(c.tax_schedule, IF(t.is_deductible = 1, 'A', NULL)) AS schedule,
         t.category, t.date, t.merchant, t.amount
       FROM transactions t
       LEFT JOIN categories c
         ON c.user_id = t.user_id AND c.name = t.category
       WHERE t.user_id = ?
         AND YEAR(t.date) = ?
         AND (t.is_transfer = 0 OR t.is_transfer IS NULL)
         AND (t.is_scheduled = 0 OR t.is_scheduled IS NULL)
         AND t.voided_at IS NULL
         AND (c.tax_schedule IS NOT NULL OR t.is_deductible = 1)
       ORDER BY schedule, t.category, t.date`,
      [req.user.id, year]
    );
    const schedules = { A: [], B: [], C: [], D: [], E: [] };
    const totals = { A: 0, B: 0, C: 0, D: 0, E: 0 };
    for (const r of rows) {
      if (!schedules[r.schedule]) continue;
      schedules[r.schedule].push(r);
      totals[r.schedule] += Number(r.amount);
    }
    const scheduleTitles = {
      A: "Schedule A — Itemized Deductions",
      B: "Schedule B — Interest & Dividends",
      C: "Schedule C — Business Profit / Loss",
      D: "Schedule D — Capital Gains",
      E: "Schedule E — Rental / Royalty",
    };

    const fmt = (n) => "$" + Number(n || 0).toFixed(2);
    reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="coinvane-tax-summary-${year}.pdf"`);
    const doc = new PDFDocument({ size: "LETTER", margin: 50 });
    reply.send(doc);

    doc.fontSize(22).fillColor("#7c3aed").text("Tax Summary");
    doc.fontSize(11).fillColor("#64748b").text(`Tax year ${year}`);
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor("#64748b")
      .text("This is a filing-companion report — not filing-grade output. Hand it to your preparer.");
    doc.moveDown(1);

    // ── Totals band ──────────────────────────────────────────────
    doc.fontSize(13).fillColor("#0f172a").text("Totals by schedule");
    doc.moveDown(0.4);
    doc.fontSize(10);
    let anyRows = false;
    for (const code of ["A", "B", "C", "D", "E"]) {
      if (schedules[code].length === 0) continue;
      anyRows = true;
      const t = totals[code];
      const sign = t >= 0 ? "+" : "−";
      doc.fillColor("#0f172a")
        .text(`${scheduleTitles[code]}: ${sign}${fmt(Math.abs(t))} (${schedules[code].length} entries)`);
    }
    if (!anyRows) doc.fillColor("#94a3b8")
      .text(`No tax-tagged transactions in ${year}. Assign a Schedule to a category or flag individual transactions as deductible.`);
    doc.moveDown(1);

    // ── Per-schedule detail ──────────────────────────────────────
    for (const code of ["A", "B", "C", "D", "E"]) {
      const list = schedules[code];
      if (list.length === 0) continue;
      if (doc.y > 640) doc.addPage();
      doc.fontSize(13).fillColor("#0f172a").text(scheduleTitles[code]);
      doc.moveDown(0.3);
      doc.fontSize(9).fillColor("#0f172a");
      // Group by category for readability.
      const byCat = new Map();
      for (const r of list) {
        const k = r.category || "Other";
        if (!byCat.has(k)) byCat.set(k, []);
        byCat.get(k).push(r);
      }
      for (const [cat, txns] of byCat.entries()) {
        if (doc.y > 700) doc.addPage();
        const catTotal = txns.reduce((s, r) => s + Number(r.amount), 0);
        doc.fillColor("#0f172a").fontSize(10)
          .text(`${cat}   ·   ${catTotal >= 0 ? "+" : "−"}${fmt(Math.abs(catTotal))}   ·   ${txns.length} txn`);
        doc.fontSize(8).fillColor("#64748b");
        for (const r of txns) {
          if (doc.y > 720) doc.addPage();
          const sign = Number(r.amount) >= 0 ? "+" : "−";
          doc.text(`   ${String(r.date).slice(0, 10)}  ${(r.merchant || "").slice(0, 36).padEnd(36)}  ${sign}${fmt(Math.abs(Number(r.amount)))}`, { lineGap: 0 });
        }
        doc.moveDown(0.4);
      }
      doc.moveDown(0.4);
    }

    doc.end();
    return reply;
  });

  // ── Bills & loans summary PDF ────────────────────────────────────
  app.get("/bills-loans.pdf", async (req, reply) => {
    const PDFDocument = (await import("pdfkit")).default;
    const bills = await query(
      `SELECT b.name, b.category, b.cycle, b.expected_amount, b.average_amount,
              b.autopay, bc.due_date, bc.paid_at
       FROM bills b
       LEFT JOIN bill_cycles bc ON bc.bill_id = b.id
       WHERE b.user_id = ? AND b.archived_at IS NULL
         AND (bc.id IS NULL OR bc.id = (
           SELECT MAX(bc2.id) FROM bill_cycles bc2 WHERE bc2.bill_id = b.id
         ))
       ORDER BY b.name`,
      [req.user.id]
    );
    const loans = await query(
      `SELECT name, loan_type, principal, current_balance, apr,
              term_months, monthly_payment, start_date
       FROM loans WHERE user_id = ? AND archived_at IS NULL ORDER BY name`,
      [req.user.id]
    );
    const fmt = (n) => "$" + Number(n || 0).toFixed(2);
    reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="coinvane-bills-loans.pdf"`);
    const doc = new PDFDocument({ size: "LETTER", margin: 50 });
    reply.send(doc);

    doc.fontSize(22).fillColor("#7c3aed").text("Bills & Loans");
    doc.fontSize(11).fillColor("#64748b").text("Recurring obligations + debt payoff snapshot");
    doc.moveDown(1);

    doc.fontSize(14).fillColor("#0f172a").text("Bills");
    doc.moveDown(0.4);
    doc.fontSize(9);
    if (bills.length === 0) doc.fillColor("#94a3b8").text("None.");
    for (const b of bills) {
      const state = b.paid_at ? "Paid" : (b.due_date ? `Due ${b.due_date}` : "");
      doc.fillColor("#0f172a").text(
        `${(b.name || "").slice(0, 24).padEnd(24)}   ${b.cycle.padEnd(12)}   ${fmt(b.expected_amount).padStart(10)}   ${b.autopay ? "autopay" : "manual"}   ${state}`
      );
    }
    doc.moveDown(1);

    doc.fontSize(14).fillColor("#0f172a").text("Loans");
    doc.moveDown(0.4);
    doc.fontSize(9);
    if (loans.length === 0) doc.fillColor("#94a3b8").text("None.");
    for (const l of loans) {
      const paidOff = Number(l.principal) > 0
        ? Math.round(((Number(l.principal) - Number(l.current_balance)) / Number(l.principal)) * 100)
        : 0;
      doc.fillColor("#0f172a").text(
        `${(l.name || "").slice(0, 24).padEnd(24)}   ${(l.loan_type || "other").padEnd(12)}   ${fmt(l.current_balance).padStart(10)} / ${fmt(l.principal).padStart(10)}   ${Number(l.apr).toFixed(2)}% APR   ${paidOff}% paid`
      );
    }
    doc.end();
    return reply;
  });

  // ── Loan amortization PDF (Stage B) ───────────────────────────────
  // Month-by-month schedule for a single loan. Uses standard fixed-
  // payment amortization (interest = balance × rate/12, principal =
  // payment − interest). Extra payment optional. Capped at 720 months
  // to match the LoanCard client-side cap.
  app.get("/amortization.pdf", async (req, reply) => {
    const PDFDocument = (await import("pdfkit")).default;
    const loanId = Number(req.query?.loan_id);
    if (!loanId) return reply.code(400).send({ error: "loan_id required" });
    const loan = await queryOne(
      `SELECT id, name, principal, current_balance, apr, term_months,
              extra_payment, escrow_tax, escrow_insurance, escrow_pmi, escrow_other
       FROM loans WHERE id = ? AND user_id = ?`,
      [loanId, req.user.id]
    );
    if (!loan) return reply.code(404).send({ error: "loan not found" });

    const balance0 = Number(loan.current_balance || loan.principal);
    const monthlyRate = (Number(loan.apr) / 100) / 12;
    const term = Number(loan.term_months) || 360;
    // Standard mortgage formula. If APR is 0, straight-line principal.
    const pmt = monthlyRate > 0
      ? balance0 * (monthlyRate * Math.pow(1 + monthlyRate, term)) / (Math.pow(1 + monthlyRate, term) - 1)
      : balance0 / term;
    const extra = Number(loan.extra_payment) || 0;
    const escrow = Number(loan.escrow_tax || 0) + Number(loan.escrow_insurance || 0)
      + Number(loan.escrow_pmi || 0) + Number(loan.escrow_other || 0);

    const rows = [];
    let bal = balance0;
    let totalInterest = 0;
    for (let m = 1; m <= 720 && bal > 0.01; m++) {
      const interest = bal * monthlyRate;
      let principal = pmt + extra - interest;
      if (principal > bal) principal = bal;
      bal -= principal;
      totalInterest += interest;
      rows.push({ m, interest, principal, escrow, bal });
      if (bal <= 0.01) break;
    }

    const fmt = (n) => "$" + Number(n || 0).toFixed(2);
    reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="coinvane-amort-${loan.name.replace(/\W+/g, "-").slice(0, 24)}.pdf"`);
    const doc = new PDFDocument({ size: "LETTER", margin: 40 });
    reply.send(doc);
    doc.fontSize(20).fillColor("#7c3aed").text("Amortization Schedule");
    doc.fontSize(10).fillColor("#64748b").text(loan.name);
    doc.moveDown(0.4);
    doc.fontSize(9).fillColor("#334155")
      .text(`Balance: ${fmt(balance0)} · APR ${Number(loan.apr).toFixed(2)}% · Payment ${fmt(pmt)}${extra > 0 ? ` + ${fmt(extra)} extra` : ""}${escrow > 0 ? ` + ${fmt(escrow)} escrow` : ""}`)
      .text(`Total interest paid: ${fmt(totalInterest)} · Payoff in ${rows.length} months`);
    doc.moveDown(0.6);
    const cols = { m: 40, int: 110, prin: 200, esc: 300, bal: 400 };
    doc.fontSize(8).fillColor("#0f172a");
    doc.text("Month", cols.m, doc.y, { continued: true });
    doc.text("Interest", cols.int, doc.y - doc.currentLineHeight(), { continued: true });
    doc.text("Principal", cols.prin, doc.y - doc.currentLineHeight(), { continued: true });
    if (escrow > 0) doc.text("Escrow", cols.esc, doc.y - doc.currentLineHeight(), { continued: true });
    doc.text("Balance", cols.bal, doc.y - doc.currentLineHeight());
    doc.moveTo(40, doc.y + 2).lineTo(560, doc.y + 2).strokeColor("#94a3b8").stroke();
    doc.moveDown(0.3);
    for (const r of rows) {
      const y = doc.y;
      doc.text(String(r.m), cols.m, y, { width: 60 });
      doc.text(fmt(r.interest), cols.int, y, { width: 80 });
      doc.text(fmt(r.principal), cols.prin, y, { width: 90 });
      if (escrow > 0) doc.text(fmt(r.escrow), cols.esc, y, { width: 90 });
      doc.text(fmt(r.bal), cols.bal, y, { width: 100 });
      if (doc.y > 720) doc.addPage();
    }
    doc.end();
    return reply;
  });

  // ── Plain register PDF (Stage 4a) ─────────────────────────────────
  // Bare, print-friendly account register — no Coinvane branding, no
  // decoration, no summary. Just the columns Quicken's classic Ctrl+P
  // gave you: date · check# · merchant · category · amount · balance.
  // Respects the same filter surface as the register: account, date
  // range, category, cleared status.
  app.get("/register.pdf", async (req, reply) => {
    const PDFDocument = (await import("pdfkit")).default;
    const userId = req.user.id;
    const { accountId, from, to, category, cleared } = req.query || {};
    const where = ["t.user_id = ?"];
    const params = [userId];
    if (accountId) { where.push("t.account_id = ?"); params.push(accountId); }
    if (from)      { where.push("t.date >= ?"); params.push(from); }
    if (to)        { where.push("t.date <= ?"); params.push(to); }
    if (category)  { where.push("t.category = ?"); params.push(category); }
    if (cleared === "cleared")    where.push("t.cleared = 1 AND t.reconciliation_id IS NULL");
    if (cleared === "uncleared")  where.push("(t.cleared = 0 OR t.cleared IS NULL)");
    if (cleared === "reconciled") where.push("t.reconciliation_id IS NOT NULL");
    where.push("t.voided_at IS NULL");
    where.push("(t.is_scheduled = 0 OR t.is_scheduled IS NULL)");
    const rows = await query(
      `SELECT t.date, t.check_number AS checkNumber, t.merchant, t.category,
              t.amount, t.cleared, t.reconciliation_id AS reconciliationId,
              a.name AS accountName
       FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
       WHERE ${where.join(" AND ")}
       ORDER BY t.date ASC, t.id ASC
       LIMIT 2000`,
      params
    );
    // Running balance is only meaningful when scoped to a single account,
    // otherwise the number would jump between accounts. Compute from the
    // account's current balance minus everything after the visible range.
    let openingBalance = 0;
    let showBalance = false;
    if (accountId) {
      const acc = await queryOne(
        "SELECT name, balance FROM accounts WHERE id = ? AND user_id = ?",
        [accountId, userId]
      );
      if (acc) {
        const rest = await queryOne(
          `SELECT COALESCE(SUM(amount), 0) AS delta
           FROM transactions
           WHERE user_id = ? AND account_id = ? AND voided_at IS NULL
             AND (is_scheduled = 0 OR is_scheduled IS NULL)
             AND (id > (SELECT COALESCE(MAX(id), 0) FROM transactions
                        WHERE user_id = ? AND account_id = ?
                          AND date <= (SELECT MAX(date) FROM transactions
                                       WHERE user_id = ? AND account_id = ?)))`,
          [userId, accountId, userId, accountId, userId, accountId]
        );
        openingBalance = Number(acc.balance) - Number(rest?.delta || 0)
          - rows.reduce((s, r) => s + Number(r.amount), 0);
        showBalance = true;
      }
    }

    const fmt = (n) => (Number(n) >= 0 ? "+" : "−") + "$" + Math.abs(Number(n || 0)).toFixed(2);
    reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="coinvane-register.pdf"`);
    const doc = new PDFDocument({ size: "LETTER", margin: 40 });
    reply.send(doc);

    doc.fontSize(14).fillColor("#0f172a").text("Account Register");
    doc.fontSize(9).fillColor("#64748b").text(
      `${from || "start"} → ${to || "today"}${category ? " · " + category : ""}`
    );
    doc.moveDown(0.5);

    // Column layout
    const cols = { date: 40, chk: 100, payee: 150, cat: 310, amt: 430, bal: 500 };
    doc.fontSize(8).fillColor("#334155");
    doc.text("Date",     cols.date,  doc.y, { continued: true });
    doc.text("Chk#",     cols.chk,   doc.y - doc.currentLineHeight(), { continued: true });
    doc.text("Payee",    cols.payee, doc.y - doc.currentLineHeight(), { continued: true });
    doc.text("Category", cols.cat,   doc.y - doc.currentLineHeight(), { continued: true });
    doc.text("Amount",   cols.amt,   doc.y - doc.currentLineHeight(), { continued: true });
    if (showBalance) doc.text("Balance", cols.bal, doc.y - doc.currentLineHeight());
    else doc.text("");
    doc.moveTo(40, doc.y + 2).lineTo(560, doc.y + 2).strokeColor("#94a3b8").stroke();
    doc.moveDown(0.3);

    doc.fontSize(8).fillColor("#0f172a");
    let running = openingBalance;
    for (const r of rows) {
      running += Number(r.amount);
      const status = r.reconciliationId ? "R" : (r.cleared ? "c" : " ");
      const y = doc.y;
      doc.text(String(r.date).slice(0, 10), cols.date, y, { width: 55 });
      doc.text((r.checkNumber || "") + status, cols.chk, y, { width: 40 });
      doc.text((r.merchant || "").slice(0, 32), cols.payee, y, { width: 155 });
      doc.text((r.category || "").slice(0, 20), cols.cat, y, { width: 115 });
      doc.text(fmt(r.amount), cols.amt, y, { width: 65 });
      if (showBalance) doc.text(fmt(running), cols.bal, y, { width: 60 });
      if (doc.y > 720) { doc.addPage(); }
    }
    doc.end();
    return reply;
  });
}
