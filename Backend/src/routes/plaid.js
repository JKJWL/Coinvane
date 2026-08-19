// SPDX-License-Identifier: AGPL-3.0-or-later
import { plaid } from "../plaid-client.js";
import { query, queryOne } from "../db.js";
import { encrypt } from "../crypto.js";
import { verifyPlaidWebhook } from "../plaid-webhook-verify.js";
import { enqueueSync } from "../queue.js";
import { fullSyncItem } from "../sync.js";
import { audit } from "../audit.js";
import { PLAID_ENABLED } from "./auth.js";

export default async function (app) {
  // Manual-only mode gate — when PLAID_ENABLED() is false, EVERY route
  // in this plugin (including the public webhook) returns 404 so
  // Coinvane looks like it never had Plaid installed. The frontend
  // hides its own Plaid affordances via the plaid_enabled flag on the
  // /me payload, so a clean install in manual-only mode never surfaces
  // an endpoint that would 404.
  app.addHook("onRequest", async (req, reply) => {
    if (!PLAID_ENABLED()) {
      return reply.code(404).send({ error: "Not found" });
    }
  });
  app.post("/link-token", { preHandler: [app.authenticate] }, async (req) => {
    // REQUIRED: institution must support these. Keep this minimal so we don't
    // exclude banks/credit unions that don't offer brokerage data.
    const products = ["transactions"];

    // OPTIONAL: added to the Item only if the institution supports them.
    // Lets us still get investments from brokerages WITHOUT blocking credit unions.
    const optional_products = ["investments"];

    const config = {
      user: { client_user_id: String(req.user.id) },
      client_name: "Coinvane",
      products,
      optional_products,
      country_codes: ["US"],
      language: "en",
    };
    if (process.env.PLAID_WEBHOOK_URL) config.webhook = process.env.PLAID_WEBHOOK_URL;
    if (process.env.PLAID_REDIRECT_URI) config.redirect_uri = process.env.PLAID_REDIRECT_URI;

    const resp = await plaid.linkTokenCreate(config);
    return { link_token: resp.data.link_token, expiration: resp.data.expiration };
  });

  app.post("/exchange", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { public_token, metadata } = req.body || {};
    if (!public_token) return reply.code(400).send({ error: "public_token required" });

    const exch = await plaid.itemPublicTokenExchange({ public_token });
    const access_token = exch.data.access_token;
    const item_id = exch.data.item_id;

    const r = await query(
      `INSERT INTO plaid_items (user_id, plaid_item_id, access_token_enc, institution_id, institution_name)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE access_token_enc = VALUES(access_token_enc),
                                institution_name = VALUES(institution_name)`,
      [req.user.id, item_id, encrypt(access_token),
       metadata?.institution?.institution_id || null,
       metadata?.institution?.name || null]
    );

    const itemRow = await queryOne(
      "SELECT id FROM plaid_items WHERE plaid_item_id = ?", [item_id]
    );

    try { await fullSyncItem(req.user.id, itemRow.id); }
    catch (e) { req.log.warn({ err: e.message }, "initial sync error"); }

    // ── Stage 3: .cvn import → Plaid re-link auto-merge candidates ──
    // After the initial sync creates the Plaid-linked account rows,
    // look for manual accounts (plaid_item_id IS NULL) that came from
    // a .cvn import (imported_original_name set) whose name +
    // institution match a freshly-created Plaid account of this item.
    // We NEVER auto-merge — the response includes the candidate list
    // and the client shows a confirmation modal per match. Same-name
    // matching is case-insensitive with whitespace normalization so
    // "Chase Checking" adopts "  chase  checking  " but not "Chase
    // Savings".
    const norm = s => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
    const plaidAccts = await query(
      `SELECT id, name, institution, type, subtype, balance
       FROM accounts WHERE user_id = ? AND plaid_item_id = ?`,
      [req.user.id, itemRow.id]
    );
    const manualAccts = await query(
      `SELECT id, name, institution, type, subtype, balance,
              imported_original_name, imported_original_institution
       FROM accounts
       WHERE user_id = ? AND plaid_item_id IS NULL
         AND imported_original_name IS NOT NULL`,
      [req.user.id]
    );
    const candidates = [];
    for (const p of plaidAccts) {
      const pName = norm(p.name);
      const pInst = norm(p.institution);
      const m = manualAccts.find(x =>
        norm(x.imported_original_name) === pName
        && (
          // Prefer full match, but tolerate empty institution on one
          // side (Plaid sometimes returns a null institution on the
          // account object, or the import didn't carry it).
          norm(x.imported_original_institution) === pInst
          || !pInst || !norm(x.imported_original_institution)
        )
      );
      if (m) {
        // Count what would move on merge, so the UI can show
        // "Merges 483 transactions + 3 budgets + 1 goal..."
        const [txn, bud, gol, loa, ass, bil, rec, hol] = await Promise.all([
          queryOne(`SELECT COUNT(*) AS c FROM transactions WHERE user_id = ? AND account_id = ?`, [req.user.id, m.id]),
          queryOne(`SELECT COUNT(*) AS c FROM budgets       WHERE user_id = ? AND account_id = ?`, [req.user.id, m.id]),
          queryOne(`SELECT COUNT(*) AS c FROM goals         WHERE user_id = ? AND account_id = ?`, [req.user.id, m.id]),
          queryOne(`SELECT COUNT(*) AS c FROM loans         WHERE user_id = ? AND linked_account_id = ?`, [req.user.id, m.id]),
          queryOne(`SELECT COUNT(*) AS c FROM assets        WHERE user_id = ? AND loan_account_id = ?`, [req.user.id, m.id]),
          queryOne(`SELECT COUNT(*) AS c FROM bills         WHERE user_id = ? AND account_id = ?`, [req.user.id, m.id]),
          queryOne(`SELECT COUNT(*) AS c FROM reconciliations WHERE user_id = ? AND account_id = ?`, [req.user.id, m.id]),
          queryOne(`SELECT COUNT(*) AS c FROM holdings      WHERE user_id = ? AND account_id = ?`, [req.user.id, m.id]),
        ]);
        candidates.push({
          manual: {
            id: m.id, name: m.name, institution: m.institution,
            transactions: Number(txn?.c || 0),
            budgets: Number(bud?.c || 0),
            goals: Number(gol?.c || 0),
            loans: Number(loa?.c || 0),
            assets: Number(ass?.c || 0),
            bills: Number(bil?.c || 0),
            reconciliations: Number(rec?.c || 0),
            holdings: Number(hol?.c || 0),
          },
          plaid: {
            id: p.id, name: p.name, institution: p.institution,
            type: p.type, subtype: p.subtype,
          },
        });
      }
    }

    return { ok: true, item_id, plaid_item_pk: itemRow.id, mergeCandidates: candidates };
  });

  // ── POST /plaid/merge-manual ──────────────────────────────────────
  // Merges an imported manual account into a freshly-connected Plaid
  // account. Reparents every FK reference (transactions, budgets,
  // goals, loans, assets, bills, reconciliations, holdings, holding
  // lots) from the manual id to the Plaid id, then deletes the manual
  // account row. On the next Plaid sync, tryAdoptManual in sync.js
  // will dedup any overlap in the 30–90-day Plaid backfill window by
  // stamping plaid_transaction_id onto matching imported rows instead
  // of inserting duplicates.
  //
  // Both accounts must belong to the caller; the manual must actually
  // be manual (plaid_item_id NULL) and the Plaid must actually be
  // Plaid-linked. Otherwise 400 — silently succeeds is dangerous.
  app.post("/merge-manual", { preHandler: [app.authenticate] }, async (req, reply) => {
    const manualId = Number(req.body?.manualAccountId);
    const plaidId  = Number(req.body?.plaidAccountId);
    if (!manualId || !plaidId || manualId === plaidId) {
      return reply.code(400).send({ error: "manualAccountId and plaidAccountId required and must differ" });
    }
    const [manual, plaidAcct] = await Promise.all([
      queryOne(`SELECT id, plaid_item_id, name FROM accounts WHERE id = ? AND user_id = ?`, [manualId, req.user.id]),
      queryOne(`SELECT id, plaid_item_id, name FROM accounts WHERE id = ? AND user_id = ?`, [plaidId, req.user.id]),
    ]);
    if (!manual || !plaidAcct) return reply.code(404).send({ error: "account not found" });
    if (manual.plaid_item_id !== null) {
      return reply.code(400).send({ error: "Source account is already Plaid-linked, nothing to merge" });
    }
    if (plaidAcct.plaid_item_id === null) {
      return reply.code(400).send({ error: "Target account is not Plaid-linked" });
    }

    // Reparent every user-scoped table that carries an account FK.
    // Order doesn't matter — none of these UPDATEs affect each other.
    const moves = {};
    for (const [table, col] of [
      ["transactions",    "account_id"],
      ["budgets",         "account_id"],
      ["goals",           "account_id"],
      ["loans",           "linked_account_id"],
      ["assets",          "loan_account_id"],
      ["bills",           "account_id"],
      ["reconciliations", "account_id"],
      ["holdings",        "account_id"],
      ["holding_lots",    "account_id"],
    ]) {
      const r = await query(
        `UPDATE ${table} SET ${col} = ? WHERE user_id = ? AND ${col} = ?`,
        [plaidId, req.user.id, manualId]
      );
      moves[table] = r.affectedRows || 0;
    }

    // Now safe to delete the manual shell — nothing references it.
    await query(`DELETE FROM accounts WHERE id = ? AND user_id = ?`, [manualId, req.user.id]);

    await audit(req.user.id, "account.merged", req, {
      manualId, plaidId,
      manualName: manual.name, plaidName: plaidAcct.name,
      moves,
    }, { major: true });

    return { ok: true, moves };
  });

  app.get("/items", { preHandler: [app.authenticate] }, async (req) => {
    return query(
      `SELECT id, plaid_item_id AS plaidItemId, institution_name AS institutionName,
              last_sync_at AS lastSyncAt, created_at AS createdAt
       FROM plaid_items WHERE user_id = ? ORDER BY created_at DESC`,
      [req.user.id]
    );
  });

  app.delete("/items/:id", { preHandler: [app.authenticate] }, async (req) => {
    const item = await queryOne(
      "SELECT * FROM plaid_items WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    if (!item) return { ok: true };
    try {
      const { decrypt } = await import("../crypto.js");
      await plaid.itemRemove({ access_token: decrypt(item.access_token_enc) });
    } catch (e) {
      req.log.warn({ err: e.message }, "plaid itemRemove failed");
    }

    // BUG FIX: When the plaid_items row is deleted, the FK ON DELETE CASCADE
    // also wipes the linked accounts — but transactions reference accounts
    // via ON DELETE SET NULL, so they'd survive as orphans (account_id=NULL)
    // and continue polluting budget / income / net-worth calculations.
    // Explicitly delete them (and the per-account holdings + sync_cursor)
    // BEFORE cascading the item.
    await query(
      `DELETE FROM transactions
       WHERE user_id = ? AND account_id IN (
         SELECT id FROM accounts WHERE plaid_item_id = ?
       )`,
      [req.user.id, item.id]
    );
    await query(
      `DELETE FROM holdings
       WHERE user_id = ? AND account_id IN (
         SELECT id FROM accounts WHERE plaid_item_id = ?
       )`,
      [req.user.id, item.id]
    );
    // Now cascade the plaid_items delete (which removes its accounts).
    await query("DELETE FROM plaid_items WHERE id = ? AND user_id = ?",
      [item.id, req.user.id]);
    return { ok: true };
  });

  app.post("/sync", { preHandler: [app.authenticate] }, async (req) => {
    const items = await query("SELECT id FROM plaid_items WHERE user_id = ?", [req.user.id]);
    const jobs = [];
    for (const item of items) {
      const job = await enqueueSync({ userId: req.user.id, itemId: item.id, kind: "full" });
      jobs.push(job.id);
    }
    return { queued: jobs.length, jobIds: jobs };
  });

  // Plaid webhook — public endpoint, signature-verified inline.
  // Per-route rate limit (300 req/min/IP) sits in front of the
  // signature check so unbounded garbage payloads can't drain CPU
  // through repeated JWKS lookups + JWT verifies (each failure still
  // costs work). 300/min easily covers the legitimate Plaid burst
  // rate during an initial-link or multi-item sync; anything beyond
  // that is almost certainly abuse. The global 200/min on /api/*
  // doesn't apply here because rate-limit hooks check the per-route
  // config first when present, which is intentional: legitimate
  // Plaid traffic shouldn't compete with normal API usage from the
  // same proxy IP.
  app.post("/webhook", {
    config: {
      rawBody: true,
      rateLimit: { max: 300, timeWindow: "1 minute" },
    },
  }, async (req, reply) => {
    const headerToken = req.headers["plaid-verification"];
    try {
      await verifyPlaidWebhook(headerToken, req.rawBody);
    } catch (e) {
      req.log.warn({ err: e.message }, "webhook verification failed");
      return reply.code(401).send({ error: "Invalid signature" });
    }

    const { webhook_type, webhook_code, item_id } = req.body || {};
    req.log.info({ webhook_type, webhook_code, item_id }, "plaid webhook verified");

    if (webhook_type === "TRANSACTIONS" &&
        ["SYNC_UPDATES_AVAILABLE", "DEFAULT_UPDATE", "INITIAL_UPDATE", "HISTORICAL_UPDATE"].includes(webhook_code)) {
      const item = await queryOne("SELECT * FROM plaid_items WHERE plaid_item_id = ?", [item_id]);
      if (item) await enqueueSync({ userId: item.user_id, itemId: item.id, kind: "transactions" });
    }
    if (webhook_type === "HOLDINGS" && webhook_code === "DEFAULT_UPDATE") {
      const item = await queryOne("SELECT * FROM plaid_items WHERE plaid_item_id = ?", [item_id]);
      if (item) await enqueueSync({ userId: item.user_id, itemId: item.id, kind: "holdings" });
    }
    return reply.send({ ok: true });
  });
}