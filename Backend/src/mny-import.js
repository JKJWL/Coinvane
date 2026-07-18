// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Microsoft Money (.mny) importer.
 *
 * The .mny format is a Jet-4 Access database with a proprietary bit of
 * encryption layered on top. Pipeline:
 *
 *   1. If the file is unencrypted (an old export or one already
 *      unlocked by the user), mdb-tables succeeds directly and we skip
 *      straight to extraction.
 *   2. If mdb-tables reports the file is encrypted, we shell out to
 *      sunriise (bundled at /opt/sunriise.jar — see Dockerfile stage
 *      1), which strips the password protection and writes a plain
 *      .mdb file that mdbtools can read.
 *   3. From that point on, extraction is the same regardless of source.
 *
 * The caller can pass an explicit password. sunriise doesn't strictly
 * need it (its trick relies on a Money Sunset-era backdoor), but some
 * unusual files respond better when the password is provided.
 *
 * Money's transaction tables have varied across versions:
 *   TRN, TRN_SPLIT   (Money 99 / 2000 / 2001)
 *   TRN, TRN_SPLIT, CAT, PAY  (Money 2002+ / 2004 / 2005 / Sunset)
 * We probe for the table names on the fly instead of hard-coding.
 */
const SUNRIISE_JAR = process.env.SUNRIISE_JAR || "/opt/sunriise.jar";
const SUNRIISE_TIMEOUT_MS = 60_000;

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const MNY_MAGIC = "Standard Jet DB";
const MDB_EXPORT_TIMEOUT_MS = 30_000;
const MAX_ROWS = 20_000;

/** True if the buffer's Jet header matches the .mny/.mdb signature. */
export function isMnyBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 32) return false;
  // Jet 4 files carry "Standard Jet DB" at offset 4. Money 2000+ writes
  // the same header, sometimes with a slight variation ("Standard ACE DB"
  // for later Access — Money never got that far, but check both).
  const header = buf.slice(4, 4 + 20).toString("ascii");
  return header.startsWith(MNY_MAGIC) || header.startsWith("Standard ACE DB");
}

/** Runs a command with argv; resolves with stdout string, rejects on
 *  non-zero exit or stderr containing "encrypted"/"password". */
function run(cmd, args, timeoutMs = MDB_EXPORT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (b) => { stdout += b.toString("utf8"); });
    child.stderr.on("data", (b) => { stderr += b.toString("utf8"); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`${cmd} exit ${code}: ${stderr.trim() || "no stderr"}`));
      }
      resolve(stdout);
    });
  });
}

/** Parse an mdb-export CSV string. Handles quoted fields with escaped
 *  quotes. Returns an array of objects keyed by the header row. */
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length < 2) return [];
  const splitCsvLine = (line) => {
    const out = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else {
        if (c === ",") { out.push(cur); cur = ""; }
        else if (c === '"') inQ = true;
        else cur += c;
      }
    }
    out.push(cur);
    return out;
  };
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1, 1 + MAX_ROWS).map(l => {
    const cols = splitCsvLine(l);
    const row = {};
    for (let i = 0; i < headers.length; i++) row[headers[i]] = cols[i];
    return row;
  });
}

/** Convert Money's date columns (usually "YYYY-MM-DD HH:MM:SS" from
 *  mdb-export) into a "YYYY-MM-DD" local date. */
function normalizeDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function toNumber(s) {
  if (s === null || s === undefined || s === "") return null;
  const n = Number(String(s).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * If mdbtools reports the file is encrypted, ask sunriise to write out
 * an unlocked copy. Returns the path to the unlocked .mdb.
 *
 * sunriise's ExportToMdb CLI takes an input .mny and an output .mdb
 * path; if the file is password-protected and no password is provided,
 * it uses the Sunset-era backdoor to open it anyway.
 */
async function unlockWithSunriise(inputPath, password) {
  // If the jar is missing we bail with a clear message rather than a
  // cryptic "java exit 1". Operators who built without the sunriise
  // stage still get mdbtools for unencrypted files, so this is only an
  // error when we actually need to unlock.
  try { await fs.access(SUNRIISE_JAR); }
  catch {
    throw new Error(
      "This .mny file is password-protected and sunriise is not installed in this container. " +
      "Rebuild the backend image so /opt/sunriise.jar is present, or unlock the file with sunriise externally."
    );
  }
  const outPath = inputPath.replace(/\.mny$/i, "") + "-unlocked.mdb";
  const args = ["-jar", SUNRIISE_JAR,
    "-i", inputPath, "-o", outPath,
    ...(password ? ["-p", password] : []),
  ];
  try {
    await run("java", args, SUNRIISE_TIMEOUT_MS);
  } catch (e) {
    // sunriise sometimes exits nonzero even after writing the mdb —
    // check for the output file before giving up.
    try { await fs.access(outPath); }
    catch {
      throw new Error(
        "sunriise could not open this .mny file. Details: " + (e.message || "unknown"). replace(/\n+/g, " ")
      );
    }
  }
  return outPath;
}

/**
 * Pull the column list for a given table from `mdb-schema`. Returns an
 * array of raw column names in declaration order. Empty array on any
 * failure — callers already treat "no schema" as "table not usable".
 */
async function tableColumns(mdbPath, tableName) {
  try {
    // mdb-schema emits CREATE TABLE DDL. Parse column names out of the
    // parenthesised block. -T narrows to a single table so we don't
    // pull the entire schema on every probe.
    const ddl = await run("mdb-schema", ["-T", tableName, mdbPath]);
    const paren = ddl.match(/\(([\s\S]+)\)/);
    if (!paren) return [];
    return paren[1]
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !/^\s*(PRIMARY|UNIQUE|KEY|CONSTRAINT|CHECK|FOREIGN)/i.test(l))
      // Column names come first in each line, followed by the type.
      // mdb-schema quotes them with square brackets in some builds.
      .map(l => (l.match(/^\[?([A-Za-z_][A-Za-z0-9_]*)\]?/) || [])[1])
      .filter(Boolean);
  } catch { return []; }
}

/**
 * Given the columns of a Money-ish table, pick the columns that look
 * like the fields we care about. Uses simple prefix / substring rules
 * so we're resilient across Money 99 / 2001 / 2002 / 2004 / 2005 /
 * Deluxe / Sunset schema drift.
 */
function detectColumns(cols) {
  // Case-insensitive comparisons throughout. `first(pattern)` returns
  // the first matching real column name so the caller can look it up
  // in a row.
  const first = (test) => cols.find(c => test(c.toLowerCase())) || null;
  return {
    date:      first(c => c === "dt" || c === "dtenter" || c === "dtposted"
                       || c === "dtactual" || c.startsWith("dt")),
    amount:    first(c => c === "amt" || c === "amount"
                       || c === "damt" || c.startsWith("amt")),
    payeeFk:   first(c => c === "lhpay" || c === "hpay"
                       || c.includes("pay")),
    catFk:     first(c => c === "lhcat" || c === "hcat"
                       || c.includes("cat")),
    acctFk:    first(c => c === "hacct" || c === "lhacct"
                       || c === "htobj" || c === "lfrom"
                       || (c.includes("acct") && !c.includes("subacct"))
                       || (c.startsWith("l") && c.includes("acct"))),
    memo:      first(c => c === "szmemo" || c === "memo"
                       || c === "szname"),
    check:     first(c => c === "lchk" || c === "chk"
                       || c === "check" || c === "checknum"),
  };
}

/**
 * Read one of the lookup tables (payees / categories / accounts) and
 * return an id → name Map. Column detection mirrors detectColumns so
 * a Money variant that renamed `szName` to `szFull` still works.
 */
async function readLookup(mdbPath, tableName) {
  const cols = await tableColumns(mdbPath, tableName);
  if (cols.length === 0) return new Map();
  const idCol = cols.find(c => /^h/i.test(c) && !/^szh/i.test(c))
    || cols.find(c => /^l?h[a-z]+$/i.test(c))
    || cols.find(c => /_id$/i.test(c))
    || cols[0];
  const nameCol = cols.find(c => /^(szfull|szname|name|szdesc)$/i.test(c))
    || cols.find(c => /^sz/i.test(c))
    || cols[1] || cols[0];
  const csv = await run("mdb-export", [mdbPath, tableName]).catch(() => "");
  const map = new Map();
  for (const r of parseCsv(csv)) {
    const id = r[idCol]; const name = r[nameCol];
    if (id !== undefined && id !== "" && name) map.set(String(id), name);
  }
  return map;
}

/**
 * Parse a .mny buffer. Returns { format: "mny", transactions: [...] }
 * on success. Throws with a helpful message on unreadable files.
 * Writes the buffer to a temp file because mdbtools reads from disk
 * paths, not stdin. Optional `password` is forwarded to sunriise if
 * the file is encrypted.
 */
export async function parseMny(buf, password = null) {
  if (!isMnyBuffer(buf)) {
    throw new Error("Not a valid .mny / Jet database file.");
  }
  const tmp = path.join(os.tmpdir(),
    `mny-${crypto.randomBytes(8).toString("hex")}.mny`);
  await fs.writeFile(tmp, buf);
  const tempPaths = [tmp];
  try {
    // Discover tables. If mdb-tables barfs on encryption, run sunriise
    // to produce an unlocked .mdb we can drive from mdbtools instead.
    let tables;
    let workingPath = tmp;
    try {
      const out = await run("mdb-tables", ["-1", workingPath]);
      tables = out.split(/\s+/).filter(Boolean);
      // Money 2000+ writes a specific set of system tables even when
      // encryption is off; if we see zero tables OR only see the
      // MSysObjects internals it usually means encryption defeated us.
      const looksEmpty = tables.length === 0
        || tables.every(t => t.startsWith("MSys"));
      if (looksEmpty) throw new Error("no user tables (likely encrypted)");
    } catch (e) {
      if (/password|encrypted|invalid|not.*jet|encrypted/i.test(e.message)) {
        workingPath = await unlockWithSunriise(tmp, password);
        tempPaths.push(workingPath);
        const out = await run("mdb-tables", ["-1", workingPath]);
        tables = out.split(/\s+/).filter(Boolean);
      } else {
        throw e;
      }
    }

    // ── Candidate transaction tables ──────────────────────────────
    // Money variants have used TRN, TRN_TXN, TRANSACTION, TRAN, plus
    // subdivided splits into TRN_SPLIT / TRN2. We probe every table
    // that looks like a plausible transaction store and merge results,
    // skipping investment records (TRN_INV) which belong in the lot
    // tracker rather than the transaction ledger.
    const candidates = tables.filter(t =>
         /^TRN($|[_A-Z])/i.test(t)
      || /^TRANSACTION/i.test(t)
      || /^TRAN(?![S])/i.test(t)
    ).filter(t => !/INV/i.test(t));
    if (candidates.length === 0) {
      throw new Error(
        "Could not find a transaction table in this .mny file. Saw: " + tables.join(", ")
      );
    }

    // ── Lookup tables ─────────────────────────────────────────────
    // Payees, categories, accounts — each optional. Table name variants
    // covered here span every Money release we've seen.
    const payTable  = tables.find(t => /^(PAY|PAYEE)($|E?)/i.test(t)) || null;
    const catTable  = tables.find(t => /^(CAT|CATEGORY)($|_)/i.test(t)) || null;
    const acctTable = tables.find(t => /^(ACCT|ACCOUNT)($|_)/i.test(t)) || null;

    const [payees, cats, accts] = await Promise.all([
      payTable  ? readLookup(workingPath, payTable)  : Promise.resolve(new Map()),
      catTable  ? readLookup(workingPath, catTable)  : Promise.resolve(new Map()),
      acctTable ? readLookup(workingPath, acctTable) : Promise.resolve(new Map()),
    ]);

    const transactions = [];
    const perTableSummary = [];
    for (const table of candidates) {
      const cols = await tableColumns(workingPath, table);
      const map = detectColumns(cols);
      // A usable transaction table has at minimum a date column and an
      // amount column. Anything missing those is an unrelated table
      // (a lookup or a config) that just happens to match the name.
      if (!map.date || !map.amount) {
        perTableSummary.push(`${table}(skipped: missing date/amount)`);
        continue;
      }
      const csv = await run(
        "mdb-export", ["-D", "%Y-%m-%d", workingPath, table]
      ).catch(() => "");
      const rows = parseCsv(csv);
      let kept = 0;
      for (const r of rows) {
        const date = normalizeDate(r[map.date]);
        const amount = toNumber(r[map.amount]);
        if (!date || amount === null) continue;
        const payeeId = map.payeeFk ? r[map.payeeFk] : null;
        const catId   = map.catFk   ? r[map.catFk]   : null;
        const acctId  = map.acctFk  ? r[map.acctFk]  : null;
        const memo    = map.memo    ? r[map.memo]    : null;
        const chk     = map.check   ? r[map.check]   : null;
        const merchant = (payeeId && payees.get(String(payeeId)))
          || memo || "Unknown";
        const category = (catId && cats.get(String(catId))) || "Other";
        const fileAccount = (acctId && accts.get(String(acctId))) || null;
        transactions.push({
          date,
          merchant: String(merchant).slice(0, 255),
          category: String(category).replace(/^\[.*\]$/, "Transfer").slice(0, 64) || "Other",
          amount,
          note: memo ? String(memo).slice(0, 500) : null,
          checkNumber: chk ? String(chk).slice(0, 32) : null,
          fileAccount: fileAccount ? String(fileAccount).slice(0, 128) : null,
        });
        kept++;
      }
      perTableSummary.push(`${table}(${kept})`);
    }
    if (transactions.length === 0) {
      throw new Error(
        "Found transaction tables in the .mny file but no rows had a usable date + amount. Tables tried: "
        + perTableSummary.join(", ")
      );
    }
    return { format: "mny", transactions };
  } finally {
    // Best-effort cleanup; a leftover temp file isn't a security issue
    // (bind mount is per-container) but we don't want to leak them.
    for (const p of tempPaths) fs.unlink(p).catch(() => {});
  }
}
