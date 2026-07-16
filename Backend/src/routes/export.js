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
       WHERE t.user_id = ? ORDER BY t.date DESC, t.id DESC LIMIT 500`, [userId]
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
         AND (t.is_scheduled = 0 OR t.is_scheduled IS NULL)`,
      [userId, from, to]
    );
    const cats = await query(
      `SELECT category, SUM(ABS(amount)) AS total, COUNT(*) AS count
       FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ? AND t.amount < 0 AND t.date >= ? AND t.date < ?
         AND (a.type IS NULL OR a.type <> 'credit')
         AND (t.is_transfer = 0 OR t.is_transfer IS NULL)
       GROUP BY category ORDER BY total DESC`,
      [userId, from, to]
    );
    const topMerchants = await query(
      `SELECT merchant, SUM(ABS(amount)) AS total, COUNT(*) AS count
       FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ? AND t.amount < 0 AND t.date >= ? AND t.date < ?
         AND (a.type IS NULL OR a.type <> 'credit')
         AND (t.is_transfer = 0 OR t.is_transfer IS NULL)
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
}
