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
      .header("Content-Disposition", `attachment; filename="ledger-export.pdf"`);

    const doc = new PDFDocument({ size: "LETTER", margin: 50 });
    reply.send(doc);

    // ── Cover ────────────────────────────────────────────────────
    doc.fontSize(22).fillColor("#059669").text("Ledger", { continued: false });
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
}
