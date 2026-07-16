// SPDX-License-Identifier: AGPL-3.0-or-later
import { plaid } from "./plaid-client.js";
import { query, queryOne } from "./db.js";
import { decrypt } from "./crypto.js";
import { runRulesForTrigger } from "./automation-engine.js";
import { tryMatchTransactionToBill } from "./bill-utils.js";
import crypto from "node:crypto";

const PLAID_TO_INTERNAL_TYPE = {
  depository: "cash", credit: "credit", loan: "loan",
  investment: "investment", other: "other",
};

const CATEGORY_MAP = {
  FOOD_AND_DRINK: "Restaurants", GROCERIES: "Groceries",
  GENERAL_MERCHANDISE: "Shopping", TRANSPORTATION: "Gas & Fuel",
  TRAVEL: "Travel", ENTERTAINMENT: "Entertainment",
  RENT_AND_UTILITIES: "Utilities", LOAN_PAYMENTS: "Other",
  MEDICAL: "Health & Fitness", PERSONAL_CARE: "Health & Fitness",
  INCOME: "Income", TRANSFER_IN: "Transfer", TRANSFER_OUT: "Transfer",
};

function normalizeCategory(c) { return CATEGORY_MAP[c] || "Other"; }

export async function syncAccounts(userId, itemId, accessToken, institutionName) {
  const resp = await plaid.accountsGet({ access_token: accessToken });
  for (const a of resp.data.accounts) {
    const internalType = PLAID_TO_INTERNAL_TYPE[a.type] || "other";
    const balance = a.type === "credit" || a.type === "loan"
      ? -Math.abs(a.balances.current || 0)
      : (a.balances.current || 0);
    await query(
      `INSERT INTO accounts (user_id, plaid_item_id, plaid_account_id, name, type, subtype,
                              balance, limit_amount, institution, last_sync_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE name = VALUES(name), balance = VALUES(balance),
                                limit_amount = VALUES(limit_amount), last_sync_at = NOW()`,
      [userId, itemId, a.account_id, a.name, internalType, a.subtype || null,
       balance, a.balances.limit || null, institutionName || null]
    );
  }
}

