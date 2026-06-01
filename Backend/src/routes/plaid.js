// SPDX-License-Identifier: AGPL-3.0-or-later
import { plaid } from "../plaid-client.js";
import { query, queryOne } from "../db.js";
import { encrypt } from "../crypto.js";
import { verifyPlaidWebhook } from "../plaid-webhook-verify.js";
import { enqueueSync } from "../queue.js";
import { fullSyncItem } from "../sync.js";

export default async function (app) {
  app.post("/link-token", { preHandler: [app.authenticate] }, async (req) => {
    // REQUIRED: institution must support these. Keep this minimal so we don't
    // exclude banks/credit unions that don't offer brokerage data.
    const products = ["transactions"];

    // OPTIONAL: added to the Item only if the institution supports them.
    // Lets us still get investments from brokerages WITHOUT blocking credit unions.
    const optional_products = ["investments"];

    const config = {
      user: { client_user_id: String(req.user.id) },
      client_name: "Ledger",
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

    return { ok: true, item_id, plaid_item_pk: itemRow.id };
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