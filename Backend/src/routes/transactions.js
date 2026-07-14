// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "../db.js";
import { runRulesForTrigger } from "../automation-engine.js";

// Update a manual account's balance by the given delta.
// Plaid-linked accounts are NEVER touched here — their balances come from Plaid sync.
async function adjustManualAccountBalance(userId, accountId, delta) {
  if (!accountId || !delta) return;
  const acc = await queryOne(
    "SELECT id, plaid_item_id FROM accounts WHERE id = ? AND user_id = ?",
    [accountId, userId]
  );
  if (!acc || acc.plaid_item_id) return; // not ours or Plaid-managed
  await query(
    "UPDATE accounts SET balance = balance + ? WHERE id = ?",
    [delta, accountId]
  );
}

export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (req) => {
    const { limit = 100, offset = 0, category, accountId, search, from, to } = req.query;
    const where = ["t.user_id = ?"];
    const params = [req.user.id];
    if (category)  { where.push("t.category = ?"); params.push(category); }
    if (accountId) { where.push("t.account_id = ?"); params.push(accountId); }
    if (search)    { where.push("t.merchant LIKE ?"); params.push(`%${search}%`); }
    if (from)      { where.push("t.date >= ?"); params.push(from); }
    if (to)        { where.push("t.date <= ?"); params.push(to); }
    // Scheduled rows are excluded from the main list — they show in the
    // dedicated /scheduled endpoint at the top of the Transactions tab.
    // Once adopted (is_scheduled flips to 0) they reappear here naturally.
    where.push("(t.is_scheduled = 0 OR t.is_scheduled IS NULL)");

    // Collapse detected transfer pairs to a SINGLE row in the list. Both
    // sides still exist in the DB (so account balances remain accurate) but
    // for display we keep just the outgoing (most negative) leg — that's
    // the row the source account "sees". The correlated `transfer_group_id`
    // is returned so the client can render a blue Transfer pill.
    where.push(`(
      t.transfer_group_id IS NULL
      OR t.id = (
        SELECT MIN(t2.id) FROM transactions t2
        WHERE t2.transfer_group_id = t.transfer_group_id
          AND t2.amount = (
            SELECT MIN(t3.amount) FROM transactions t3
            WHERE t3.transfer_group_id = t.transfer_group_id
          )
      )
    )`);

    params.push(Number(limit), Number(offset));
    const rows = await query(
      `SELECT t.id, t.date, t.merchant, t.category, t.amount, t.pending, t.note,
              t.is_transfer AS isTransfer, t.transfer_group_id AS transferGroupId,
              t.is_scheduled AS isScheduled,
              t.has_automation_error AS hasAutomationError,
              t.paystub_json AS paystubJson,
              a.name AS accountName, a.id AS accountId, a.plaid_item_id AS plaidItemId
       FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
       WHERE ${where.join(" AND ")} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`,
      params
    );
    // Parse the paystub blob into structured JSON server-side so the client
    // doesn't have to double-parse and doesn't crash if the blob is
    // malformed. Bad blobs surface as `paystub: null`.
    for (const r of rows) {
      if (r.paystubJson) {
        try { r.paystub = JSON.parse(r.paystubJson); }
        catch { r.paystub = null; }
      } else {
        r.paystub = null;
      }
      delete r.paystubJson;
    }
    return rows;
  });

  app.post("/", async (req, reply) => {
    const { date, merchant, category, amount, accountId, note } = req.body || {};
    if (!date || !merchant || amount === undefined) {
      return reply.code(400).send({ error: "date, merchant, amount required" });
    }
    const r = await query(
      `INSERT INTO transactions (user_id, account_id, date, merchant, category, amount, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, accountId || null, date, merchant, category || "Other", amount, note || null]
    );
    // Reflect the change in the linked manual account's balance
    // (income +, expense −). Plaid accounts are skipped.
    await adjustManualAccountBalance(req.user.id, accountId, Number(amount));
    // Fire automation triggers for manual creates too. `account_type`
    // pulled fresh so rules can key on cash/credit/etc. Errors don't
    // block the response — the engine is silent-fail by design.
    const row = await queryOne(
      `SELECT t.id, t.merchant, t.category, t.amount, t.account_id,
              t.pending, t.is_transfer, t.date, a.type AS account_type
       FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.id = ?`,
      [r.insertId]
    );
    if (row) {
      const ctx = {
        transaction: {
          id: row.id, merchant: row.merchant, category: row.category,
          amount: Number(row.amount), account_id: row.account_id,
          account_type: row.account_type, pending: !!row.pending,
          is_transfer: !!row.is_transfer, date: row.date,
        },
      };
      await runRulesForTrigger(req.user.id, "transaction_arrived", ctx);
      if (Number(row.amount) > 0 && !row.is_transfer) {
        await runRulesForTrigger(req.user.id, "income_landed", ctx);
      }
    }
    return queryOne("SELECT * FROM transactions WHERE id = ?", [r.insertId]);
  });

  // ── Scheduled transactions ─────────────────────────────────────────
  // Purpose-built list for the "Scheduled income" section at the top of
  // the Transactions tab. Ordered by expected date (earliest first) so the
  // upcoming ones surface first regardless of when they were scheduled.
  app.get("/scheduled", async (req) => {
    const rows = await query(
      `SELECT t.id, t.date, t.merchant, t.category, t.amount, t.note,
              t.paystub_json AS paystubJson,
              a.name AS accountName, a.id AS accountId
       FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ? AND t.is_scheduled = 1
       ORDER BY t.date ASC, t.id ASC`,
      [req.user.id]
    );
    for (const r of rows) {
      if (r.paystubJson) {
        try { r.paystub = JSON.parse(r.paystubJson); }
        catch { r.paystub = null; }
      } else {
        r.paystub = null;
      }
      delete r.paystubJson;
    }
    return rows;
  });

  // Create a scheduled row. Distinguished from regular POST / by the
  // `is_scheduled: true` flag. The row is invisible to budget/income
  // rollups until adopted by a Plaid sync or manually flipped.
  app.post("/scheduled", async (req, reply) => {
    const { date, merchant, category, amount, accountId, note, paystub } = req.body || {};
    if (!date || !merchant || amount === undefined) {
      return reply.code(400).send({ error: "date, merchant, amount required" });
    }
    // Ownership check the account if one was supplied.
    if (accountId) {
      const owned = await queryOne(
        "SELECT id FROM accounts WHERE id = ? AND user_id = ?",
        [accountId, req.user.id]
      );
      if (!owned) return reply.code(400).send({ error: "invalid account" });
    }
    const paystubJson = paystub ? JSON.stringify(paystub) : null;
    const r = await query(
      `INSERT INTO transactions
         (user_id, account_id, date, merchant, category, amount, note,
          is_scheduled, scheduled_at, paystub_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW(), ?)`,
      [req.user.id, accountId || null, date, merchant,
       category || "Other", amount, note || null, paystubJson]
    );
    return queryOne("SELECT * FROM transactions WHERE id = ?", [r.insertId]);
  });

  // Manual override: flip is_scheduled on an existing row. Used by the
  // detail sheet's "Actually already arrived — remove pending marker"
  // action if the auto-matcher missed, or by the schedule flow to demote
  // a synced row into a scheduled placeholder.
  app.patch("/:id/scheduled", async (req, reply) => {
    const { is_scheduled } = req.body || {};
    if (typeof is_scheduled !== "boolean") {
      return reply.code(400).send({ error: "is_scheduled boolean required" });
    }
    const owned = await queryOne(
      "SELECT id FROM transactions WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    if (!owned) return reply.code(404).send({ error: "not found" });
    await query(
      "UPDATE transactions SET is_scheduled = ? WHERE id = ? AND user_id = ?",
      [is_scheduled ? 1 : 0, req.params.id, req.user.id]
    );
    return { ok: true };
  });

  // Dedicated paystub-detail endpoint. Body: { paystub: <object> | null }.
  // Null clears the attached detail. The client-owned schema is opaque here
  // — we just JSON-stringify and store. Guarded by user ownership.
  app.put("/:id/paystub", async (req, reply) => {
    const owned = await queryOne(
      "SELECT id FROM transactions WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    if (!owned) return reply.code(404).send({ error: "not found" });
    const { paystub } = req.body || {};
    const json = paystub == null ? null : JSON.stringify(paystub);
    // Cap the payload so a malicious client can't stuff a multi-MB blob
    // into every row. 32 KB is far more than the deepest real-world
    // paystub (~1–2 KB per statement).
    if (json && json.length > 32 * 1024) {
      return reply.code(413).send({ error: "paystub payload too large" });
    }
    await query(
      "UPDATE transactions SET paystub_json = ? WHERE id = ? AND user_id = ?",
      [json, req.params.id, req.user.id]
    );
    return { ok: true };
  });

  app.patch("/:id", async (req) => {
    const { merchant, category, amount, note, date } = req.body || {};
    // If amount changes on a manual account txn, adjust balance by the delta.
    // Scheduled rows are excluded (see DELETE handler above).
    const existing = await queryOne(
      "SELECT account_id, amount, is_scheduled FROM transactions WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    await query(
      `UPDATE transactions SET
         merchant = COALESCE(?, merchant),
         category = COALESCE(?, category),
         amount = COALESCE(?, amount),
         note = COALESCE(?, note),
         date = COALESCE(?, date)
       WHERE id = ? AND user_id = ?`,
      [merchant ?? null, category ?? null, amount ?? null, note ?? null, date ?? null,
       req.params.id, req.user.id]
    );
    if (existing && !existing.is_scheduled
        && amount !== undefined && Number(amount) !== Number(existing.amount)) {
      const delta = Number(amount) - Number(existing.amount);
      await adjustManualAccountBalance(req.user.id, existing.account_id, delta);
    }
    return queryOne("SELECT * FROM transactions WHERE id = ?", [req.params.id]);
  });

  app.delete("/:id", async (req) => {
    // Reverse the balance impact before deleting. Scheduled rows never
    // touched the manual-account balance on creation (see POST /scheduled),
    // so we skip the reversal for them — otherwise deleting a scheduled
    // paycheck would fictitiously debit the account.
    const existing = await queryOne(
      "SELECT account_id, amount, is_scheduled FROM transactions WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    await query("DELETE FROM transactions WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]);
    if (existing && !existing.is_scheduled) {
      await adjustManualAccountBalance(req.user.id, existing.account_id, -Number(existing.amount));
    }
    return { ok: true };
  });

  app.get("/by-category", async (req) => {
    const { from, to } = req.query;
    const params = [req.user.id];
    let dateClause = "";
    if (from) { dateClause += " AND t.date >= ?"; params.push(from); }
    if (to)   { dateClause += " AND t.date <= ?"; params.push(to); }
    // Credit-account expenses excluded — consistent with category budgets and
    // the income/cashflow rollups. Credit purchases get tallied via the
    // credit-usage tracker, not category totals.
    return query(
      `SELECT t.category, SUM(ABS(t.amount)) AS total, COUNT(*) AS count
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ? AND t.amount < 0
         AND (a.type IS NULL OR a.type <> 'credit')
         AND (t.is_transfer = 0 OR t.is_transfer IS NULL)
         AND (t.is_scheduled = 0 OR t.is_scheduled IS NULL)
         ${dateClause}
       GROUP BY t.category ORDER BY total DESC`,
      params
    );
  });

  app.get("/cashflow", async (req) => {
    // Credit-card transactions are excluded so the dashboard income/spending
    // bars line up with the budget + income trackers, all of which treat
    // credit accounts as their own world (see budgets.js for the same rule).
    // Internal transfers are also excluded — moving money between your own
    // accounts is not income or spending.
    return query(
      `SELECT DATE_FORMAT(t.date, '%Y-%m') AS month,
              SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) AS income,
              SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END) AS spending
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ?
         AND t.date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
         AND (a.type IS NULL OR a.type <> 'credit')
         AND (t.is_transfer = 0 OR t.is_transfer IS NULL)
         AND (t.is_scheduled = 0 OR t.is_scheduled IS NULL)
       GROUP BY month ORDER BY month`,
      [req.user.id]
    );
  });

  // ── Recategorise all transactions sharing a merchant name + save rule.
  //    Feature 3 — "apply to all from same name" flow.
  //    Body: { merchant, category }. Scope is strictly the calling user.
  app.post("/recategorize-merchant", async (req, reply) => {
    const { merchant, category } = req.body || {};
    if (!merchant || !category) {
      return reply.code(400).send({ error: "merchant and category required" });
    }
    // Save rule (per-user)
    await query(
      `INSERT INTO merchant_rules (user_id, merchant, category)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE category = VALUES(category)`,
      [req.user.id, merchant, category]
    );
    // Apply retroactively to all matching transactions for THIS user only
    const r = await query(
      `UPDATE transactions SET category = ?
       WHERE user_id = ? AND merchant = ?`,
      [category, req.user.id, merchant]
    );
    return { ok: true, updated: r.affectedRows || 0 };
  });

  // ── Manage merchant rules ──────────────────────────────────────
  app.get("/merchant-rules", async (req) => {
    return query(
      `SELECT id, merchant, category, created_at AS createdAt
       FROM merchant_rules WHERE user_id = ? ORDER BY merchant`,
      [req.user.id]
    );
  });

  app.delete("/merchant-rules/:id", async (req) => {
    await query("DELETE FROM merchant_rules WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]);
    return { ok: true };
  });

  // Clear ALL user-created merchant rules. App-shipped defaults
  // (is_default=TRUE) are preserved so future seeded rules survive.
  app.delete("/merchant-rules", async (req) => {
    const r = await query(
      `DELETE FROM merchant_rules WHERE user_id = ? AND (is_default = 0 OR is_default IS NULL)`,
      [req.user.id]
    );
    return { ok: true, deleted: r.affectedRows || 0 };
  });

  // ── CSV export ─────────────────────────────────────────────────
  // Streams CSV of the user's transactions. Schema:
  //   date,merchant,category,amount,account,note,pending
  // Header line included.
  app.get("/export.csv", async (req, reply) => {
    const rows = await query(
      `SELECT t.date, t.merchant, t.category, t.amount, t.note, t.pending,
              a.name AS accountName
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ?
       ORDER BY t.date DESC, t.id DESC`,
      [req.user.id]
    );
    const escape = (s) => {
      if (s === null || s === undefined) return "";
      const v = String(s);
      return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    };
    const lines = ["date,merchant,category,amount,account,note,pending"];
    for (const r of rows) {
      lines.push([
        r.date, escape(r.merchant), escape(r.category), r.amount,
        escape(r.accountName), escape(r.note), r.pending ? "1" : "0",
      ].join(","));
    }
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="ledger-transactions.csv"`);
    return lines.join("\n");
  });

  // ── CSV import ─────────────────────────────────────────────────
  // Accepts the same schema we export. Body is the raw CSV string
  // (Content-Type: text/csv). Accounts are matched by NAME against the
  // user's accounts; rows whose account name doesn't match an existing
  // account are imported as account-less (manual transactions with no
  // balance adjustment). Returns counts.
  app.post("/import.csv", {
    // The default 512KB body limit applies to JSON; CSV imports can be
    // bigger. Bump just this route to 5MB. (Fastify v5: bodyLimit is a
    // top-level route option, NOT nested in `config`.)
    bodyLimit: 5 * 1024 * 1024,
    config: {
      rateLimit: { max: 5, timeWindow: "1 minute" },
    },
  }, async (req, reply) => {
    const raw = typeof req.body === "string"
      ? req.body
      : req.body?.csv || "";
    if (!raw || raw.length < 5) {
      return reply.code(400).send({ error: "Empty CSV body" });
    }
    // Lazy import — papaparse is only loaded when this route fires
    const Papa = (await import("papaparse")).default;
    const parsed = Papa.parse(raw.trim(), { header: true, skipEmptyLines: true });
    if (parsed.errors?.length) {
      return reply.code(400).send({ error: "CSV parse error: " + parsed.errors[0].message });
    }
    const accounts = await query(
      "SELECT id, name FROM accounts WHERE user_id = ?",
      [req.user.id]
    );
    const acctByName = new Map(
      accounts.map(a => [a.name.toLowerCase().trim(), a.id])
    );
    let imported = 0, skipped = 0;
    for (const row of parsed.data) {
      const date = String(row.date || "").slice(0, 10);
      const merchant = String(row.merchant || "").trim();
      const category = String(row.category || "Other").trim() || "Other";
      const amount = Number(row.amount);
      const accountName = String(row.account || "").toLowerCase().trim();
      const note = row.note ? String(row.note) : null;
      const pending = row.pending === "1" || row.pending === 1 || row.pending === true;
      if (!date || !merchant || !Number.isFinite(amount)) { skipped++; continue; }
      const accountId = acctByName.get(accountName) || null;
      try {
        await query(
          `INSERT INTO transactions (user_id, account_id, date, merchant, category, amount, note, pending)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [req.user.id, accountId, date, merchant, category, amount, note, pending ? 1 : 0]
        );
        imported++;
      } catch (e) {
        // Duplicate plaid_transaction_id unique constraint won't bite since
        // we don't set it on imports; any other failure → skip.
        skipped++;
      }
    }
    return { ok: true, imported, skipped };
  });
}