export async function syncTransactions(userId, itemId, accessToken) {
  const item = await queryOne("SELECT sync_cursor FROM plaid_items WHERE id = ?", [itemId]);
  let cursor = item?.sync_cursor || null;
  let added = [], modified = [], removed = [], hasMore = true;

  while (hasMore) {
    const resp = await plaid.transactionsSync({
      access_token: accessToken,
      cursor: cursor || undefined,
    });
    added = added.concat(resp.data.added);
    modified = modified.concat(resp.data.modified);
    removed = removed.concat(resp.data.removed);
    hasMore = resp.data.has_more;
    cursor = resp.data.next_cursor;
  }

  const accountMap = new Map(
    (await query(
      "SELECT id, plaid_account_id FROM accounts WHERE user_id = ? AND plaid_item_id = ?",
      [userId, itemId]
    )).map(a => [a.plaid_account_id, a.id])
  );

  // Load this user's merchant→category rules so their preferences win over
  // Plaid's classifier. (Per-user; never reads/writes another user's rules.)
  const ruleMap = new Map(
    (await query(
      "SELECT merchant, category FROM merchant_rules WHERE user_id = ?",
      [userId]
    )).map(r => [r.merchant.toLowerCase(), r.category])
  );

  // Track pending vs posted counts for diagnostics. The toast / worker
  // log shows these so the user can verify pending transactions are
  // actually arriving from their bank. Some banks (smaller credit unions
  // especially) only push transactions to Plaid AFTER they post — if you
  // ever see `pending: 0` after a recent swipe, that's a bank-side delay,
  // not a sync bug.
  let pendingAdded = 0, postedAdded = 0;

  let scheduledAdopted = 0;
  // Plaid transaction_ids for rows that ARE truly new this sync — used
  // after pairing to fire automation triggers only on new arrivals, not
  // on modified/re-synced rows (whose triggers already ran on first
  // landing). Adopted-scheduled rows also fire, since to the user they
  // "arrived" now even if the row id is old.
  const newPlaidIds = new Set(added.map(t => t.transaction_id));
  const adoptedIds = new Set();
  for (const t of [...added, ...modified]) {
    const accId = accountMap.get(t.account_id) || null;
    const merchant = t.merchant_name || t.name || "Unknown";
    const plaidCat = t.personal_finance_category?.primary || (t.category?.[0]) || "Other";
    // User-defined rule takes precedence over Plaid's category
    const finalCat = ruleMap.get(merchant.toLowerCase()) || normalizeCategory(plaidCat);
    // Plaid tagged transfer (strong signal). We flag the row now so the
    // pairing pass below can match it up with the other side even if that
    // side wasn't itself tagged.
    const plaidIsTransfer =
      plaidCat === "TRANSFER_IN" || plaidCat === "TRANSFER_OUT";
    if (t.pending) pendingAdded++; else postedAdded++;

    // ── Adopt a scheduled row if the incoming txn matches one ──
    // Same account, sign-matched amount within $5, date within ±3 days.
    // We match on the amount as stored (positive for income, negative for
    // expense) so a scheduled paycheck doesn't accidentally adopt an
    // outgoing bill of similar magnitude. Only rows without a
    // plaid_transaction_id are candidates — never touch an already-adopted
    // (or already-real) row. If a user has multiple candidates we pick
    // the closest by date, then by lowest id (deterministic).
    if (accId) {
      const adoptedId = await tryAdoptScheduled(
        userId, accId, -t.amount, t.date, t.transaction_id,
        merchant, finalCat, t.pending ? 1 : 0, plaidIsTransfer ? 1 : 0
      );
      if (adoptedId) {
        scheduledAdopted++;
        adoptedIds.add(adoptedId);
        continue;
      }
    }

    await query(
      `INSERT INTO transactions (user_id, account_id, plaid_transaction_id, date, merchant,
                                  category, amount, pending, is_transfer)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE date = VALUES(date), merchant = VALUES(merchant),
                                category = VALUES(category), amount = VALUES(amount),
                                pending = VALUES(pending),
                                is_transfer = GREATEST(is_transfer, VALUES(is_transfer))`,
      [userId, accId, t.transaction_id, t.date,
       merchant, finalCat, -t.amount, t.pending ? 1 : 0, plaidIsTransfer ? 1 : 0]
    );
  }

  for (const r of removed) {
    await query("DELETE FROM transactions WHERE plaid_transaction_id = ? AND user_id = ?",
      [r.transaction_id, userId]);
  }

  // Pair up two-sided transfers across the user's own accounts. Runs after
  // every sync so newly landed rows get grouped in the same pass.
  const pairedCount = await pairInternalTransfers(userId);

  // ── Fire automation triggers for genuinely-new arrivals ─────────
  // Runs AFTER pairInternalTransfers so is_transfer is fully settled
  // before rules see the row. Otherwise a fallback-paired transfer
  // would look like income to a rule that keys on isTransfer.
  //
  // For each row, we fire "transaction_arrived" unconditionally and
  // "income_landed" when amount > 0 (post-transfer-flag). Both use
  // the same context. Modified/re-synced rows are skipped — their
  // triggers ran on first landing.
  const ruleTargets = await pickTriggerTargets(userId, newPlaidIds, adoptedIds);
  for (const row of ruleTargets) {
    const context = {
      transaction: {
        id:           row.id,
        merchant:     row.merchant,
        category:     row.category,
        amount:       Number(row.amount),
        account_id:   row.account_id,
        account_type: row.account_type,
        pending:      !!row.pending,
        is_transfer:  !!row.is_transfer,
        date:         row.date,
      },
    };
    await runRulesForTrigger(userId, "transaction_arrived", context);
    if (Number(row.amount) > 0 && !row.is_transfer) {
      await runRulesForTrigger(userId, "income_landed", context);
    }
    // Bills auto-match: outgoing payments only, silent-fail so a
    // matcher error can't stall the sync loop.
    if (Number(row.amount) < 0 && !row.is_transfer) {
      try { await tryMatchTransactionToBill(userId, context.transaction); }
      catch { /* ignore */ }
    }
  }

  await query("UPDATE plaid_items SET sync_cursor = ?, last_sync_at = NOW() WHERE id = ?",
    [cursor, itemId]);
  return {
    added: added.length,
    modified: modified.length,
    removed: removed.length,
    pending: pendingAdded,
    posted: postedAdded,
    pairedTransfers: pairedCount,
    scheduledAdopted,
  };
}

/**
 * Look for a scheduled row that matches an incoming Plaid transaction and,
 * if found, promote it in place instead of inserting a new row.
 *
 * Rules:
 *   - same user + same account
 *   - is_scheduled = TRUE, plaid_transaction_id IS NULL
 *   - amount matches by sign AND within $5
 *   - date within ±3 days of the incoming date
 *   - closest date-delta wins; lowest id breaks ties
 *
 * Returns the adopted row's id on success, or null if no match.
 */
