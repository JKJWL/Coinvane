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
// MS Money and older Quicken exports emit `!Account` blocks that name the
// account before the following `!Type:` block. We skip the block entirely
// but keep scanning — records after it are the account's transactions.
const QIF_ACCOUNT_LINE = /^!Account\s*$/i;
// Investment record types (`!Type:Invst`) use Y/N/Q/I/O codes. We don't
// import them into the transaction ledger (they belong in the lot tracker),
// so the parser skips the whole block once it sees this header.
const QIF_INVEST_TYPES = /^!Type:(Invst|Investment)/i;

/** Detect format from raw content. Returns "qif" | "ofx" | "unknown". */
export function detectFormat(raw) {
  const s = String(raw || "").trim();
  if (!s) return "unknown";
  // OFX/QFX either begin with header block "OFXHEADER:100" (SGML-style)
  // or the XML variant "<?xml"; both eventually reach "<OFX>".
  if (/^OFXHEADER:|^<\?xml|<OFX>/i.test(s)) return "ofx";
  if (/^!Type:/im.test(s) || /^!Account/im.test(s) || /^D\d/m.test(s)) return "qif";
  return "unknown";
}

// ── QIF ────────────────────────────────────────────────────────────
// Handles Quicken, MS Money, and Mint exports. Money-specific quirks:
//   !Account blocks name each account before its transactions. We PARSE
//     these (N = account name, T = account type) and stamp every
//     subsequent record with the current account until another !Account
//     block appears. This is what makes multi-account QIF files
//     importable as a coherent set.
//   Split lines using S/E/$ codes (S = child category, E = child memo,
//     $ = child amount). Each split gets its own transaction row so the
//     detail survives round-trip.
//   Apostrophe-year dates (`D07/05'24` in older Money exports) — see
//     parseQifDate below.
export function parseQif(raw) {
  const out = [];
  const lines = String(raw || "").split(/\r?\n/);
  let current = null;
  let skipBlock = false;         // true while inside !Type:Invst
  let inAccountBlock = false;    // true while collecting an !Account header
  let acctDraft = null;          // fields being collected inside !Account
  let currentAccountName = null; // stamped onto every txn until reassigned
  let currentAccountType = null;
  for (const line of lines) {
    if (!line) continue;
    if (QIF_INVEST_TYPES.test(line)) { skipBlock = true;  continue; }
    if (QIF_TYPE_LINE.test(line))    { skipBlock = false; continue; }
    if (QIF_ACCOUNT_LINE.test(line)) { inAccountBlock = true; acctDraft = {}; continue; }
    if (line === "^") {
      if (inAccountBlock) {
        currentAccountName = acctDraft?.name || null;
        currentAccountType = acctDraft?.type || null;
        inAccountBlock = false; acctDraft = null;
        continue;
      }
      if (!skipBlock && current) {
        const normalized = normalizeQifRecord(current, currentAccountName);
        if (normalized) out.push(...normalized);
      }
      current = null;
      continue;
    }
    if (skipBlock) continue;
    if (inAccountBlock) {
      const code = line[0];
      const val = line.slice(1);
      if (code === "N") acctDraft.name = val.trim();
      else if (code === "T") acctDraft.type = val.trim();
      continue;
    }
    if (!current) current = { splits: [] };
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
      // MS Money split lines. S / E / $ can repeat within a single record,
      // one triplet per child leg. We stage them into current.splits and
      // fan out into individual rows during normalization.
      case "S":
        current.splits.push({ category: val, memo: null, amount: null });
        break;
      case "E":
        if (current.splits.length) current.splits[current.splits.length - 1].memo = val;
        break;
      case "$":
        if (current.splits.length) current.splits[current.splits.length - 1].amount = val;
        break;
      default: break;
    }
  }
  return out;
}

