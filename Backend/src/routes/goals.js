// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "../db.js";

// When a goal is linked to an account (account_id NOT NULL), the goal's
// "saved" is the account's CURRENT balance, computed at read time rather
// than tracked via /contribute. Manual contributions are rejected for
// linked goals — the source of truth is the account.
async function withLiveSaved(userId, rows) {
  const linkedIds = rows.filter(r => r.accountId != null).map(r => r.accountId);
  if (linkedIds.length === 0) return rows;
  const placeholders = linkedIds.map(() => "?").join(",");
  const balances = await query(
    `SELECT id, name, balance FROM accounts
     WHERE user_id = ? AND id IN (${placeholders})`,
    [userId, ...linkedIds]
  );
  const map = new Map(balances.map(b => [b.id, b]));
  return rows.map(r => {
    if (r.accountId == null) return r;
    const acc = map.get(r.accountId);
    if (!acc) return { ...r, accountName: null };
    return { ...r, saved: Number(acc.balance) || 0, accountName: acc.name };
  });
}

export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (req) => {
    // Archived goals (from Stage 6 archive_completed_goals) hide by
    // default. Pass ?includeArchived=1 to see them (used by a future
    // "archive" viewer — not exposed in UI yet).
    const includeArchived = req.query?.includeArchived === "1"
      || req.query?.includeArchived === "true";
    const rows = await query(
      `SELECT id, name, target, saved, deadline, icon, color,
              account_id AS accountId, archived_at AS archivedAt,
              created_at AS createdAt
       FROM goals
       WHERE user_id = ?
         ${includeArchived ? "" : "AND archived_at IS NULL"}
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    return withLiveSaved(req.user.id, rows);
  });

  app.post("/", async (req, reply) => {
    const {
      name, target, saved = 0, deadline,
      icon = "Target", color = "#0ea5e9",
      account_id = null,
    } = req.body || {};
    if (!name || !target) return reply.code(400).send({ error: "name and target required" });
    // Validate the account belongs to this user when supplied.
    let acctId = null;
    if (account_id != null && account_id !== "") {
      const acc = await queryOne(
        "SELECT id FROM accounts WHERE id = ? AND user_id = ?",
        [account_id, req.user.id]
      );
      if (!acc) return reply.code(400).send({ error: "account not found" });
      acctId = acc.id;
    }
    const r = await query(
      `INSERT INTO goals (user_id, name, target, saved, deadline, icon, color, account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      // For linked goals "saved" is ignored at read time but we still
      // persist 0 to keep the column sane.
      [req.user.id, name, target, acctId ? 0 : saved, deadline || null, icon, color, acctId]
    );
    const rows = await query(
      `SELECT id, name, target, saved, deadline, icon, color,
              account_id AS accountId, created_at AS createdAt
       FROM goals WHERE id = ?`,
      [r.insertId]
    );
    return (await withLiveSaved(req.user.id, rows))[0];
  });

  app.patch("/:id", async (req, reply) => {
    const { name, target, saved, deadline, icon, color, account_id } = req.body || {};
    // Account ownership check when (re)linking. `account_id: null` unlinks.
    let acctIdParam = undefined;
    if (account_id !== undefined) {
      if (account_id === null || account_id === "") {
        acctIdParam = null;
      } else {
        const acc = await queryOne(
          "SELECT id FROM accounts WHERE id = ? AND user_id = ?",
          [account_id, req.user.id]
        );
        if (!acc) return reply.code(400).send({ error: "account not found" });
        acctIdParam = acc.id;
      }
    }
    await query(
      `UPDATE goals SET
         name = COALESCE(?, name),
         target = COALESCE(?, target),
         saved = COALESCE(?, saved),
         deadline = COALESCE(?, deadline),
         icon = COALESCE(?, icon),
         color = COALESCE(?, color),
         account_id = ${acctIdParam === undefined ? "account_id" : "?"}
       WHERE id = ? AND user_id = ?`,
      acctIdParam === undefined
        ? [name ?? null, target ?? null, saved ?? null, deadline ?? null, icon ?? null, color ?? null,
           req.params.id, req.user.id]
        : [name ?? null, target ?? null, saved ?? null, deadline ?? null, icon ?? null, color ?? null,
           acctIdParam, req.params.id, req.user.id]
    );
    const rows = await query(
      `SELECT id, name, target, saved, deadline, icon, color,
              account_id AS accountId, created_at AS createdAt
       FROM goals WHERE id = ?`,
      [req.params.id]
    );
    return (await withLiveSaved(req.user.id, rows))[0];
  });

  // Adjust "saved" by a positive (deposit) or negative (withdrawal) amount.
  // Result is clamped to [0, target] so users can't sink below zero or
  // overshoot past their goal. Refuses to operate on account-linked goals
  // since the linked account's balance is the source of truth.
  app.post("/:id/contribute", async (req, reply) => {
    const { amount } = req.body || {};
    const delta = Number(amount);
    if (!Number.isFinite(delta) || delta === 0) {
      return reply.code(400).send({ error: "amount must be a non-zero number" });
    }
    const g = await queryOne(
      "SELECT id, saved, target, account_id FROM goals WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    if (!g) return reply.code(404).send({ error: "goal not found" });
    if (g.account_id != null) {
      return reply.code(400).send({
        error: "This goal is linked to a bank account — contributions are tracked automatically.",
      });
    }
    const newSaved = Math.max(0, Math.min(Number(g.target), Number(g.saved) + delta));
    await query("UPDATE goals SET saved = ? WHERE id = ?", [newSaved, g.id]);
    const rows = await query(
      `SELECT id, name, target, saved, deadline, icon, color,
              account_id AS accountId, created_at AS createdAt
       FROM goals WHERE id = ?`,
      [g.id]
    );
    return rows[0];
  });

  app.delete("/:id", async (req) => {
    await query("DELETE FROM goals WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]);
    return { ok: true };
  });
}
