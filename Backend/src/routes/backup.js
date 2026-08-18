// SPDX-License-Identifier: AGPL-3.0-or-later
//
// .cvn backup routes — full user-data export (and, in a later stage,
// import). Mounted at /api/backup. Every endpoint requires auth; there
// is no admin gate because a user must always be able to export their
// own data on demand (data portability is the whole point).
import { buildCvn } from "../cvn-export.js";
import { parseCvn, targetAccountIsEmpty, previewStats, performImport } from "../cvn-import.js";
import { audit } from "../audit.js";

export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  // ── POST /api/backup/export ──────────────────────────────────────
  // Streams a .cvn ZIP to the client. Body may include an optional
  // {passphrase} string — when present, data.json + attachments are
  // AES-256-GCM encrypted with a PBKDF2-derived key. Absent = plain
  // ZIP (still safe to store somewhere you trust; the file will
  // contain your entire financial history in cleartext).
  //
  // Rate limit is intentionally tight (3/min): each export streams
  // every user-scoped row + every receipt attachment through gzip +
  // GCM, which is disk + CPU heavy. The typical user runs this once
  // in a while for backup, never in a hot loop.
  app.post("/export", {
    config: { rateLimit: { max: 3, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const passphrase = typeof req.body?.passphrase === "string"
      ? req.body.passphrase
      : null;

    // Filename encodes user + date — no email / role leakage. The
    // client's Save dialog picks up on the Content-Disposition.
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `coinvane-${stamp}.cvn`;

    reply.raw.setHeader("Content-Type", "application/x-coinvane-export");
    reply.raw.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    // Uncompressed length is unknown ahead of time (streaming), so no
    // Content-Length. Chunked transfer is fine — modern clients handle it.
    reply.raw.setHeader("Cache-Control", "no-store");
    reply.hijack(); // take over the raw response; Fastify won't wrap.

    try {
      await buildCvn({
        userId: req.user.id,
        passphrase,
        outStream: reply.raw,
      });
      await audit(req.user.id, "backup.exported", req, {
        encrypted: !!passphrase, filename,
      });
      // buildCvn resolves after archive.finalize() and the underlying
      // stream flush. archiver ends the writable for us.
    } catch (e) {
      req.log.error({ err: e.message }, "backup export failed");
      // If we already sent headers we can't turn this into a JSON error
      // — destroy the stream so the client sees a truncated download
      // and knows to retry.
      try { reply.raw.destroy(e); } catch { /* already destroyed */ }
    }
  });

  // ── Import shared: read multipart .cvn upload into a Buffer ─────
  //   Also pulls the optional `passphrase` field from the same form.
  //   Uses @fastify/multipart which is already registered globally.
  async function readUpload(req, reply) {
    const parts = req.parts();
    let fileBuf = null;
    let passphrase = null;
    for await (const p of parts) {
      if (p.type === "file" && p.fieldname === "file") {
        // 128 MB cap on the archive itself. Reasonable ceiling for
        // even a very heavy user (thousands of transactions plus
        // hundreds of MB of receipts would come in well under this).
        fileBuf = await p.toBuffer();
        if (fileBuf.length > 128 * 1024 * 1024) {
          reply.code(413).send({ error: "Backup file too large (128 MB max)." });
          return null;
        }
      } else if (p.type === "field" && p.fieldname === "passphrase") {
        passphrase = typeof p.value === "string" ? p.value : null;
      }
    }
    if (!fileBuf) {
      reply.code(400).send({ error: "No file provided. Attach a .cvn as the 'file' field." });
      return null;
    }
    return { fileBuf, passphrase };
  }

  // ── POST /api/backup/import/preview ──────────────────────────────
  //   Parses + validates the .cvn without inserting a single row.
  //   Returns the manifest + row counts so the UI can show the user
  //   what will land. Fails fast on bad passphrase / corrupt file /
  //   wrong format / non-empty target account.
  app.post("/import/preview", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const up = await readUpload(req, reply);
    if (!up) return;
    let parsed;
    try { parsed = await parseCvn(up.fileBuf, up.passphrase); }
    catch (e) { return reply.code(400).send({ error: e.message }); }
    const empty = await targetAccountIsEmpty(req.user.id);
    return {
      manifest: {
        version: parsed.manifest.version,
        createdAt: parsed.manifest.createdAt,
        encrypted: parsed.manifest.encrypted,
        attachmentCount: parsed.manifest.attachmentCount,
      },
      stats: previewStats(parsed.data),
      targetEmpty: empty.empty,
      // When not empty, tell the UI WHICH table has data so it can
      // point the user at the right cleanup path.
      blockedByTable: empty.empty ? null : empty.table,
      blockedByCount: empty.empty ? 0 : empty.count,
    };
  });

  // ── POST /api/backup/import ──────────────────────────────────────
  //   Runs the actual insert. Guards on empty-account (must have
  //   nothing in EMPTY_CHECK_TABLES) so we can't collide FK ids or
  //   partially merge. Tighter rate limit than preview because it
  //   writes to disk + DB and is much more expensive.
  app.post("/import", {
    config: { rateLimit: { max: 3, timeWindow: "5 minutes" } },
  }, async (req, reply) => {
    const up = await readUpload(req, reply);
    if (!up) return;
    let parsed;
    try { parsed = await parseCvn(up.fileBuf, up.passphrase); }
    catch (e) { return reply.code(400).send({ error: e.message }); }
    const empty = await targetAccountIsEmpty(req.user.id);
    if (!empty.empty) {
      return reply.code(409).send({
        error: `Import refused — your account already contains data (${empty.count} row${empty.count === 1 ? "" : "s"} in ${empty.table}). Use Settings → Clear all data first, then retry.`,
        blockedByTable: empty.table,
        blockedByCount: empty.count,
      });
    }
    try {
      const result = await performImport(req.user.id, parsed.data, parsed.attachments);
      await audit(req.user.id, "backup.imported", req, {
        encrypted: parsed.manifest.encrypted,
        ...result.imported,
      }, { major: true });
      return { ok: true, ...result };
    } catch (e) {
      req.log.error({ err: e.message, stack: e.stack }, "backup import failed");
      return reply.code(500).send({ error: `Import failed partway through: ${e.message}. Use Clear all data to reset and try again.` });
    }
  });
}
