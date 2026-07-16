// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Parsers for Quicken/Mint migration formats: QIF, OFX, QFX.
 *
 * QIF (Quicken Interchange Format, plain text, line-based):
 *   !Type:Bank            ← account type header (or CCard / Cash / Invst)
 *   D01/15/2024           ← date
 *   T-45.99               ← amount (negative = expense)
 *   PWALMART              ← payee / merchant
 *   LGroceries            ← category (may be [Account] for transfers)
 *   MSome memo            ← memo
 *   ^                     ← end of record
 *
 * OFX / QFX (SGML-ish, headers block + <OFX>…</OFX>):
 *   <STMTTRN>
 *     <TRNTYPE>DEBIT
 *     <DTPOSTED>20240115120000[0:UTC]
 *     <TRNAMT>-45.99
 *     <FITID>ABC123           (bank's own unique id — we DON'T store, but we
 *                              could dedupe on it in future)
 *     <NAME>WALMART           (some banks use <PAYEE><NAME>…)
 *     <MEMO>Some memo
 *   </STMTTRN>
 *
 * Everything returns the SAME normalized shape so the route handler can
 * insert transactions the same way regardless of source format:
 *   [{ date, merchant, category, amount, note }]
 * date is always YYYY-MM-DD. amount is always signed number (negative = expense).
 */

const QIF_TYPE_LINE = /^!Type:(\w+)/i;

/** Detect format from raw content. Returns "qif" | "ofx" | "unknown". */
export function detectFormat(raw) {
  const s = String(raw || "").trim();
  if (!s) return "unknown";
  // OFX/QFX either begin with header block "OFXHEADER:100" (SGML-style)
  // or the XML variant "<?xml"; both eventually reach "<OFX>".
  if (/^OFXHEADER:|^<\?xml|<OFX>/i.test(s)) return "ofx";
  if (/^!Type:/im.test(s) || /^D\d/m.test(s)) return "qif";
  return "unknown";
}

// ── QIF ────────────────────────────────────────────────────────────
export function parseQif(raw) {
  const out = [];
  const lines = String(raw || "").split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    if (!line) continue;
    if (QIF_TYPE_LINE.test(line)) continue; // account type header, ignore
    if (line === "^") {
      if (current) {
        const normalized = normalizeQifRecord(current);
        if (normalized) out.push(normalized);
      }
      current = null;
      continue;
    }
    if (!current) current = {};
    const code = line[0];
    const val = line.slice(1);
    switch (code) {
      case "D": current.date = val; break;
      case "T": current.amount = val; break;
      case "U": if (!current.amount) current.amount = val; break; // amount alt
      case "P": current.payee = val; break;
      case "L": current.category = val; break;
      case "M": current.memo = val; break;
      case "N": current.checkNum = val; break;
      case "C": current.cleared = val; break;
      // Investment records use additional codes (Y=security, Q=quantity,
      // I=price). We skip investments for now — they belong in Stage 3b's
      // lot tracking, not the transactions table.
      default: break;
    }
  }
  return out;
}

function normalizeQifRecord(r) {
  if (!r) return null;
  const date = parseQifDate(r.date);
  const amount = parseFloatSafe(r.amount);
  if (!date || amount === null) return null;
  return {
    date,
    merchant: (r.payee || "Unknown").trim().slice(0, 255),
    category: (r.category || "Other").replace(/^\[.*\]$/, "Transfer").trim().slice(0, 64) || "Other",
    amount,
    note: r.memo ? r.memo.trim().slice(0, 500) : null,
  };
}

// QIF dates are usually MM/DD/YYYY, MM/DD/YY, or DD/MM/YYYY.
// American exports dominate — we assume MM/DD/[YY]YY. Also handles
// Quicken's D07/05'2024 apostrophe-year form.
function parseQifDate(s) {
  if (!s) return null;
  const cleaned = String(s).replace(/[^\d\/'\-]/g, "").replace(/'/g, "/");
  const parts = cleaned.split(/[\/\-]/).map(p => p.trim()).filter(Boolean);
  if (parts.length !== 3) return null;
  let [a, b, c] = parts;
  // Assume MM/DD/YYYY
  let m = Number(a), d = Number(b), y = Number(c);
  if (y < 100) y += (y >= 70 ? 1900 : 2000);
  if (!Number.isFinite(m) || !Number.isFinite(d) || !Number.isFinite(y)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseFloatSafe(s) {
  if (s === null || s === undefined) return null;
  const n = Number(String(s).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ── OFX / QFX ──────────────────────────────────────────────────────
// The <OFX>...</OFX> body is SGML by default (unclosed tags terminated
// by newline / next tag). We use two regex passes:
//   1. Slice every <STMTTRN>...</STMTTRN> block
//   2. Extract the individual scalar fields inside each block
// XML-flavored OFX (with `<?xml`) works with the same regexes because
// they only require the opening tag + value, not proper close.
export function parseOfx(raw) {
  const out = [];
  const s = String(raw || "");
  const blockRe = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  const scalar = (block, tag) => {
    const re = new RegExp(`<${tag}>([^<\\r\\n]+)`, "i");
    const m = block.match(re);
    return m ? m[1].trim() : null;
  };
  let mBlock;
  while ((mBlock = blockRe.exec(s)) !== null) {
    const block = mBlock[1];
    const dt = scalar(block, "DTPOSTED");
    const amt = scalar(block, "TRNAMT");
    const nameA = scalar(block, "NAME");
    const nameB = block.match(/<PAYEE>[\s\S]*?<NAME>([^<\r\n]+)/i)?.[1]?.trim() || null;
    const memo = scalar(block, "MEMO");
    const trnType = scalar(block, "TRNTYPE");
    const date = parseOfxDate(dt);
    const amount = parseFloatSafe(amt);
    if (!date || amount === null) continue;
    // Bank OFX doesn't emit categories — categorization is up to us. Fall
    // back to "Other"; user's merchant rules will remap on next sync.
    // TRNTYPE=XFER is a hint we can lift into a category.
    let category = "Other";
    if (trnType && /XFER/i.test(trnType)) category = "Transfer";
    out.push({
      date,
      merchant: (nameA || nameB || "Unknown").slice(0, 255),
      category,
      amount,
      note: memo ? memo.slice(0, 500) : null,
    });
  }
  return out;
}

// OFX dates come in as YYYYMMDDHHMMSS or YYYYMMDD with an optional
// [-5:EST] timezone suffix. We only need the date portion.
function parseOfxDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const [_, y, mo, d] = m;
  const yr = Number(y), mm = Number(mo), dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${y}-${mo}-${d}`;
}

// ── Top-level ──────────────────────────────────────────────────────
export function parseAny(raw) {
  const fmt = detectFormat(raw);
  if (fmt === "qif") return { format: "qif", transactions: parseQif(raw) };
  if (fmt === "ofx") return { format: "ofx", transactions: parseOfx(raw) };
  return { format: "unknown", transactions: [] };
}
