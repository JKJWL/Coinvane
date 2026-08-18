// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Coinvane .cvn import — parses a Coinvane backup archive and restores
// every user-scoped row into the calling user's account, remapping FK
// ids as it goes.
//
// Refuses to run on a non-empty account. "Empty" means zero rows in
// every user_id-scoped data table (accounts, transactions, budgets,
// goals, notes, bills, loans, assets, reconciliations, holdings,
// holding_lots, lot_disposals, saved_views, saved_reports,
// split_templates, merchant_rules, automation_rules) — categories
// are exempt because new users have 13 seeded defaults and the
// importer merges imported categories into those by name.
//
// The destination user's settings row is PRESERVED — none of the
// source profile fields overwrite the caller's currency / timezone /
// notification thresholds / etc.
//
// Notes are re-encrypted with the destination server's ENCRYPTION_KEY
// on the way in (the export decrypted them with the source's key).
//
// Schema-drift resilience: instead of hardcoding INSERT column lists
// (which is how the accounts.currency and loans.rate bugs crept in),
// we introspect each target table's real column set once at import
// time and drop any exported key the destination doesn't recognise.
// Extra columns in older / newer .cvn files just get skipped —
// missing columns get whatever DEFAULT the schema declares.
import cryptoNode from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import yauzl from "yauzl";
import { query, queryOne } from "./db.js";
import { encrypt } from "./crypto.js";

const CVN_FORMAT = "coinvane-export";
const SUPPORTED_VERSIONS = new Set([1]);
const KDF_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const ATTACHMENTS_ROOT = process.env.ATTACHMENTS_ROOT || "/data/attachments";

const openZip = promisify(yauzl.fromBuffer);

// ── ZIP reader ─────────────────────────────────────────────────────
async function readAllEntries(zipBuffer) {
  const zip = await openZip(zipBuffer, { lazyEntries: true });
  const entries = new Map();
  return new Promise((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", () => resolve(entries));
    zip.on("entry", (entry) => {
      if (/\/$/.test(entry.fileName)) { zip.readEntry(); return; }
      // Zip-slip protection.
      if (entry.fileName.includes("..") || entry.fileName.startsWith("/")) {
        return reject(new Error(`Suspicious entry name in archive: ${entry.fileName}`));
      }
      zip.openReadStream(entry, (err, stream) => {
        if (err) return reject(err);
        const chunks = [];
        stream.on("data", (c) => chunks.push(c));
        stream.on("end", () => {
          entries.set(entry.fileName, Buffer.concat(chunks));
          zip.readEntry();
        });
        stream.on("error", reject);
      });
    });
    zip.readEntry();
  });
}

function deriveKey(passphrase, salt) {
  return cryptoNode.pbkdf2Sync(passphrase, salt, 200_000, KDF_KEY_BYTES, "sha256");
}

function decryptBlob(blob, key) {
  if (blob.length < GCM_IV_BYTES + GCM_TAG_BYTES) {
    throw new Error("Encrypted blob is truncated");
  }
  const iv = blob.subarray(0, GCM_IV_BYTES);
  const tag = blob.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const ct = blob.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  const dec = cryptoNode.createDecipheriv("aes-256-gcm", key, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]);
}

