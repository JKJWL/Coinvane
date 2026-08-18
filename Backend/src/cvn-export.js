// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Coinvane .cvn export builder — a portable, user-owned backup of
// EVERYTHING except account identity (email, google_id, role, etc.)
// and per-server / per-device state (Plaid tokens, push subscriptions,
// webauthn credentials, session tokens).
//
// The .cvn file is a ZIP with:
//   manifest.json  — format/version + checksum + encryption params
//   data.json  OR  data.enc  — every user-scoped table serialized
//   attachments/{txnId}.{ext}  OR  attachments/{txnId}.enc
//
// Encryption (optional): AES-256-GCM. Key derived from a user-chosen
// passphrase via PBKDF2-SHA256 (200 000 iterations) + 16-byte salt
// stored in the manifest. Same key encrypts data.json AND every
// attachment (each with its own IV + tag).
//
// Notes are decrypted from the source server's ENCRYPTION_KEY before
// packing so the file is portable to a different Coinvane instance
// with a different key. On import the destination server re-encrypts
// with its own key.
import archiver from "archiver";
import cryptoNode from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { query, queryOne } from "./db.js";
import { decrypt } from "./crypto.js";

const CVN_FORMAT = "coinvane-export";
const CVN_VERSION = 1;
const KDF_ITERATIONS = 200_000;
const KDF_KEY_BYTES = 32;   // AES-256
const KDF_SALT_BYTES = 16;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const ATTACHMENTS_ROOT = process.env.ATTACHMENTS_ROOT || "/data/attachments";

// PBKDF2-SHA256 to derive a 32-byte AES key. Sync flavor because
// we only call it once per export request; the 200k-iteration cost
// (~200ms) matters less than call-site simplicity.
function deriveKey(passphrase, salt) {
  return cryptoNode.pbkdf2Sync(passphrase, salt, KDF_ITERATIONS, KDF_KEY_BYTES, "sha256");
}