async function tryAdoptScheduled(
  userId, accountId, signedAmount, incomingDate,
  plaidTxnId, merchant, category, pending, isTransfer
) {
  const AMOUNT_EPS = 5;   // dollars
  const DAY_WINDOW = 3;   // days
  // Same-sign filter to keep a scheduled paycheck from adopting a bill.
  const signClause = signedAmount >= 0 ? "amount >= 0" : "amount < 0";
  const rows = await query(
    `SELECT id, date, amount FROM transactions
     WHERE user_id = ? AND account_id = ?
       AND is_scheduled = 1
       AND plaid_transaction_id IS NULL
       AND ${signClause}
       AND ABS(amount - ?) <= ?
       AND date BETWEEN DATE_SUB(?, INTERVAL ? DAY)
                    AND DATE_ADD(?, INTERVAL ? DAY)
     ORDER BY ABS(DATEDIFF(date, ?)) ASC, id ASC
     LIMIT 1`,
    [userId, accountId, signedAmount, AMOUNT_EPS,
     incomingDate, DAY_WINDOW, incomingDate, DAY_WINDOW, incomingDate]
  );
  const match = rows[0];
  if (!match) return null;

  // Adopt: keep the row's identity, stamp Plaid's data over it, flip the
  // scheduled flag off. plaid_transaction_id becomes the incoming id so
  // future syncs update this row in place via the ON DUPLICATE KEY path.
  await query(
    `UPDATE transactions SET
       plaid_transaction_id = ?,
       date = ?,
       merchant = ?,
       category = ?,
       amount = ?,
       pending = ?,
       is_transfer = GREATEST(is_transfer, ?),
       is_scheduled = 0
     WHERE id = ? AND user_id = ?`,
    [plaidTxnId, incomingDate, merchant, category,
     signedAmount, pending, isTransfer, match.id, userId]
  );
  return match.id;
}

/**
 * Load the full row snapshots for automation triggers. Rows are pulled
 * fresh from the DB after the pair-transfers pass has run, so is_transfer
 * reflects the FINAL post-pairing state. `newPlaidIds` are added rows
 * (matched by plaid_transaction_id); `adoptedIds` are already-existing
 * row ids that got promoted out of scheduled state this sync.
 */
async function pickTriggerTargets(userId, newPlaidIds, adoptedIds) {
  const targets = [];
  const cols = `t.id, t.merchant, t.category, t.amount, t.account_id,
                t.pending, t.is_transfer, t.date,
                a.type AS account_type`;
  if (newPlaidIds.size > 0) {
    const placeholders = [...newPlaidIds].map(() => "?").join(",");
    const rows = await query(
      `SELECT ${cols}
       FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ? AND t.plaid_transaction_id IN (${placeholders})`,
      [userId, ...newPlaidIds]
    );
    targets.push(...rows);
  }
  if (adoptedIds.size > 0) {
    const placeholders = [...adoptedIds].map(() => "?").join(",");
    const rows = await query(
      `SELECT ${cols}
       FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ? AND t.id IN (${placeholders})`,
      [userId, ...adoptedIds]
    );
    targets.push(...rows);
  }
  return targets;
}

/**
 * Match unpaired transactions across the user's own accounts and give each
 * matched pair a shared `transfer_group_id`. The row that already carries an
 * `is_transfer` flag (Plaid tagged one side) drags its partner in too.
 *
 * Pairing rule: same |amount| within $0.01, opposite signs, on TWO DIFFERENT
 * accounts owned by the same user, dated within ±3 days.
 *
 * Only runs on rows that don't already have a group_id, so re-runs are
 * cheap. If a row has multiple candidate partners we pick the closest by
 * (date-delta, then id) so a user with two identical amounts spread out
 * doesn't get the wrong pairing.
 */
