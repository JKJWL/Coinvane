// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Joint-account helpers — invitations, shares, audit logging, and
// context resolution. The feature is opt-in per-owner (via
// users.joint_enabled). Guest-only users cannot access any personal
// data — they only ever see contexts they've been invited to.
//
// Context resolution rules (used by req.contextUserId decorator):
//   1. If X-Context-User-Id header is present:
//        - must equal the signed-in user's id, OR
//        - the signed-in user must have an active share for that id
//      Otherwise 403.
//   2. If not present:
//        - is_guest_only user: first active share owner_id (or 403 if none)
//        - regular user: their own id
//
// Every guest-scoped write is expected to call jointAudit() so the
// owner has visibility.

import cryptoNode from "node:crypto";
import { query, queryOne } from "./db.js";

export const JOINT_INVITE_TTL_MINUTES = 60 * 24 * 7; // 7 days
export const VALID_PERMISSIONS = new Set(["viewer", "editor"]);

export function hashToken(raw) {
  return cryptoNode.createHash("sha256").update(String(raw)).digest("hex");
}

// Returns the raw token (base64url), the hash (for DB), and the
// expires-at Date. The raw value must ONLY be sent in the invite
// email — server never stores it.
export function newInviteToken() {
  const raw = cryptoNode.randomBytes(32).toString("base64url");
  const hash = hashToken(raw);
  const expiresAt = new Date(Date.now() + JOINT_INVITE_TTL_MINUTES * 60 * 1000);
  return { raw, hash, expiresAt };
}

// Look up an unredeemed, unrevoked, unexpired invitation by raw
// token. Returns the row or null.
export async function findInvitationByToken(rawToken) {
  const hash = hashToken(rawToken);
  return queryOne(
    `SELECT id, owner_user_id, invitee_email, permissions, expires_at
       FROM joint_invitations
      WHERE token_hash = ?
        AND accepted_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > NOW()
      LIMIT 1`,
    [hash]
  );
}

// Return every active share the given user has as a GUEST — the
// list of contexts they can switch into. Owner's own context is
// added separately by the caller if the user isn't guest-only.
export async function listActiveSharesForGuest(guestUserId) {
  return query(
    `SELECT s.id, s.owner_user_id, s.permissions,
            u.email AS owner_email, u.name AS owner_name, u.picture AS owner_picture
       FROM joint_shares s
       JOIN users u ON u.id = s.owner_user_id
      WHERE s.guest_user_id = ? AND s.revoked_at IS NULL
      ORDER BY s.created_at DESC`,
    [guestUserId]
  );
}

// Return the active share row for (ownerId, guestId) or null. Used
// to check whether a signed-in user is allowed to view an owner's
// context, and to look up the guest's permissions for authorization.
export async function findActiveShare(ownerId, guestId) {
  return queryOne(
    `SELECT id, permissions
       FROM joint_shares
      WHERE owner_user_id = ? AND guest_user_id = ? AND revoked_at IS NULL
      LIMIT 1`,
    [ownerId, guestId]
  );
}

// Fire-and-forget audit writer. Never throws.
export async function jointAudit(ownerUserId, actorUserId, action, targetType, targetId, meta) {
  try {
    let metaStr = null;
    if (meta != null) {
      metaStr = typeof meta === "string" ? meta : JSON.stringify(meta);
      if (metaStr.length > 2000) metaStr = metaStr.slice(0, 2000);
    }
    await query(
      `INSERT INTO joint_audit_log
         (owner_user_id, actor_user_id, action, target_type, target_id, meta)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [ownerUserId, actorUserId, String(action).slice(0, 64),
       targetType ? String(targetType).slice(0, 32) : null,
       targetId ?? null, metaStr]
    );
  } catch { /* audit never blocks the request */ }
}

// Resolve the context user for a request. Reads the X-Context-User-Id
// header; validates access. Called from an onRequest decorator so
// every downstream handler can rely on req.contextUserId.
//
// Returns { contextUserId, contextRole } where contextRole is one of:
//   'owner'  — signed-in user is looking at their own instance
//   'editor' — signed-in user is a guest on this instance with write access
//   'viewer' — signed-in user is a guest with read-only access
//
// Throws a Fastify-friendly error (with statusCode) on invalid access.
export async function resolveContext(actor, headerVal) {
  const actorId = Number(actor.id);
  // No override: default context = actor's own instance, unless
  // they are a guest-only user (in which case pick their first
  // active share; if none, they have nothing to see and we 403).
  if (!headerVal) {
    if (!actor.is_guest_only) return { contextUserId: actorId, contextRole: "owner" };
    const shares = await listActiveSharesForGuest(actorId);
    if (shares.length === 0) {
      const err = new Error("This account has no accessible joint contexts.");
      err.statusCode = 403;
      throw err;
    }
    return { contextUserId: shares[0].owner_user_id, contextRole: shares[0].permissions === "viewer" ? "viewer" : "editor" };
  }

  const requested = Number(headerVal);
  if (!Number.isFinite(requested) || requested <= 0) {
    const err = new Error("Invalid context header.");
    err.statusCode = 400;
    throw err;
  }

  if (requested === actorId) {
    if (actor.is_guest_only) {
      const err = new Error("Guest-only users have no personal context.");
      err.statusCode = 403;
      throw err;
    }
    return { contextUserId: actorId, contextRole: "owner" };
  }

  const share = await findActiveShare(requested, actorId);
  if (!share) {
    const err = new Error("You do not have access to that context.");
    err.statusCode = 403;
    throw err;
  }
  return {
    contextUserId: requested,
    contextRole: share.permissions === "viewer" ? "viewer" : "editor",
  };
}

// Helper for write-gate checks in routes that have adopted the
// context sweep. Throws 403 when a guest with only 'viewer'
// permission attempts a mutation.
export function assertCanWrite(req) {
  if (req.contextRole === "viewer") {
    const err = new Error("This context is read-only for you.");
    err.statusCode = 403;
    throw err;
  }
}

// Owner-only guard for routes like /me/joint/* that mutate the
// ownership graph. Rejects when the actor is browsing someone
// else's context or when the actor is a guest-only user.
export function assertContextOwner(req) {
  if (req.contextRole !== "owner") {
    const err = new Error("Only the account owner can perform this action.");
    err.statusCode = 403;
    throw err;
  }
}

// Reusable per-route write guard. Every data-route registers this
// as a preHandler right after app.authenticate. It blocks mutations
// when the actor is a viewer on someone else's context, and audits
// every write performed by a guest so the owner sees the activity
// in Settings → Sharing → Audit.
export function makeWriteGuard(kind) {
  return async (req, reply) => {
    if (!["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) return;
    if (req.contextRole === "viewer") {
      return reply.code(403).send({ error: "This context is read-only for you." });
    }
    if (req.contextRole !== "owner") {
      await jointAudit(req.contextUserId, req.actorId, `${kind}.${req.method.toLowerCase()}`, kind, req.params?.id || null, { path: req.url });
    }
  };
}
