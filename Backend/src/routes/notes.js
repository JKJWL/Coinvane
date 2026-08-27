// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "../db.js";
import { makeWriteGuard } from "../joint.js";
import { encrypt, decrypt } from "../crypto.js";

// Notes can contain personally sensitive freeform text (account #s, security questions,
// memos about people). We encrypt the content at rest with AES-256-GCM.
// Titles stay searchable; content does not (per-row IV makes it unindexable anyway).

const ENC_PREFIX = "enc:v1:";

function encContent(plain) {
  if (plain === null || plain === undefined || plain === "") return null;
  return ENC_PREFIX + encrypt(String(plain));
}
function decContent(stored) {
  if (stored === null || stored === undefined) return null;
  if (typeof stored === "string" && stored.startsWith(ENC_PREFIX)) {
    try { return decrypt(stored.slice(ENC_PREFIX.length)); }
    catch { return null; } // corrupted — fail closed
  }
  // Legacy plaintext rows from before encryption was added
  return stored;
}

function decryptRow(row) {
  if (!row) return row;
  return { ...row, content: decContent(row.content) };
}

export default async function (app) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", makeWriteGuard("note"));

  app.get("/", async (req) => {
    const rows = await query(
      `SELECT id, title, content, pinned, color, created_at AS createdAt, updated_at AS updatedAt
       FROM notes WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC`,
      [req.contextUserId]
    );
    return rows.map(decryptRow);
  });

  app.post("/", async (req) => {
    const { title, content, color = "#fef3c7", pinned = false } = req.body || {};
    const r = await query(
      `INSERT INTO notes (user_id, title, content, color, pinned) VALUES (?, ?, ?, ?, ?)`,
      [req.contextUserId, title || null, encContent(content), color, pinned ? 1 : 0]
    );
    const row = await queryOne("SELECT * FROM notes WHERE id = ?", [r.insertId]);
    return decryptRow(row);
  });

  app.patch("/:id", async (req) => {
    const { title, content, color, pinned } = req.body || {};
    await query(
      `UPDATE notes SET
         title = COALESCE(?, title),
         content = COALESCE(?, content),
         color = COALESCE(?, color),
         pinned = COALESCE(?, pinned)
       WHERE id = ? AND user_id = ?`,
      [title ?? null,
       content === undefined ? null : encContent(content),
       color ?? null,
       pinned === undefined ? null : (pinned ? 1 : 0),
       req.params.id, req.contextUserId]
    );
    const row = await queryOne("SELECT * FROM notes WHERE id = ? AND user_id = ?",
      [req.params.id, req.contextUserId]);
    return decryptRow(row);
  });

  app.delete("/:id", async (req) => {
    await query("DELETE FROM notes WHERE id = ? AND user_id = ?",
      [req.params.id, req.contextUserId]);
    return { ok: true };
  });
}