// AES-256-GCM. Returns Buffer with layout [iv(12) | tag(16) | ciphertext].
// Salt is NOT prepended per-blob because we store it once in the manifest
// (all blobs share the derived key; each gets its own IV).
function encryptBlob(plaintext, key) {
  const iv = cryptoNode.randomBytes(GCM_IV_BYTES);
  const cipher = cryptoNode.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

// ── User data gatherer ─────────────────────────────────────────────
// Pulls every user-scoped table into a single serializable object.
// Notes get their content decrypted here so the file is portable.
async function gatherUserData(userId) {
  // Profile — sanitized. Identity fields (email, google_id, role,
  // picture, biometric_lock_enabled) are DELIBERATELY omitted.
  const u = await queryOne(
    `SELECT id, name, currency, timezone, dark_mode, week_start,
            notification_email, notification_push,
            notify_large_txn, large_txn_threshold,
            notify_income, income_threshold,
            notify_budget_warning, budget_warning_pct,
            notify_budget_exceeded, notify_goal_milestone,
            notify_bill_reminders, notify_bill_days_before,
            notify_cashflow_enabled, notify_cashflow_min,
            notify_budget_usage_enabled, notify_budget_usage_pct,
            income_period, income_period_start, income_period_days,
            privacy_mode, email_frequency, email_weekday,
            show_cashflow_forecast, last_budget_period_processed
     FROM users WHERE id = ?`, [userId]
  );
  if (!u) throw new Error("user not found");
  const profile = { ...u };
  delete profile.id;

  // Every user-scoped table, in one query each. Order doesn't matter
  // for export (all rows carry user_id); import will insert in FK order.
  //
  // Plaid-linked accounts are exported as regular account rows with
  // the plaid_item_id set to NULL — the token itself is a per-server
  // secret and cannot travel between Coinvane installs.
  const accounts = await query(
    `SELECT id, name, type, subtype, balance, limit_amount, institution,
            is_business, created_at
     FROM accounts WHERE user_id = ?`, [userId]
  );

  // Everything below uses SELECT * — safer against schema drift than
  // an explicit column list (which is how the "currency" bug slipped
  // through). Import already ignores unknown columns because it uses
  // an explicit INSERT column list per table, so any extra fields in
  // the JSON are dropped on the way back in.
  const categories  = await query(`SELECT * FROM categories  WHERE user_id = ?`, [userId]);
  const budgets     = await query(`SELECT * FROM budgets     WHERE user_id = ?`, [userId]);
  const budgetAudit = await query(`SELECT * FROM budget_audit WHERE user_id = ?`, [userId]);
  const goals       = await query(`SELECT * FROM goals       WHERE user_id = ?`, [userId]);

  // Notes: decrypt content from server key BEFORE serializing so the
  // export is portable. Plaintext-legacy rows (no "enc:v1:" prefix)
  // pass through unchanged.
  const notesRaw = await query(`SELECT * FROM notes WHERE user_id = ?`, [userId]);
  const notes = notesRaw.map(n => {
    let content = n.content || "";
    if (typeof content === "string" && content.startsWith("enc:v1:")) {
      try { content = decrypt(content); } catch { /* corrupt row — pass through */ }
    }
    return { ...n, content };
  });

  const bills = await query(`SELECT * FROM bills WHERE user_id = ?`, [userId]);
  const billCycles = await query(`SELECT * FROM bill_cycles WHERE user_id = ?`, [userId]);

  const loans = await query(`SELECT * FROM loans WHERE user_id = ?`, [userId]);

  const assets = await query(`SELECT * FROM assets WHERE user_id = ?`, [userId]);
  const assetDamageEvents = await query(`SELECT * FROM asset_damage_events WHERE user_id = ?`, [userId]);

  const merchantRules = await query(`SELECT * FROM merchant_rules WHERE user_id = ?`, [userId]);
  const savedViews = await query(`SELECT * FROM saved_views WHERE user_id = ?`, [userId]);
  const savedReports = await query(`SELECT * FROM saved_reports WHERE user_id = ?`, [userId]);

  const splitTemplates = await query(`SELECT * FROM split_templates WHERE user_id = ?`, [userId]);
  const splitTemplateLines = await query(
    `SELECT stl.* FROM split_template_lines stl
     JOIN split_templates st ON st.id = stl.template_id
     WHERE st.user_id = ?`, [userId]
  );

  const reconciliations = await query(`SELECT * FROM reconciliations WHERE user_id = ?`, [userId]);

  const holdings = await query(`SELECT * FROM holdings WHERE user_id = ?`, [userId]);
  const holdingLots = await query(`SELECT * FROM holding_lots WHERE user_id = ?`, [userId]);
  const lotDisposals = await query(`SELECT * FROM lot_disposals WHERE user_id = ?`, [userId]);

  // Referenced securities. `securities` is a global lookup table
  // (keyed by plaid_security_id) that isn't user-scoped, but we
  // export the subset our holdings/lots point at so the destination
  // server can INSERT IGNORE them on import when the plaid_security_id
  // isn't already known there. Without this, imported holdings would
  // reference nonexistent security rows.
  const securityIds = new Set();
  for (const h of holdings) securityIds.add(h.security_id);
  for (const l of holdingLots) securityIds.add(l.security_id);
  for (const d of lotDisposals) securityIds.add(d.security_id);
  const securities = securityIds.size > 0
    ? await query(
        `SELECT id, plaid_security_id, name, ticker_symbol, type,
                close_price, currency
         FROM securities WHERE id IN (${[...securityIds].map(() => "?").join(",")})`,
        [...securityIds]
      )
    : [];

  const automationRules = await query(`SELECT * FROM automation_rules WHERE user_id = ?`, [userId]);

  const notifications = await query(`SELECT * FROM notifications WHERE user_id = ?`, [userId]);
  const transactions  = await query(`SELECT * FROM transactions  WHERE user_id = ?`, [userId]);

  return {
    profile,
    accounts, categories, budgets, budgetAudit,
    goals, notes,
    bills, billCycles, loans,
    assets, assetDamageEvents,
    merchantRules, savedViews, savedReports,
    splitTemplates, splitTemplateLines,
    reconciliations,
    holdings, holdingLots, lotDisposals, securities,
    automationRules,
    notifications,
    transactions,
  };
}

// Walk transactions.attachment_path values and resolve to on-disk paths
// under ATTACHMENTS_ROOT. Returns [{ txnId, ext, absPath }].
async function listAttachments(userId, transactions) {
  const out = [];
  for (const t of transactions) {
    if (!t.has_attachment || !t.attachment_path) continue;
    const abs = path.join(ATTACHMENTS_ROOT, t.attachment_path);
    try {
      await fs.promises.access(abs, fs.constants.R_OK);
      const ext = path.extname(t.attachment_path).replace(/^\./, "") || "bin";
      out.push({ txnId: t.id, ext, absPath: abs });
    } catch { /* file missing — skip silently */ }
  }
  return out;
}

/**
 * Build a .cvn export and pipe it to outStream.
 * @param {number} userId
 * @param {string|null} passphrase — falsy = unencrypted plaintext export
 * @param {stream.Writable} outStream — where the ZIP bytes go (usually reply.raw)
 * @returns {Promise<{bytes:number}>} resolved after archive is finalized
 */
export async function buildCvn({ userId, passphrase, outStream }) {
  const data = await gatherUserData(userId);
  const attachments = await listAttachments(userId, data.transactions);

  const dataJson = Buffer.from(JSON.stringify(data), "utf-8");
  const dataChecksum = cryptoNode.createHash("sha256").update(dataJson).digest("hex");

  const encrypted = !!(passphrase && String(passphrase).length > 0);
  let salt = null;
  let key = null;
  if (encrypted) {
    salt = cryptoNode.randomBytes(KDF_SALT_BYTES);
    key = deriveKey(String(passphrase), salt);
  }

  const manifest = {
    format: CVN_FORMAT,
    version: CVN_VERSION,
    createdAt: new Date().toISOString(),
    encrypted,
    dataChecksum,
    attachmentCount: attachments.length,
    ...(encrypted && {
      encryption: {
        alg: "AES-256-GCM",
        kdf: "PBKDF2-SHA256",
        kdfIterations: KDF_ITERATIONS,
        salt: salt.toString("base64"),
        ivBytes: GCM_IV_BYTES,
        tagBytes: GCM_TAG_BYTES,
      },
    }),
  };

  const archive = archiver("zip", { zlib: { level: 6 } });
  const donePromise = new Promise((resolve, reject) => {
    let bytes = 0;
    outStream.on("finish", () => resolve({ bytes }));
    outStream.on("error", reject);
    archive.on("error", reject);
    archive.on("data", chunk => { bytes += chunk.length; });
  });
  archive.pipe(outStream);

  // Manifest is ALWAYS plaintext so an import can read version + salt
  // without needing the passphrase up front.
  archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });

  if (encrypted) {
    archive.append(encryptBlob(dataJson, key), { name: "data.enc" });
    for (const a of attachments) {
      const buf = await fs.promises.readFile(a.absPath);
      archive.append(encryptBlob(buf, key), { name: `attachments/${a.txnId}.enc` });
    }
    // Ext-map so import can restore the correct file extension even
    // though every attachment file inside the ZIP is `.enc`.
    const extMap = Object.fromEntries(attachments.map(a => [a.txnId, a.ext]));
    archive.append(
      encryptBlob(Buffer.from(JSON.stringify(extMap), "utf-8"), key),
      { name: "attachments/_ext-map.enc" }
    );
  } else {
    archive.append(dataJson, { name: "data.json" });
    for (const a of attachments) {
      archive.file(a.absPath, { name: `attachments/${a.txnId}.${a.ext}` });
    }
  }

  await archive.finalize();
  return donePromise;
}
