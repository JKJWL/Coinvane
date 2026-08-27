// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Joint-account owner + guest routes. Registered at /api/joint.
//   Owner-facing (must be viewing own context):
//     POST   /toggle              enable/disable the whole feature
//     GET    /shares              list active shares + pending invites + audit
//     POST   /invite              create + send an invitation
//     PATCH  /shares/:id          update permissions
//     DELETE /shares/:id          revoke a share
//     DELETE /invitations/:id     revoke a pending invitation
//     GET    /audit               list audit entries (paginated)
//   Guest-facing:
//     GET    /contexts            list all contexts the actor can view
//   Anyone-authenticated:
//     POST   /accept              redeem an invitation token

import { query, queryOne } from "../db.js";
import {
  newInviteToken, hashToken, findInvitationByToken,
  listActiveSharesForGuest, VALID_PERMISSIONS,
  jointAudit, assertContextOwner,
} from "../joint.js";
import { audit } from "../audit.js";
import { enqueueMail } from "../queue.js";
import { isEmailEnabled } from "../mailer.js";

const APP_URL = () => (process.env.APP_URL || "").replace(/\/+$/, "");

export default async function (app) {
  // ── Toggle the whole feature on/off for the signed-in owner ─────
  app.post("/toggle", {
    preHandler: [app.authenticate],
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    assertContextOwner(req);
    const enabled = req.body?.enabled === true;
    await query("UPDATE users SET joint_enabled = ? WHERE id = ?", [enabled ? 1 : 0, req.actorId]);
    // Disabling revokes every active share and cancels every pending
    // invitation. This matches the intuition that "turning off sharing"
    // should stop guests from viewing the owner's data. Owner can
    // re-invite anyone later if they turn it back on.
    if (!enabled) {
      await query("UPDATE joint_shares SET revoked_at = NOW() WHERE owner_user_id = ? AND revoked_at IS NULL", [req.actorId]);
      await query("UPDATE joint_invitations SET revoked_at = NOW() WHERE owner_user_id = ? AND accepted_at IS NULL AND revoked_at IS NULL", [req.actorId]);
    }
    await audit(req.actorId, enabled ? "joint.enable" : "joint.disable", req, {});
    return { ok: true, joint_enabled: enabled };
  });

  // ── List everything on the Sharing settings screen ──────────────
  // Returns { shares, invitations, audit } — the frontend renders
  // all three inline in the Settings → Sharing section.
  app.get("/shares", { preHandler: [app.authenticate] }, async (req) => {
    assertContextOwner(req);
    const shares = await query(
      `SELECT s.id, s.guest_user_id, s.permissions, s.created_at,
              u.email AS guest_email, u.name AS guest_name, u.is_guest_only,
              u.picture AS guest_picture
         FROM joint_shares s
         JOIN users u ON u.id = s.guest_user_id
        WHERE s.owner_user_id = ? AND s.revoked_at IS NULL
        ORDER BY s.created_at DESC`,
      [req.actorId]
    );
    const invitations = await query(
      `SELECT id, invitee_email, permissions, expires_at, created_at
         FROM joint_invitations
        WHERE owner_user_id = ?
          AND accepted_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > NOW()
        ORDER BY created_at DESC`,
      [req.actorId]
    );
    const auditRows = await query(
      `SELECT j.id, j.actor_user_id, j.action, j.target_type, j.target_id, j.meta, j.at,
              u.email AS actor_email, u.name AS actor_name
         FROM joint_audit_log j
         JOIN users u ON u.id = j.actor_user_id
        WHERE j.owner_user_id = ?
        ORDER BY j.at DESC
        LIMIT 100`,
      [req.actorId]
    );
    return { shares, invitations, audit: auditRows };
  });

  // ── Send an invitation ──────────────────────────────────────────
  app.post("/invite", {
    preHandler: [app.authenticate],
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    assertContextOwner(req);
    const email = String(req.body?.email || "").trim().toLowerCase();
    const permissions = String(req.body?.permissions || "editor").toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.code(400).send({ error: "Enter a valid email address" });
    }
    if (!VALID_PERMISSIONS.has(permissions)) {
      return reply.code(400).send({ error: "permissions must be 'viewer' or 'editor'" });
    }
    // Refuse if the owner is trying to invite themselves.
    if (req.user.email && email === String(req.user.email).toLowerCase()) {
      return reply.code(400).send({ error: "You cannot invite yourself." });
    }
    // Owner must have joint_enabled = true.
    const owner = await queryOne("SELECT joint_enabled FROM users WHERE id = ?", [req.actorId]);
    if (!owner?.joint_enabled) {
      return reply.code(403).send({ error: "Enable joint accounts in Settings → Sharing first." });
    }
    // Refuse if there's already an active share OR a pending invite.
    const existing = await queryOne(
      `SELECT s.id
         FROM joint_shares s
         JOIN users u ON u.id = s.guest_user_id
        WHERE s.owner_user_id = ? AND s.revoked_at IS NULL AND u.email = ?`,
      [req.actorId, email]
    );
    if (existing) {
      return reply.code(409).send({ error: `${email} is already a shared user.` });
    }
    const pending = await queryOne(
      `SELECT id FROM joint_invitations
        WHERE owner_user_id = ? AND invitee_email = ?
          AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`,
      [req.actorId, email]
    );
    if (pending) {
      return reply.code(409).send({ error: `An invitation to ${email} is already pending.` });
    }

    const { raw, hash, expiresAt } = newInviteToken();
    const r = await query(
      `INSERT INTO joint_invitations (owner_user_id, invitee_email, token_hash, permissions, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [req.actorId, email, hash, permissions, expiresAt]
    );

    // Send the email (if enabled). Link format:
    //   {APP_URL}/#joint-invite?t=<raw-token>
    // Frontend catches this hash and calls POST /joint/accept
    // once the user is signed in (or during the sign-in flow for
    // brand-new guest-only users).
    if (isEmailEnabled()) {
      const url = `${APP_URL()}/#joint-invite?t=${encodeURIComponent(raw)}`;
      const ownerName = req.user.name || req.user.email || "someone";
      const html = `
        <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
          <h2 style="margin:0 0 12px 0;color:#8b5cf6;">You've been invited to a Coinvane account</h2>
          <p><strong>${escapeHtml(ownerName)}</strong> has shared their Coinvane instance with you as a <strong>${escapeHtml(permissions)}</strong>.</p>
          <p><a href="${url}" style="display:inline-block;background:#8b5cf6;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Accept invitation</a></p>
          <p style="color:#64748b;font-size:12px;">Link expires in 7 days. If you didn't expect this, ignore this email.</p>
        </div>`;
      const text = `${ownerName} has shared their Coinvane instance with you as a ${permissions}.\n\nAccept: ${url}\n\nLink expires in 7 days.`;
      await enqueueMail({
        to: email,
        subject: `${ownerName} invited you to their Coinvane`,
        html, text,
      });
    }

    await audit(req.actorId, "joint.invite", req, { email, permissions, invitation_id: r.insertId });
    return { ok: true, invitation_id: r.insertId, email_sent: isEmailEnabled() };
  });

  // ── Update permissions on an existing share ─────────────────────
  app.patch("/shares/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
    assertContextOwner(req);
    const shareId = Number(req.params.id);
    const permissions = String(req.body?.permissions || "").toLowerCase();
    if (!VALID_PERMISSIONS.has(permissions)) {
      return reply.code(400).send({ error: "permissions must be 'viewer' or 'editor'" });
    }
    const r = await query(
      `UPDATE joint_shares SET permissions = ?
        WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
      [permissions, shareId, req.actorId]
    );
    if (r.affectedRows === 0) return reply.code(404).send({ error: "Share not found" });
    await audit(req.actorId, "joint.permissions_changed", req, { share_id: shareId, permissions });
    return { ok: true };
  });

  // ── Revoke an active share ──────────────────────────────────────
  app.delete("/shares/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
    assertContextOwner(req);
    const shareId = Number(req.params.id);
    const r = await query(
      `UPDATE joint_shares SET revoked_at = NOW()
        WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
      [shareId, req.actorId]
    );
    if (r.affectedRows === 0) return reply.code(404).send({ error: "Share not found" });
    await audit(req.actorId, "joint.revoke_share", req, { share_id: shareId });
    return { ok: true };
  });

  // ── Revoke a pending invitation ────────────────────────────────
  app.delete("/invitations/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
    assertContextOwner(req);
    const invId = Number(req.params.id);
    const r = await query(
      `UPDATE joint_invitations SET revoked_at = NOW()
        WHERE id = ? AND owner_user_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
      [invId, req.actorId]
    );
    if (r.affectedRows === 0) return reply.code(404).send({ error: "Invitation not found" });
    await audit(req.actorId, "joint.revoke_invitation", req, { invitation_id: invId });
    return { ok: true };
  });

  // ── Accept an invitation (called by the signed-in guest) ────────
  // If the actor's email doesn't match the invitation's invitee
  // email, we reject — invitations are per-email. On success we
  // create a joint_shares row and stamp the invitation accepted.
  app.post("/accept", {
    preHandler: [app.authenticate],
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const token = String(req.body?.token || "");
    if (!token) return reply.code(400).send({ error: "token required" });
    const inv = await findInvitationByToken(token);
    if (!inv) return reply.code(410).send({ error: "This invitation is invalid or has expired." });
    if (String(inv.invitee_email).toLowerCase() !== String(req.user.email).toLowerCase()) {
      return reply.code(403).send({ error: "This invitation was addressed to a different email." });
    }
    // Idempotent share creation.
    await query(
      `INSERT INTO joint_shares (owner_user_id, guest_user_id, permissions)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE permissions = VALUES(permissions), revoked_at = NULL`,
      [inv.owner_user_id, req.actorId, inv.permissions]
    );
    await query(`UPDATE joint_invitations SET accepted_at = NOW() WHERE id = ?`, [inv.id]);
    await audit(req.actorId, "joint.accept", req, { invitation_id: inv.id, owner_user_id: inv.owner_user_id });
    await jointAudit(inv.owner_user_id, req.actorId, "joint.accepted", "invitation", inv.id, {
      email: req.user.email,
    });
    return { ok: true, owner_user_id: inv.owner_user_id };
  });

  // ── List every context the signed-in user can view ──────────────
  // Feeds the header dropdown. Always includes the actor's own
  // context UNLESS they're a guest-only user.
  app.get("/contexts", { preHandler: [app.authenticate] }, async (req) => {
    const shares = await listActiveSharesForGuest(req.actorId);
    const contexts = [];
    if (!req.isGuestOnly) {
      contexts.push({
        user_id: req.actorId,
        role: "owner",
        label: "My data",
        email: req.user.email,
        name: req.user.name || null,
      });
    }
    for (const s of shares) {
      contexts.push({
        user_id: s.owner_user_id,
        role: s.permissions === "viewer" ? "viewer" : "editor",
        label: s.owner_name || s.owner_email,
        email: s.owner_email,
        name: s.owner_name,
        picture: s.owner_picture,
      });
    }
    return { contexts };
  });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
