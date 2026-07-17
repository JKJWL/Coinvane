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
    // Try TRN first (Money 2000+ transaction table), fall back to any
    // "TRN%"-prefixed table if the schema is atypical.
    const trnTable = tables.includes("TRN")
      ? "TRN"
      : tables.find(t => /^TRN($|_)/i.test(t));
    if (!trnTable) {
      throw new Error(
        "Could not find a transaction table in this .mny file. Expected 'TRN' but saw: " + tables.join(", ")
      );
    }
    // Payee + category lookup — Money stores merchant/category as FKs,
    // not inline strings. Absence of either table is non-fatal; we just
    // fall back to blank for those columns.
    const payTable = tables.includes("PAY") ? "PAY" : null;
    const catTable = tables.includes("CAT") ? "CAT" : null;
    const [trnCsv, payCsv, catCsv] = await Promise.all([
      run("mdb-export", ["-D", "%Y-%m-%d", workingPath, trnTable]),
      payTable ? run("mdb-export", [workingPath, payTable]).catch(() => "") : Promise.resolve(""),
      catTable ? run("mdb-export", [workingPath, catTable]).catch(() => "") : Promise.resolve(""),
    ]);

    const trn = parseCsv(trnCsv);
    const payees = new Map();
    for (const p of parseCsv(payCsv)) {
      const id = p.hpay || p.pay_id || p.id;
      const name = p.szFull || p.szName || p.name;
      if (id && name) payees.set(String(id), name);
    }
    const cats = new Map();
    for (const c of parseCsv(catCsv)) {
      const id = c.hcat || c.cat_id || c.id;
      const name = c.szFull || c.szName || c.name;
      if (id && name) cats.set(String(id), name);
    }

    // Column names vary by Money version. Probe common variants.
    const pick = (row, ...keys) => {
      for (const k of keys) if (row[k] !== undefined && row[k] !== "") return row[k];
      return null;
    };
    const transactions = [];
    for (const r of trn) {
      const date = normalizeDate(pick(r, "dt", "dtEnter", "dtPosted"));
      const amount = toNumber(pick(r, "amt", "amount"));
      if (!date || amount === null) continue;
      const payeeId = pick(r, "lHpay", "hpay");
      const catId = pick(r, "lHcat", "hcat");
      const merchant = (payeeId && payees.get(String(payeeId))) ||
        pick(r, "szMemo") || "Unknown";
      const category = (catId && cats.get(String(catId))) || "Other";
      transactions.push({
        date,
        merchant: String(merchant).slice(0, 255),
        category: String(category).replace(/^\[.*\]$/, "Transfer").slice(0, 64) || "Other",
        amount,
        note: pick(r, "szMemo") ? String(pick(r, "szMemo")).slice(0, 500) : null,
        checkNumber: pick(r, "lchk", "lChk", "check") || null,
      });
    }
    return { format: "mny", transactions };
  } finally {
    // Best-effort cleanup; a leftover temp file isn't a security issue
    // (bind mount is per-container) but we don't want to leak them.
    for (const p of tempPaths) fs.unlink(p).catch(() => {});
  }
}