// ── Header parse ────────────────────────────────────────────────────
export async function parseCvn(zipBuffer, passphrase) {
  let entries;
  try { entries = await readAllEntries(zipBuffer); }
  catch (e) { throw new Error("Not a valid .cvn file — could not read archive."); }
  const manifestBuf = entries.get("manifest.json");
  if (!manifestBuf) throw new Error("Not a valid .cvn file — manifest.json missing.");
  let manifest;
  try { manifest = JSON.parse(manifestBuf.toString("utf-8")); }
  catch { throw new Error("Not a valid .cvn file — manifest.json is corrupt."); }
  if (manifest.format !== CVN_FORMAT) {
    throw new Error(`Not a Coinvane backup (format="${manifest.format}").`);
  }
  if (!SUPPORTED_VERSIONS.has(manifest.version)) {
    throw new Error(`Unsupported .cvn version ${manifest.version}. This server supports: ${[...SUPPORTED_VERSIONS].join(", ")}`);
  }

  let dataJsonBuf, extMap = null;
  if (manifest.encrypted) {
    if (!passphrase || String(passphrase).length === 0) {
      throw new Error("This backup is encrypted — passphrase required.");
    }
    const enc = manifest.encryption || {};
    if (enc.alg !== "AES-256-GCM" || enc.kdf !== "PBKDF2-SHA256") {
      throw new Error("Unsupported encryption algorithm in backup.");
    }
    const salt = Buffer.from(enc.salt, "base64");
    const key = deriveKey(String(passphrase), salt);
    const dataEnc = entries.get("data.enc");
    if (!dataEnc) throw new Error("Encrypted backup missing data.enc payload.");
    try { dataJsonBuf = decryptBlob(dataEnc, key); }
    catch { throw new Error("Wrong passphrase, or the file is corrupt."); }
    const extEnc = entries.get("attachments/_ext-map.enc");
    if (extEnc) {
      try { extMap = JSON.parse(decryptBlob(extEnc, key).toString("utf-8")); }
      catch { extMap = {}; }
    }
    manifest._runtime = { key, encrypted: true };
  } else {
    dataJsonBuf = entries.get("data.json");
    if (!dataJsonBuf) throw new Error("Backup missing data.json payload.");
    manifest._runtime = { encrypted: false };
  }

  if (manifest.dataChecksum) {
    const actual = cryptoNode.createHash("sha256").update(dataJsonBuf).digest("hex");
    if (actual !== manifest.dataChecksum) {
      throw new Error("Backup integrity check failed — file may be corrupt or tampered with.");
    }
  }

  let data;
  try { data = JSON.parse(dataJsonBuf.toString("utf-8")); }
  catch { throw new Error("Backup data payload is corrupt (not valid JSON)."); }

  const attachments = new Map();
  for (const [name, buf] of entries.entries()) {
    if (!name.startsWith("attachments/")) continue;
    if (name === "attachments/_ext-map.enc") continue;
    const base = name.substring("attachments/".length);
    if (manifest._runtime.encrypted) {
      const m = /^(\d+)\.enc$/.exec(base);
      if (!m) continue;
      const txnId = Number(m[1]);
      let plain;
      try { plain = decryptBlob(buf, manifest._runtime.key); }
      catch { continue; }
      const ext = (extMap && extMap[txnId]) || "bin";
      attachments.set(txnId, { ext, buf: plain });
    } else {
      const m = /^(\d+)\.([a-zA-Z0-9]+)$/.exec(base);
      if (!m) continue;
      attachments.set(Number(m[1]), { ext: m[2], buf });
    }
  }

  return { manifest, data, attachments };
}

// ── Empty-account guard ────────────────────────────────────────────
const EMPTY_CHECK_TABLES = [
  "accounts", "transactions", "budgets", "goals", "notes",
  "bills", "loans", "assets", "reconciliations",
  "holdings", "holding_lots", "lot_disposals",
  "saved_views", "saved_reports", "split_templates",
  "merchant_rules", "automation_rules",
];

export async function targetAccountIsEmpty(userId) {
  for (const t of EMPTY_CHECK_TABLES) {
    const r = await queryOne(`SELECT COUNT(*) AS c FROM ${t} WHERE user_id = ?`, [userId]);
    if (Number(r?.c || 0) > 0) return { empty: false, table: t, count: Number(r.c) };
  }
  return { empty: true };
}

export function previewStats(data) {
  const s = {};
  for (const k of Object.keys(data)) {
    if (Array.isArray(data[k])) s[k] = data[k].length;
  }
  if (data.transactions?.length) {
    const dates = data.transactions.map(t => t.date).filter(Boolean).sort();
    s.transactionsDateRange = { from: dates[0], to: dates[dates.length - 1] };
  }
  return s;
}

