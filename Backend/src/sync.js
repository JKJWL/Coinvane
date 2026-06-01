// SPDX-License-Identifier: AGPL-3.0-or-later
import { plaid } from "./plaid-client.js";
import { query, queryOne } from "./db.js";
import { decrypt } from "./crypto.js";

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

  for (const t of [...added, ...modified]) {
    const accId = accountMap.get(t.account_id) || null;
    const merchant = t.merchant_name || t.name || "Unknown";
    const plaidCat = t.personal_finance_category?.primary || (t.category?.[0]) || "Other";
    // User-defined rule takes precedence over Plaid's category
    const finalCat = ruleMap.get(merchant.toLowerCase()) || normalizeCategory(plaidCat);
    if (t.pending) pendingAdded++; else postedAdded++;
    await query(
      `INSERT INTO transactions (user_id, account_id, plaid_transaction_id, date, merchant,
                                  category, amount, pending)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE date = VALUES(date), merchant = VALUES(merchant),
                                category = VALUES(category), amount = VALUES(amount),
                                pending = VALUES(pending)`,
      [userId, accId, t.transaction_id, t.date,
       merchant, finalCat, -t.amount, t.pending ? 1 : 0]
    );
  }

  for (const r of removed) {
    await query("DELETE FROM transactions WHERE plaid_transaction_id = ? AND user_id = ?",
      [r.transaction_id, userId]);
  }

  await query("UPDATE plaid_items SET sync_cursor = ?, last_sync_at = NOW() WHERE id = ?",
    [cursor, itemId]);
  return {
    added: added.length,
    modified: modified.length,
    removed: removed.length,
    pending: pendingAdded,
    posted: postedAdded,
  };
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
  return { transactions: txn, investments: inv };
}