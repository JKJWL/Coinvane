// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "../db.js";
import { runRulesForTrigger } from "../automation-engine.js";
import { parseAny } from "../quicken-import.js";
import { promises as fs } from "fs";
import path from "path";

// Receipt attachments live on disk, one file per transaction. The path is
// stored in DB but the file is authoritative. A DB row without a matching
// file surfaces as a broken thumbnail (rare — only if operator manually
// deleted the volume) and vice versa.
const ATTACHMENTS_ROOT = process.env.ATTACHMENTS_ROOT || "/data/attachments";

// Rate limits — enforced in-code against attachment_upload_log.
//   3 uploads / transaction / 5 min
//   50 uploads / user / 30 min
const TXN_LIMIT_COUNT = 3;
const TXN_LIMIT_WINDOW_SEC = 5 * 60;
const USER_LIMIT_COUNT = 50;
const USER_LIMIT_WINDOW_SEC = 30 * 60;

// Only PNG / JPG. No PDF, no WebP.
const ALLOWED_MIMES = new Set(["image/png", "image/jpeg", "image/jpg"]);
const EXT_FOR = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg" };

// A row is a split child if its note was seeded by split_txn. Same note
// prefix the automation action writes (see automation-actions.js).
function isSplitChildNote(note) {
  return typeof note === "string" && note.startsWith("Split from #");
}

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
    const { limit = 100, offset = 0, category, accountId, search, from, to,
            sort = "date_desc", hasReceipt } = req.query;
    const where = ["t.user_id = ?"];
    const params = [req.user.id];
    if (category)  { where.push("t.category = ?"); params.push(category); }
    if (accountId) { where.push("t.account_id = ?"); params.push(accountId); }
    if (search)    { where.push("t.merchant LIKE ?"); params.push(`%${search}%`); }
    if (from)      { where.push("t.date >= ?"); params.push(from); }
    if (to)        { where.push("t.date <= ?"); params.push(to); }
    if (hasReceipt === "1" || hasReceipt === "true") {
      where.push("t.has_attachment = 1");
    }
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

    // Sort whitelist. `has_receipt` puts rows with an attachment first,
    // then falls back to newest-first inside each group so the receipts
    // list itself is still chronologically sensible.
    const ORDER_BY = {
      date_desc:     "t.date DESC, t.id DESC",
      date_asc:      "t.date ASC, t.id ASC",
      amount_asc:    "t.amount ASC, t.date DESC",
      amount_desc:   "t.amount DESC, t.date DESC",
      has_receipt:   "t.has_attachment DESC, t.date DESC, t.id DESC",
    };
    const orderBy = ORDER_BY[sort] || ORDER_BY.date_desc;
    params.push(Number(limit), Number(offset));
    const rows = await query(
      `SELECT t.id, t.date, t.merchant, t.category, t.amount, t.pending, t.note,
              t.is_transfer AS isTransfer, t.transfer_group_id AS transferGroupId,
              t.is_scheduled AS isScheduled,
              t.has_automation_error AS hasAutomationError,
              t.has_attachment AS hasAttachment,
              t.cleared AS cleared,
              t.reconciliation_id AS reconciliationId,
              t.is_deductible AS isDeductible,
              t.paystub_json AS paystubJson,
              a.name AS accountName, a.id AS accountId, a.plaid_item_id AS plaidItemId
       FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
       WHERE ${where.join(" AND ")} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
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
    // Include the full flag surface so the client's detail sheet knows
    // this is a scheduled row (and can therefore show Mark Present).
    // The main GET / hides scheduled rows entirely, so this endpoint is
    // the ONLY source of them — omitting isScheduled here left the
    // Mark Present button rendering under `!!detail.isScheduled` which
    // was always undefined.
    const rows = await query(
      `SELECT t.id, t.date, t.merchant, t.category, t.amount, t.pending, t.note,
              t.is_scheduled AS isScheduled,
              t.is_transfer AS isTransfer, t.transfer_group_id AS transferGroupId,
              t.has_automation_error AS hasAutomationError,
              t.has_attachment AS hasAttachment,
              t.paystub_json AS paystubJson,
              a.name AS accountName, a.id AS accountId, a.plaid_item_id AS plaidItemId
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

  // Manual classification override. Body: { classification: "income" | "expense" | "transfer" }.
  // Lets the user correct a mis-classified transaction from the detail sheet:
  //   income   → is_transfer=0, amount forced positive, transfer_group_id cleared
  //   expense  → is_transfer=0, amount forced negative, transfer_group_id cleared
  //   transfer → is_transfer=1 (amount sign preserved)
  // If the row was previously half of a detected transfer pair, the OTHER leg
  // is also unpaired (is_transfer=0, group cleared) so we don't leave a solo
  // "transfer" row silently excluded from rollups. Sign flips on manual-
  // account rows adjust the account balance by the delta.
  app.patch("/:id/classify", async (req, reply) => {
    const { classification } = req.body || {};
    if (!["income", "expense", "transfer"].includes(classification)) {
      return reply.code(400).send({ error: "classification must be income, expense, or transfer" });
    }
    const existing = await queryOne(
      `SELECT id, account_id, amount, is_scheduled, is_transfer, transfer_group_id
       FROM transactions WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!existing) return reply.code(404).send({ error: "not found" });

    const oldAmount = Number(existing.amount);
    let newAmount = oldAmount;
    let newIsTransfer = 0;
    let clearGroup = true;

    if (classification === "income") {
      newAmount = Math.abs(oldAmount);
    } else if (classification === "expense") {
      newAmount = -Math.abs(oldAmount);
    } else {
      newIsTransfer = 1;
      clearGroup = false; // keep the pairing intact when marking as transfer
    }

    await query(
      `UPDATE transactions
       SET amount = ?, is_transfer = ?${clearGroup ? ", transfer_group_id = NULL" : ""}
       WHERE id = ? AND user_id = ?`,
      [newAmount, newIsTransfer, req.params.id, req.user.id]
    );

    // Unpair the other side too if we broke a transfer group.
    if (clearGroup && existing.transfer_group_id) {
      await query(
        `UPDATE transactions
         SET is_transfer = 0, transfer_group_id = NULL
         WHERE transfer_group_id = ? AND user_id = ?`,
        [existing.transfer_group_id, req.user.id]
      );
    }

    // Sign flip on a manual account: reflect the delta in the balance.
    if (!existing.is_scheduled && newAmount !== oldAmount) {
      await adjustManualAccountBalance(
        req.user.id, existing.account_id, newAmount - oldAmount
      );
    }
    return { ok: true };
  });

  // ── Manual split ─────────────────────────────────────────────────
  // Body: { splits: [{ category, amount, note? }, ...] }.
  // Reduces the parent by sum(splits) and inserts N children on the
  // same account/date/merchant, matching the semantics of the
  // split_txn automation action so a manual split and an automated
  // split behave identically downstream. Sum must be <= |parent|
  // (partial split is allowed; residual stays on the parent).
  //
  // Manual splits fire the same "[Split into N]" note guard so a
  // subsequent automation split-fire won't double up.
  app.post("/:id/split", async (req, reply) => {
    const splits = Array.isArray(req.body?.splits) ? req.body.splits : [];
    const valid = splits
      .filter(s => Number(s.amount) > 0 && String(s.category || "").trim().length > 0)
      .slice(0, 20); // hard cap so a client bug can't insert thousands of rows
    if (valid.length === 0) {
      return reply.code(400).send({ error: "At least one split with category + amount > 0 required" });
    }
    const row = await queryOne(
      `SELECT id, amount, note, account_id, date, merchant, has_attachment
       FROM transactions WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!row) return reply.code(404).send({ error: "not found" });
    if (row.note && row.note.includes("[Split into ")) {
      return reply.code(409).send({ error: "Already split" });
    }
    if (isSplitChildNote(row.note)) {
      return reply.code(409).send({ error: "Can't split a split child — split the parent instead" });
    }
    const origAmount = Number(row.amount);
    const sign = origAmount >= 0 ? 1 : -1;
    const total = valid.reduce((s, x) => s + Number(x.amount), 0);
    if (total > Math.abs(origAmount) + 0.01) {
      return reply.code(400).send({
        error: `Split total $${total.toFixed(2)} exceeds transaction amount $${Math.abs(origAmount).toFixed(2)}`,
      });
    }
    const remaining = Math.abs(origAmount) - total;
    const newNote = row.note
      ? `${row.note} [Split into ${valid.length}]`
      : `[Split into ${valid.length}]`;
    await query(
      "UPDATE transactions SET amount = ?, note = ? WHERE id = ? AND user_id = ?",
      [sign * remaining, newNote, row.id, req.user.id]
    );
    for (const s of valid) {
      await query(
        `INSERT INTO transactions
           (user_id, account_id, date, merchant, category, amount, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          req.user.id, row.account_id, row.date, row.merchant,
          String(s.category).trim().slice(0, 64),
          sign * Number(s.amount),
          (s.note ? String(s.note).slice(0, 500) : `Split from #${row.id}`),
        ]
      );
    }
    return {
      ok: true,
      splitCount: valid.length,
      parentRemaining: sign * remaining,
    };
  });

  // ── Receipt attachments ──────────────────────────────────────────
  // Upload (multipart, field name "file"). Enforces:
  //   - PNG / JPG only, 5 MB max (multipart limits are the hard wall,
  //     mime-check here is the soft wall so we can 400 with a friendly
  //     message before the client tries again)
  //   - per-txn: 3 uploads / 5 min
  //   - per-user: 50 uploads / 30 min
  //   - split children can't have their own receipt
  //   - replace-on-reupload: old file unlinked, DB row overwritten
  // Per-route rate limit declared for CodeQL js/missing-rate-limiting.
  // The in-code windowing above (3/txn/5min + 50/user/30min) is the real
  // guard; this is a per-IP belt-and-suspenders that also makes the
  // static analyser happy.
  app.post("/:id/attachment", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const row = await queryOne(
      `SELECT id, note, attachment_path FROM transactions
       WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!row) return reply.code(404).send({ error: "not found" });
    if (isSplitChildNote(row.note)) {
      return reply.code(400).send({
        error: "Split children can't hold receipts — attach the receipt to the parent transaction",
      });
    }

    // Rate-limit windowing. Prune once, then count.
    await query(
      "DELETE FROM attachment_upload_log WHERE uploaded_at < (NOW() - INTERVAL 30 MINUTE)"
    );
    const userCount = await queryOne(
      `SELECT COUNT(*) AS n FROM attachment_upload_log
       WHERE user_id = ? AND uploaded_at > (NOW() - INTERVAL ? SECOND)`,
      [req.user.id, USER_LIMIT_WINDOW_SEC]
    );
    if (Number(userCount?.n || 0) >= USER_LIMIT_COUNT) {
      return reply.code(429).send({
        error: `Too many uploads. Limit is ${USER_LIMIT_COUNT} per 30 minutes.`,
        retryAfterSeconds: USER_LIMIT_WINDOW_SEC,
      });
    }
    const txnCount = await queryOne(
      `SELECT COUNT(*) AS n FROM attachment_upload_log
       WHERE transaction_id = ? AND uploaded_at > (NOW() - INTERVAL ? SECOND)`,
      [row.id, TXN_LIMIT_WINDOW_SEC]
    );
    if (Number(txnCount?.n || 0) >= TXN_LIMIT_COUNT) {
      return reply.code(429).send({
        error: `Too many uploads for this transaction. Limit is ${TXN_LIMIT_COUNT} per 5 minutes.`,
        retryAfterSeconds: TXN_LIMIT_WINDOW_SEC,
      });
    }

    // Pull the multipart file. @fastify/multipart auto-rejects if the
    // request isn't multipart or the file exceeds fileSize.
    let file;
    try {
      file = await req.file();
    } catch (err) {
      return reply.code(400).send({ error: "invalid upload: " + (err.message || err) });
    }
    if (!file) return reply.code(400).send({ error: "no file uploaded" });
    const mime = String(file.mimetype || "").toLowerCase();
    if (!ALLOWED_MIMES.has(mime)) {
      // Drain the stream so the connection can be reused.
      try { await file.toBuffer(); } catch { /* ignore */ }
      return reply.code(400).send({ error: "PNG or JPG only" });
    }
    const buf = await file.toBuffer();
    if (buf.length > 5 * 1024 * 1024) {
      return reply.code(413).send({ error: "file too large (5 MB max)" });
    }

    // Write to disk. Path: /data/attachments/{userId}/{txnId}.{ext}
    // Replace-on-reupload: if a previous file exists, unlink first (we
    // may be swapping png ↔ jpg so the extension can change).
    const userDir = path.join(ATTACHMENTS_ROOT, String(req.user.id));
    await fs.mkdir(userDir, { recursive: true });
    if (row.attachment_path) {
      try { await fs.unlink(path.join(ATTACHMENTS_ROOT, row.attachment_path)); }
      catch { /* file gone already, that's fine */ }
    }
    const ext = EXT_FOR[mime];
    const relPath = path.join(String(req.user.id), `${row.id}.${ext}`).replace(/\\/g, "/");
    const absPath = path.join(ATTACHMENTS_ROOT, relPath);
    await fs.writeFile(absPath, buf);

    await query(
      `UPDATE transactions SET
         has_attachment = 1, attachment_path = ?, attachment_mimetype = ?,
         attachment_size = ?, attachment_uploaded_at = NOW()
       WHERE id = ? AND user_id = ?`,
      [relPath, mime, buf.length, row.id, req.user.id]
    );
    await query(
      "INSERT INTO attachment_upload_log (user_id, transaction_id) VALUES (?, ?)",
      [req.user.id, row.id]
    );
    return { ok: true, size: buf.length, mimetype: mime };
  });

  // Serve the raw image inline. Auth-gated (preHandler above), path never
  // sent as-is to the filesystem — always looked up from the DB row.
  // Per-route rate limit for CodeQL js/missing-rate-limiting. Users may
  // reload / expand the same receipt many times in a session, so 120/min.
  app.get("/:id/attachment", {
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const row = await queryOne(
      `SELECT attachment_path, attachment_mimetype, attachment_size, merchant
       FROM transactions WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!row || !row.attachment_path) return reply.code(404).send({ error: "no attachment" });
    const absPath = path.join(ATTACHMENTS_ROOT, row.attachment_path);
    let data;
    try { data = await fs.readFile(absPath); }
    catch { return reply.code(404).send({ error: "file missing on disk" }); }
    return reply
      .header("Content-Type", row.attachment_mimetype || "application/octet-stream")
      .header("Content-Length", row.attachment_size || data.length)
      .header("Cache-Control", "private, no-cache")
      .send(data);
  });

  app.delete("/:id/attachment", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const row = await queryOne(
      `SELECT attachment_path FROM transactions WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!row) return reply.code(404).send({ error: "not found" });
    if (row.attachment_path) {
      try { await fs.unlink(path.join(ATTACHMENTS_ROOT, row.attachment_path)); }
      catch { /* file gone already, that's fine */ }
    }
    await query(
      `UPDATE transactions SET
         has_attachment = 0, attachment_path = NULL, attachment_mimetype = NULL,
         attachment_size = NULL, attachment_uploaded_at = NULL
       WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.id]
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
    const { merchant, category, amount, note, date, is_deductible } = req.body || {};
    // If amount changes on a manual account txn, adjust balance by the delta.
    // Scheduled rows are excluded (see DELETE handler above).
    const existing = await queryOne(
      "SELECT account_id, amount, is_scheduled FROM transactions WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    const deductibleBit = is_deductible === undefined
      ? null : (is_deductible ? 1 : 0);
    await query(
      `UPDATE transactions SET
         merchant = COALESCE(?, merchant),
         category = COALESCE(?, category),
         amount = COALESCE(?, amount),
         note = COALESCE(?, note),
         date = COALESCE(?, date),
         is_deductible = COALESCE(?, is_deductible)
       WHERE id = ? AND user_id = ?`,
      [merchant ?? null, category ?? null, amount ?? null, note ?? null, date ?? null,
       deductibleBit, req.params.id, req.user.id]
    );
    if (existing && !existing.is_scheduled
        && amount !== undefined && Number(amount) !== Number(existing.amount)) {
      const delta = Number(amount) - Number(existing.amount);
      await adjustManualAccountBalance(req.user.id, existing.account_id, delta);
    }
    return queryOne("SELECT * FROM transactions WHERE id = ?", [req.params.id]);
  });

  app.delete("/:id", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req) => {
    // Reverse the balance impact before deleting. Scheduled rows never
    // touched the manual-account balance on creation (see POST /scheduled),
    // so we skip the reversal for them — otherwise deleting a scheduled
    // paycheck would fictitiously debit the account.
    const existing = await queryOne(
      `SELECT account_id, amount, is_scheduled, attachment_path
       FROM transactions WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.id]
    );
    await query("DELETE FROM transactions WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]);
    if (existing && !existing.is_scheduled) {
      await adjustManualAccountBalance(req.user.id, existing.account_id, -Number(existing.amount));
    }
    // Best-effort file cleanup — a broken file left on disk isn't fatal
    // (surfaces as a 404 on next fetch) but we prefer not to leak.
    if (existing?.attachment_path) {
      try { await fs.unlink(path.join(ATTACHMENTS_ROOT, existing.attachment_path)); }
      catch { /* ignore */ }
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
    //
    // Optional `from` / `to` (YYYY-MM-DD) let the dashboard KPI's period
    // chip drive the range. Default remains the last 12 months so
    // callers with no params keep the old behaviour.
    const { from, to, forecastMonths } = req.query || {};
    const params = [req.user.id];
    let dateClause = "";
    if (from) { dateClause += " AND t.date >= ?"; params.push(from); }
    if (to)   { dateClause += " AND t.date <= ?"; params.push(to);   }
    if (!from && !to) {
      dateClause += " AND t.date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)";
    }
    const historic = await query(
      `SELECT DATE_FORMAT(t.date, '%Y-%m') AS month,
              SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) AS income,
              SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END) AS spending
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ?
         AND (a.type IS NULL OR a.type <> 'credit')
         AND (t.is_transfer = 0 OR t.is_transfer IS NULL)
         AND (t.is_scheduled = 0 OR t.is_scheduled IS NULL)
         ${dateClause}
       GROUP BY month ORDER BY month`,
      params
    );
    // Forecast: aggregate future scheduled transactions + open bill
    // cycles (unpaid, un-skipped) into month buckets. Only fires when
    // forecastMonths is passed and > 0. Clamped to 12 as an upper bound
    // so a malicious client can't ask for 100 years.
    const fm = Math.max(0, Math.min(12, Number(forecastMonths) || 0));
    if (fm > 0) {
      // Windows: current month through +fm months (inclusive of the
      // current month so partial-month scheduled items merge with the
      // historic bar rather than duplicating it).
      const now = new Date();
      const startYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const endMonth = new Date(now.getFullYear(), now.getMonth() + fm, 1);
      const endYm = `${endMonth.getFullYear()}-${String(endMonth.getMonth() + 1).padStart(2, "0")}`;

      // Scheduled transactions in window.
      const scheduled = await query(
        `SELECT DATE_FORMAT(date, '%Y-%m') AS month,
                SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
                SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) AS spending
         FROM transactions
         WHERE user_id = ? AND is_scheduled = 1
           AND DATE_FORMAT(date, '%Y-%m') BETWEEN ? AND ?
         GROUP BY month`,
        [req.user.id, startYm, endYm]
      );
      // Open bill cycles due in window (they represent expected outflows).
      const billOutflows = await query(
        `SELECT DATE_FORMAT(bc.due_date, '%Y-%m') AS month,
                SUM(bc.expected_amount) AS spending
         FROM bill_cycles bc
         JOIN bills b ON b.id = bc.bill_id AND b.archived_at IS NULL
         WHERE bc.user_id = ?
           AND bc.paid_at IS NULL AND bc.skipped = 0
           AND DATE_FORMAT(bc.due_date, '%Y-%m') BETWEEN ? AND ?
         GROUP BY month`,
        [req.user.id, startYm, endYm]
      );

      // Merge everything by month. If a month already appears in
      // historic (e.g. current month), we overlay forecast additions.
      const buckets = new Map();
      for (const h of historic) buckets.set(h.month, { month: h.month, income: Number(h.income), spending: Number(h.spending), forecast: false });
      for (const s of scheduled) {
        const cur = buckets.get(s.month) || { month: s.month, income: 0, spending: 0, forecast: true };
        cur.income   += Number(s.income);
        cur.spending += Number(s.spending);
        // If it's future-only (no historic anchor) mark forecast.
        if (!buckets.has(s.month)) cur.forecast = true;
        buckets.set(s.month, cur);
      }
      for (const bo of billOutflows) {
        const cur = buckets.get(bo.month) || { month: bo.month, income: 0, spending: 0, forecast: true };
        cur.spending += Number(bo.spending);
        if (!buckets.has(bo.month)) cur.forecast = true;
        buckets.set(bo.month, cur);
      }
      // Return sorted.
      return [...buckets.values()].sort((a, b) => a.month.localeCompare(b.month));
    }
    return historic;
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
      .header("Content-Disposition", `attachment; filename="coinvane-transactions.csv"`);
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

  // ── QIF / OFX / QFX import ─────────────────────────────────────
  // For migrating off Quicken, Mint, or any bank that only exports these
  // formats. Auto-detects which of the three the file is. `account_id`
  // param binds every imported row to a chosen account so the manual
  // balance adjustment matches what actually happened in the source
  // system. Sends back { format, imported, skipped } like CSV import.
  app.post("/import/quicken", {
    bodyLimit: 5 * 1024 * 1024,
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const raw = typeof req.body === "string"
      ? req.body
      : req.body?.content || "";
    const accountId = Number(req.body?.account_id) || null;
    if (!raw || raw.length < 5) {
      return reply.code(400).send({ error: "Empty import body" });
    }
    // Guard against binary + oversize junk sooner than the bodyLimit trips.
    if (raw.length > 5 * 1024 * 1024) {
      return reply.code(400).send({ error: "File too large (5 MB max)" });
    }
    const { format, transactions: parsed } = parseAny(raw);
    if (format === "unknown") {
      return reply.code(400).send({ error: "Unrecognized format — expected QIF, OFX, or QFX" });
    }
    // Validate the account belongs to the user (if supplied).
    let boundAccount = null;
    if (accountId) {
      boundAccount = await queryOne(
        "SELECT id, plaid_item_id FROM accounts WHERE id = ? AND user_id = ?",
        [accountId, req.user.id]
      );
      if (!boundAccount) return reply.code(400).send({ error: "account not found" });
    }
    let imported = 0, skipped = 0, balanceDelta = 0;
    for (const row of parsed) {
      if (!row.date || !row.merchant || !Number.isFinite(row.amount)) { skipped++; continue; }
      try {
        await query(
          `INSERT INTO transactions (user_id, account_id, date, merchant, category, amount, note)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [req.user.id, accountId || null, row.date, row.merchant,
           row.category || "Other", row.amount, row.note || null]
        );
        imported++;
        balanceDelta += Number(row.amount);
      } catch (e) {
        skipped++;
      }
    }
    // Manual-account balance is authoritative for manual accounts, so
    // shift it by the sum of imported amounts. Plaid-linked accounts are
    // untouched (their balance is pulled fresh from Plaid on next sync).
    if (boundAccount && !boundAccount.plaid_item_id && balanceDelta !== 0) {
      await adjustManualAccountBalance(req.user.id, accountId, balanceDelta);
    }
    return { ok: true, format, imported, skipped };
  });
}