export async function pairInternalTransfers(userId) {
  // Pool of every non-null-account row for this user that hasn't been
  // paired yet. We keep this in memory because the O(n^2) match is trivial
  // for a single user's unpaired set (bounded by pending sync volume),
  // and it keeps the SQL simple.
  const candidates = await query(
    `SELECT id, account_id, date, amount, is_transfer
     FROM transactions
     WHERE user_id = ?
       AND account_id IS NOT NULL
       AND transfer_group_id IS NULL
     ORDER BY date DESC, id DESC`,
    [userId]
  );
  if (candidates.length < 2) return 0;

  // Bucket by date so range queries stay O(n). Key = "YYYY-MM-DD".
  const byDate = new Map();
  for (const c of candidates) {
    const key = String(c.date).slice(0, 10);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(c);
  }

  const DAY_MS = 86400000;
  const WINDOW_DAYS = 3;
  const CENTS_EPS = 0.01;
  const used = new Set();
  let paired = 0;

  for (const outgoing of candidates) {
    if (used.has(outgoing.id)) continue;
    // Only iterate from the "out" side (amount < 0). This avoids matching
    // the same pair twice from opposite directions.
    if (Number(outgoing.amount) >= 0) continue;

    const target = -Number(outgoing.amount);
    const anchor = new Date(String(outgoing.date));
    let best = null;
    let bestDayDelta = Infinity;

    for (let d = -WINDOW_DAYS; d <= WINDOW_DAYS; d++) {
      const probe = new Date(anchor.getTime() + d * DAY_MS);
      const key = probe.toISOString().slice(0, 10);
      const bucket = byDate.get(key);
      if (!bucket) continue;
      for (const cand of bucket) {
        if (cand.id === outgoing.id) continue;
        if (used.has(cand.id)) continue;
        if (cand.account_id === outgoing.account_id) continue;
        if (Number(cand.amount) <= 0) continue;
        if (Math.abs(Number(cand.amount) - target) > CENTS_EPS) continue;
        const dayDelta = Math.abs(d);
        // Prefer closer-in-time; tie-break by lower id (deterministic).
        if (
          dayDelta < bestDayDelta
          || (dayDelta === bestDayDelta && (!best || cand.id < best.id))
        ) {
          best = cand;
          bestDayDelta = dayDelta;
        }
      }
    }

    if (!best) continue;
    // Only auto-pair when at least one side carries Plaid's TRANSFER hint.
    // Without a signal we'd risk false positives — two coincidentally
    // equal-and-opposite unrelated transactions.
    if (!outgoing.is_transfer && !best.is_transfer) continue;

    const groupId = crypto.randomUUID();
    await query(
      `UPDATE transactions
         SET transfer_group_id = ?, is_transfer = 1
       WHERE id IN (?, ?) AND user_id = ?`,
      [groupId, outgoing.id, best.id, userId]
    );
    used.add(outgoing.id);
    used.add(best.id);
    paired++;
  }
  return paired;
}

export async function syncHoldings(userId, itemId, accessToken) {
  const resp = await plaid.investmentsHoldingsGet({ access_token: accessToken });

  for (const s of resp.data.securities) {
    await query(
      `INSERT INTO securities (plaid_security_id, name, ticker_symbol, type, close_price, currency)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), close_price = VALUES(close_price),
                                ticker_symbol = VALUES(ticker_symbol)`,
      [s.security_id, s.name || "Unknown", s.ticker_symbol || null,
       s.type || null, s.close_price || null, s.iso_currency_code || "USD"]
    );
  }

  const accountMap = new Map(
    (await query(
      "SELECT id, plaid_account_id FROM accounts WHERE user_id = ? AND plaid_item_id = ?",
      [userId, itemId]
    )).map(a => [a.plaid_account_id, a.id])
  );
  const secMap = new Map(
    (await query("SELECT id, plaid_security_id FROM securities"))
      .map(s => [s.plaid_security_id, s.id])
  );

  const accIds = [...accountMap.values()];
  if (accIds.length) {
    await query(`DELETE FROM holdings WHERE account_id IN (${accIds.map(() => "?").join(",")})`, accIds);
  }
  for (const h of resp.data.holdings) {
    const accId = accountMap.get(h.account_id);
    const secId = secMap.get(h.security_id);
    if (!accId || !secId) continue;
    await query(
      `INSERT INTO holdings (user_id, account_id, security_id, quantity, cost_basis,
                              institution_value, institution_price)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, accId, secId, h.quantity, h.cost_basis || null,
       h.institution_value || 0, h.institution_price || 0]
    );
  }
  return { holdings: resp.data.holdings.length, securities: resp.data.securities.length };
}

export async function fullSyncItem(userId, itemId) {
  const item = await queryOne("SELECT * FROM plaid_items WHERE id = ? AND user_id = ?", [itemId, userId]);
  if (!item) throw new Error("Item not found");
  const token = decrypt(item.access_token_enc);
  await syncAccounts(userId, item.id, token, item.institution_name);
  const txn = await syncTransactions(userId, item.id, token);
  let inv = null;
  try { inv = await syncHoldings(userId, item.id, token); }
  catch (e) { /* item may not have investment products */ }
  // Fire the balance_changed automation trigger for this user. Empty
  // context — alert-type actions (notify_low_balance, notify_cc_utilization)
  // scan the accounts table themselves. Idempotent per-account dedup in
  // the actions prevents spam from repeated syncs that don't change the
  // situation.
  try { await runRulesForTrigger(userId, "balance_changed", {}); }
  catch { /* engine is silent-fail; belt-and-suspenders */ }
  return { transactions: txn, investments: inv };
}