// ── Schema-drift-proof insert helpers ───────────────────────────────
// Introspects each target table's real column set once (per import
// run) and only writes keys that exist. Fixes the whole class of
// bugs where the export or the hardcoded INSERT knows a column that
// the destination schema doesn't have (or vice versa).
const columnCache = new Map();
async function getColumns(table) {
  if (columnCache.has(table)) return columnCache.get(table);
  const rows = await query(`SHOW COLUMNS FROM ${table}`);
  const cols = new Set(rows.map(r => r.Field));
  columnCache.set(table, cols);
  return cols;
}

// safeInsert(table, row) — inserts only the row keys that match real
// columns. Returns the new insertId, or null if nothing to write.
async function safeInsert(table, row) {
  const cols = await getColumns(table);
  const entries = Object.entries(row).filter(([k, v]) =>
    cols.has(k) && v !== undefined
  );
  if (entries.length === 0) return null;
  const keys = entries.map(e => e[0]);
  const vals = entries.map(e => e[1]);
  const r = await query(
    `INSERT INTO ${table} (${keys.map(k => "`" + k + "`").join(", ")})
     VALUES (${keys.map(() => "?").join(", ")})`,
    vals
  );
  return r.insertId;
}

// safeInsertIgnore — same but with INSERT IGNORE (for tables with
// unique constraints we don't want to fail on, like merchant_rules).
async function safeInsertIgnore(table, row) {
  const cols = await getColumns(table);
  const entries = Object.entries(row).filter(([k, v]) =>
    cols.has(k) && v !== undefined
  );
  if (entries.length === 0) return null;
  const keys = entries.map(e => e[0]);
  const vals = entries.map(e => e[1]);
  const r = await query(
    `INSERT IGNORE INTO ${table} (${keys.map(k => "`" + k + "`").join(", ")})
     VALUES (${keys.map(() => "?").join(", ")})`,
    vals
  );
  return r.insertId || null;
}

// FK remap helper — nullable, tolerates missing mappings.
const rm = (map, id) => (id == null ? null : (map.get(id) ?? null));

// Strip fields that never travel: source's own id (destination
// assigns fresh), and any of the client-scoped identifiers we always
// want to blank out for a given table.
function stripped(src, extra = {}) {
  const out = { ...src, ...extra };
  delete out.id;
  return out;
}