function normalizeQifRecord(r, accountName) {
  if (!r) return null;
  const date = parseQifDate(r.date);
  const parentAmount = parseFloatSafe(r.amount);
  if (!date || parentAmount === null) return null;

  // Base row that everything inherits from — payee, note, check#, date.
  const base = {
    date,
    merchant: (r.payee || "Unknown").trim().slice(0, 255),
    category: (r.category || "Other").replace(/^\[.*\]$/, "Transfer").trim().slice(0, 64) || "Other",
    amount: parentAmount,
    note: r.memo ? r.memo.trim().slice(0, 500) : null,
    checkNumber: r.checkNum ? r.checkNum.trim().slice(0, 32) : null,
    fileAccount: accountName ? String(accountName).slice(0, 128) : null,
  };

  // Money splits with usable amounts become their own rows; parent stays
  // as an anchor for the payee/memo. Splits without $ (percent-only or
  // incomplete) are folded into the note on the parent so we don't lose
  // information silently.
  const usableSplits = (r.splits || []).filter(s =>
    Number.isFinite(parseFloatSafe(s.amount))
  );
  if (usableSplits.length === 0) return [base];

  const splitRows = usableSplits.map(s => ({
    date: base.date,
    merchant: base.merchant,
    category: (s.category || "Other").replace(/^\[.*\]$/, "Transfer").trim().slice(0, 64) || "Other",
    amount: parseFloatSafe(s.amount),
    note: s.memo ? String(s.memo).trim().slice(0, 500) : base.note,
    checkNumber: base.checkNumber,
    fileAccount: base.fileAccount,
  }));
  // If the parent amount is fully accounted for by the splits we drop
  // it. Otherwise we keep the parent so the residual survives.
  const splitSum = splitRows.reduce((s, x) => s + Number(x.amount || 0), 0);
  const residual = parentAmount - splitSum;
  if (Math.abs(residual) < 0.01) return splitRows;
  return [{ ...base, amount: residual }, ...splitRows];
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
  // Case-normalised copy for O(1) uppercase indexOf while keeping the
  // original for value extraction. OFX tags are conventionally uppercase
  // but real bank exports mix cases, so we search on the upper copy.
  const S = s.toUpperCase();
  // Scan for <STMTTRN>...</STMTTRN> blocks with indexOf instead of a
  // lazy-quantifier regex. The former regex `/<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi`
  // exhibited quadratic backtracking on inputs with a lone opening tag
  // followed by long strings without a matching close (CodeQL
  // js/polynomial-redos). indexOf pairs the tags in a single linear pass.
  const OPEN = "<STMTTRN>";
  const CLOSE = "</STMTTRN>";
  // Bounded field extractor — reads up to the first `<`, `\r`, or `\n`
  // after the tag. Also indexOf-based so we don't reintroduce a
  // catastrophic regex.
  const scalar = (block, upperBlock, tag) => {
    const openTag = `<${tag}>`;
    const at = upperBlock.indexOf(openTag);
    if (at === -1) return null;
    const start = at + openTag.length;
    // Find the earliest terminator among <, \r, \n.
    let stop = block.length;
    for (let i = start; i < block.length; i++) {
      const c = block.charCodeAt(i);
      if (c === 0x3c /* < */ || c === 0x0d /* \r */ || c === 0x0a /* \n */) {
        stop = i; break;
      }
    }
    const raw = block.slice(start, stop).trim();
    return raw || null;
  };
  // Track the most recent <ACCTID> seen — every STMTTRN belongs to the
  // enclosing statement's account. In practice ACCTID appears inside
  // <BANKACCTFROM> or <CCACCTFROM> before the STMTTRN block, so a
  // simple last-seen scan matches valid OFX structure.
  const acctScan = (uptoIdx) => {
    // Find the last <ACCTID>value</ACCTID> or <ACCTID>value before this
    // position. Bounded, linear scan.
    const tag = "<ACCTID>";
    let at = -1;
    let pos = 0;
    while (pos < uptoIdx) {
      const next = S.indexOf(tag, pos);
      if (next === -1 || next >= uptoIdx) break;
      at = next; pos = next + tag.length;
    }
    if (at === -1) return null;
    const start = at + tag.length;
    let stop = s.length;
    for (let i = start; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 0x3c || c === 0x0d || c === 0x0a) { stop = i; break; }
    }
    return s.slice(start, stop).trim() || null;
  };

  let idx = 0;
  while (true) {
    const start = S.indexOf(OPEN, idx);
    if (start === -1) break;
    const contentStart = start + OPEN.length;
    const end = S.indexOf(CLOSE, contentStart);
    if (end === -1) break;
    const block = s.slice(contentStart, end);
    const upperBlock = S.slice(contentStart, end);
    const fileAccount = acctScan(start);
    idx = end + CLOSE.length;

    const dt = scalar(block, upperBlock, "DTPOSTED");
    const amt = scalar(block, upperBlock, "TRNAMT");
    const nameA = scalar(block, upperBlock, "NAME");
    // <PAYEE>...<NAME>… form. Find <PAYEE> then look for the next
    // <NAME> inside the payee subtree. Same indexOf pattern to keep
    // the whole pass linear.
    let nameB = null;
    const payeeAt = upperBlock.indexOf("<PAYEE>");
    if (payeeAt !== -1) {
      const inner = block.slice(payeeAt);
      const innerUp = upperBlock.slice(payeeAt);
      nameB = scalar(inner, innerUp, "NAME");
    }
    const memo = scalar(block, upperBlock, "MEMO");
    const trnType = scalar(block, upperBlock, "TRNTYPE");
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
      fileAccount: fileAccount ? fileAccount.slice(0, 128) : null,
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