// ── The import itself ──────────────────────────────────────────────
export async function performImport(userId, data, attachments) {
  const stats = {};

  // ─── Categories: merge by name into existing (seeded + custom) ───
  const existingCats = await query(
    `SELECT id, name FROM categories WHERE user_id = ?`, [userId]
  );
  const catByName = new Map(existingCats.map(c => [c.name, c.id]));
  const catIdMap = new Map();
  for (const c of data.categories || []) {
    if (catByName.has(c.name)) {
      catIdMap.set(c.id, catByName.get(c.name));
      continue;
    }
    const newId = await safeInsert("categories", stripped(c, {
      user_id: userId,
      parent_id: null, // set in second pass
    }));
    if (newId) {
      catIdMap.set(c.id, newId);
      catByName.set(c.name, newId);
    }
  }
  for (const c of data.categories || []) {
    if (c.parent_id == null) continue;
    const newId = catIdMap.get(c.id);
    const newParent = catIdMap.get(c.parent_id);
    if (newId && newParent) {
      await query(
        `UPDATE categories SET parent_id = ? WHERE id = ? AND user_id = ?`,
        [newParent, newId, userId]
      );
    }
  }
  stats.categories = catIdMap.size;

  // ─── Accounts ────────────────────────────────────────────────────
  const acctIdMap = new Map();
  for (const a of data.accounts || []) {
    const newId = await safeInsert("accounts", stripped(a, {
      user_id: userId,
      // Imported accounts become manual — Plaid identifiers cannot
      // travel between servers.
      plaid_item_id: null,
      plaid_account_id: null,
      // Preserve the source's identity for Stage 3 auto-merge on
      // future Plaid re-link.
      imported_original_name: a.name,
      imported_original_institution: a.institution || null,
      last_sync_at: null,
    }));
    if (newId) acctIdMap.set(a.id, newId);
  }
  stats.accounts = acctIdMap.size;

  // ─── Budgets ─────────────────────────────────────────────────────
  const budgetIdMap = new Map();
  for (const b of data.budgets || []) {
    const newId = await safeInsert("budgets", stripped(b, {
      user_id: userId,
      account_id: rm(acctIdMap, b.account_id),
    }));
    if (newId) budgetIdMap.set(b.id, newId);
  }
  stats.budgets = budgetIdMap.size;

  // ─── Goals ───────────────────────────────────────────────────────
  const goalIdMap = new Map();
  for (const g of data.goals || []) {
    const newId = await safeInsert("goals", stripped(g, {
      user_id: userId,
      account_id: rm(acctIdMap, g.account_id),
    }));
    if (newId) goalIdMap.set(g.id, newId);
  }
  stats.goals = goalIdMap.size;

  // ─── Loans ───────────────────────────────────────────────────────
  const loanIdMap = new Map();
  for (const l of data.loans || []) {
    const newId = await safeInsert("loans", stripped(l, {
      user_id: userId,
      linked_account_id: rm(acctIdMap, l.linked_account_id),
      account_id: rm(acctIdMap, l.account_id),
    }));
    if (newId) loanIdMap.set(l.id, newId);
  }
  stats.loans = loanIdMap.size;

  // ─── Assets + damage events ──────────────────────────────────────
  const assetIdMap = new Map();
  for (const a of data.assets || []) {
    const newId = await safeInsert("assets", stripped(a, {
      user_id: userId,
      loan_account_id: rm(acctIdMap, a.loan_account_id),
    }));
    if (newId) assetIdMap.set(a.id, newId);
  }
  stats.assets = assetIdMap.size;
  for (const e of data.assetDamageEvents || []) {
    const newAssetId = rm(assetIdMap, e.asset_id);
    if (!newAssetId) continue;
    await safeInsert("asset_damage_events", stripped(e, {
      user_id: userId,
      asset_id: newAssetId,
    }));
  }

  // ─── Bills + cycles ──────────────────────────────────────────────
  const billIdMap = new Map();
  for (const b of data.bills || []) {
    const newId = await safeInsert("bills", stripped(b, {
      user_id: userId,
      account_id: rm(acctIdMap, b.account_id),
    }));
    if (newId) billIdMap.set(b.id, newId);
  }
  stats.bills = billIdMap.size;
  for (const c of data.billCycles || []) {
    const newBillId = rm(billIdMap, c.bill_id);
    if (!newBillId) continue;
    await safeInsert("bill_cycles", stripped(c, {
      user_id: userId,
      bill_id: newBillId,
      // Transactions haven't been inserted yet, so we can't remap
      // matched_txn_id — null it. The bill auto-match sweep will
      // rebuild the link on the next Plaid sync if the txn returns.
      matched_txn_id: null,
    }));
  }

  // ─── Reconciliations ─────────────────────────────────────────────
  const reconIdMap = new Map();
  for (const r of data.reconciliations || []) {
    const newAcctId = rm(acctIdMap, r.account_id);
    if (!newAcctId) continue;
    const newId = await safeInsert("reconciliations", stripped(r, {
      user_id: userId,
      account_id: newAcctId,
    }));
    if (newId) reconIdMap.set(r.id, newId);
  }
  stats.reconciliations = reconIdMap.size;

  // ─── Securities (INSERT IGNORE keyed by plaid_security_id) ───────
  const secIdMap = new Map();
  for (const s of data.securities || []) {
    let existing = await queryOne(
      `SELECT id FROM securities WHERE plaid_security_id = ?`,
      [s.plaid_security_id]
    );
    if (!existing) {
      const newId = await safeInsertIgnore("securities", stripped(s));
      if (newId) secIdMap.set(s.id, newId);
      else {
        // A concurrent import may have inserted it — re-read.
        existing = await queryOne(
          `SELECT id FROM securities WHERE plaid_security_id = ?`,
          [s.plaid_security_id]
        );
        if (existing) secIdMap.set(s.id, existing.id);
      }
    } else {
      secIdMap.set(s.id, existing.id);
    }
  }

  // ─── Holdings + lots + disposals ─────────────────────────────────
  for (const h of data.holdings || []) {
    const newAcctId = rm(acctIdMap, h.account_id);
    const newSecId = rm(secIdMap, h.security_id);
    if (!newAcctId || !newSecId) continue;
    await safeInsert("holdings", stripped(h, {
      user_id: userId,
      account_id: newAcctId,
      security_id: newSecId,
    }));
  }
  const lotIdMap = new Map();
  for (const l of data.holdingLots || []) {
    const newSecId = rm(secIdMap, l.security_id);
    if (!newSecId) continue;
    const newId = await safeInsert("holding_lots", stripped(l, {
      user_id: userId,
      security_id: newSecId,
      account_id: rm(acctIdMap, l.account_id),
    }));
    if (newId) lotIdMap.set(l.id, newId);
  }
  for (const d of data.lotDisposals || []) {
    const newLotId = rm(lotIdMap, d.lot_id);
    const newSecId = rm(secIdMap, d.security_id);
    if (!newLotId || !newSecId) continue;
    await safeInsert("lot_disposals", stripped(d, {
      user_id: userId,
      lot_id: newLotId,
      security_id: newSecId,
    }));
  }

  // ─── Split templates + lines ─────────────────────────────────────
  const splitTplIdMap = new Map();
  for (const t of data.splitTemplates || []) {
    const newId = await safeInsert("split_templates", stripped(t, {
      user_id: userId,
    }));
    if (newId) splitTplIdMap.set(t.id, newId);
  }
  stats.splitTemplates = splitTplIdMap.size;
  for (const l of data.splitTemplateLines || []) {
    const newTplId = rm(splitTplIdMap, l.template_id);
    if (!newTplId) continue;
    await safeInsert("split_template_lines", stripped(l, {
      template_id: newTplId,
    }));
  }

  // ─── Transactions (two-pass for self-refs) ───────────────────────
  const txnIdMap = new Map();
  for (const t of data.transactions || []) {
    const newId = await safeInsert("transactions", stripped(t, {
      user_id: userId,
      account_id: rm(acctIdMap, t.account_id),
      reconciliation_id: rm(reconIdMap, t.reconciliation_id),
      // Plaid ids from the source may clash with destination's own
      // Plaid data. Import as manual — future Plaid syncs adopt via
      // tryAdoptManual in sync.js if the same swipe reappears.
      plaid_transaction_id: null,
      // Self-refs set in second pass:
      split_parent_id: null,
      recurring_parent_id: null,
      // Attachment file gets written after this loop; the metadata
      // is preserved but the path is remapped later.
      attachment_path: null,
    }));
    if (newId) txnIdMap.set(t.id, newId);
  }
  for (const t of data.transactions || []) {
    const newId = txnIdMap.get(t.id);
    if (!newId) continue;
    const updates = [];
    const params = [];
    if (t.split_parent_id != null) {
      const p = txnIdMap.get(t.split_parent_id);
      if (p) { updates.push("split_parent_id = ?"); params.push(p); }
    }
    if (t.recurring_parent_id != null) {
      const p = txnIdMap.get(t.recurring_parent_id);
      if (p) { updates.push("recurring_parent_id = ?"); params.push(p); }
    }
    if (updates.length) {
      params.push(newId, userId);
      await query(
        `UPDATE transactions SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`,
        params
      );
    }
  }
  stats.transactions = txnIdMap.size;

  // ─── Budget audit ────────────────────────────────────────────────
  // budget_audit.budget_id is NOT NULL — snapshots that referenced
  // source-side budgets which no longer exist on export (deletes)
  // can't be remapped and would fail the NOT NULL constraint. Skip
  // those; the orphaned audit trail wouldn't be readable on the new
  // side anyway since there's no parent budget to display it under.
  for (const a of data.budgetAudit || []) {
    const newBudgetId = rm(budgetIdMap, a.budget_id);
    if (!newBudgetId) continue;
    await safeInsert("budget_audit", stripped(a, {
      user_id: userId,
      budget_id: newBudgetId,
      account_id: rm(acctIdMap, a.account_id),
    }));
  }

  // ─── Merchant rules (unique per (user_id, merchant) — INSERT IGNORE) ─
  for (const m of data.merchantRules || []) {
    await safeInsertIgnore("merchant_rules", stripped(m, {
      user_id: userId,
    }));
  }

  // ─── Saved views + reports ───────────────────────────────────────
  for (const v of data.savedViews || []) {
    await safeInsert("saved_views", stripped(v, {
      user_id: userId,
      config: typeof v.config === "string" ? v.config : JSON.stringify(v.config || {}),
    }));
  }
  for (const r of data.savedReports || []) {
    await safeInsert("saved_reports", stripped(r, {
      user_id: userId,
      config: typeof r.config === "string" ? r.config : JSON.stringify(r.config || {}),
    }));
  }

  // ─── Automation rules ────────────────────────────────────────────
  // Schema columns are `conditions` + `actions` (LONGTEXT). mysql2
  // returns LONGTEXT as strings, so the source values pass through
  // the spread as-is and land back as strings — no JSON re-round-
  // tripping needed.
  for (const r of data.automationRules || []) {
    await safeInsert("automation_rules", stripped(r, {
      user_id: userId,
    }));
  }

  // ─── Notifications (historical alert log) ────────────────────────
  for (const n of data.notifications || []) {
    await safeInsert("notifications", stripped(n, {
      user_id: userId,
    }));
  }
  stats.notifications = (data.notifications || []).length;

  // ─── Notes (re-encrypt with destination server key) ──────────────
  for (const n of data.notes || []) {
    let content = n.content || "";
    try {
      const enc = encrypt(content);
      content = "enc:v1:" + enc;
    } catch { /* fall through — store plaintext if key missing */ }
    await safeInsert("notes", stripped(n, {
      user_id: userId,
      content,
    }));
  }
  stats.notes = (data.notes || []).length;

  // ─── Attachments — copy from ZIP to disk under user's folder ─────
  const userDir = path.join(ATTACHMENTS_ROOT, String(userId));
  await fs.promises.mkdir(userDir, { recursive: true });
  let attachmentsRestored = 0;
  for (const [oldTxnId, att] of attachments.entries()) {
    const newTxnId = txnIdMap.get(oldTxnId);
    if (!newTxnId) continue;
    const ext = att.ext || "bin";
    const relPath = path.join(String(userId), `${newTxnId}.${ext}`).replace(/\\/g, "/");
    const absPath = path.join(ATTACHMENTS_ROOT, relPath);
    await fs.promises.writeFile(absPath, att.buf);
    const mime = ext === "png" ? "image/png"
              : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
              : "application/octet-stream";
    await query(
      `UPDATE transactions SET has_attachment = 1, attachment_path = ?,
         attachment_mimetype = COALESCE(attachment_mimetype, ?),
         attachment_size = ?, attachment_uploaded_at = COALESCE(attachment_uploaded_at, NOW())
       WHERE id = ? AND user_id = ?`,
      [relPath, mime, att.buf.length, newTxnId, userId]
    );
    attachmentsRestored++;
  }
  stats.attachments = attachmentsRestored;

  return { imported: stats };
}
