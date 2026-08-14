// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WebAuthn helper — wraps @simplewebauthn/server for Coinvane's
// biometric app-lock feature. Two ceremonies: register (enrolls a new
// device via FaceID/TouchID) and authenticate (unlocks an existing
// session on next app open).
//
// Challenges are round-tripped inside a short-lived JWT so we don't
// need a challenges table. The token carries { challenge, userId, type,
// exp }, signed with the app's JWT_SECRET. Client passes it back
// verbatim; server decodes + uses the embedded challenge as the
// expectedChallenge for verification.
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import jwt from "jsonwebtoken";
import { query, queryOne } from "./db.js";

const CHALLENGE_TTL_SEC = 5 * 60; // 5 minutes

/**
 * Derive the WebAuthn Relying Party ID + expected origin from the request.
 * RP-ID must be the effective domain (host without port); origin is the
 * full https://host. Falls back to APP_URL when Origin header is missing
 * (rare — same-origin browser requests always send it).
 */
function rpFromReq(req) {
  const origin = req.headers.origin || process.env.APP_URL || "";
  try {
    const u = new URL(origin);
    return { rpID: u.hostname, expectedOrigin: `${u.protocol}//${u.host}` };
  } catch {
    return { rpID: "localhost", expectedOrigin: "http://localhost" };
  }
}

function packChallenge(userId, type, challenge) {
  return jwt.sign(
    { userId, type, challenge },
    process.env.JWT_SECRET,
    { expiresIn: CHALLENGE_TTL_SEC }
  );
}

function unpackChallenge(token, userId, expectedType) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.userId !== userId) throw new Error("wrong user");
    if (decoded.type !== expectedType) throw new Error("wrong ceremony");
    return decoded.challenge;
  } catch (e) {
    const err = new Error("Challenge expired or invalid — start over");
    err.expose = true;
    throw err;
  }
}

/** Registration — generate a challenge for the browser to sign. */
export async function makeRegistrationOptions(req) {
  const userId = req.user.id;
  const user = await queryOne("SELECT id, email, name FROM users WHERE id = ?", [userId]);
  if (!user) throw new Error("user not found");
  const { rpID } = rpFromReq(req);

  // Existing credentials → excludeCredentials so the user can't re-enroll
  // the same device by mistake. Frontend UX offers "add another device."
  const rows = await query(
    "SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?",
    [userId]
  );

  const options = await generateRegistrationOptions({
    rpName: "Coinvane",
    rpID,
    // WebAuthn's userID must be an opaque byte string; the numeric id is
    // stable + already unique per user, so we serialize it directly.
    userID: new TextEncoder().encode(String(user.id)),
    userName: user.email,
    userDisplayName: user.name || user.email,
    attestationType: "none",
    authenticatorSelection: {
      // Platform authenticator = built-in FaceID / TouchID / Windows
      // Hello. We deliberately do NOT accept cross-platform (roaming
      // security keys) — this is an app-lock, not an SSO replacement.
      authenticatorAttachment: "platform",
      userVerification: "required",
      residentKey: "preferred",
    },
    excludeCredentials: rows.map((r) => ({
      id: Buffer.from(r.credential_id).toString("base64url"),
      type: "public-key",
      transports: r.transports ? r.transports.split(",") : undefined,
    })),
  });

  const challengeToken = packChallenge(userId, "register", options.challenge);
  return { options, challengeToken };
}

/** Registration — verify the attestation the browser sent back. */
export async function completeRegistration(req, body) {
  const userId = req.user.id;
  const { rpID, expectedOrigin } = rpFromReq(req);
  const expectedChallenge = unpackChallenge(body.challengeToken, userId, "register");

  const verification = await verifyRegistrationResponse({
    response: body.response,
    expectedChallenge,
    expectedOrigin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) {
    const err = new Error("Registration verification failed");
    err.expose = true;
    throw err;
  }

  // @simplewebauthn/server v11 nests the credential under
  // `registrationInfo.credential` — id/publicKey/counter are on there.
  const cred = verification.registrationInfo.credential;
  const credentialId = Buffer.from(cred.id, "base64url"); // stored as bytes
  const publicKey = Buffer.from(cred.publicKey); // Uint8Array → Buffer
  const counter = cred.counter || 0;
  const transports = (body.response?.response?.transports || []).join(",").slice(0, 128);

  // Device name is best-effort — the client can pass a friendly label
  // captured from userAgent; if missing we store null and the UI shows
  // "Unknown device".
  const deviceName = (body.device_name || "").slice(0, 128) || null;

  await query(
    `INSERT INTO webauthn_credentials
       (user_id, credential_id, public_key, counter, transports, device_name)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       public_key = VALUES(public_key),
       counter = VALUES(counter),
       transports = VALUES(transports),
       device_name = VALUES(device_name)`,
    [userId, credentialId, publicKey, counter, transports || null, deviceName]
  );

  // Enrollment implicitly enables the app-lock. Turning it off later
  // is a separate settings toggle so the credential row can survive.
  await query(
    "UPDATE users SET biometric_lock_enabled = 1 WHERE id = ?",
    [userId]
  );

  return { ok: true };
}

/** Authentication — generate a challenge for unlock. */
export async function makeAuthenticationOptions(req) {
  const userId = req.user.id;
  const { rpID } = rpFromReq(req);
  const rows = await query(
    "SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?",
    [userId]
  );
  if (!rows.length) {
    const err = new Error("No enrolled devices");
    err.expose = true;
    throw err;
  }
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    allowCredentials: rows.map((r) => ({
      id: Buffer.from(r.credential_id).toString("base64url"),
      type: "public-key",
      transports: r.transports ? r.transports.split(",") : undefined,
    })),
  });
  const challengeToken = packChallenge(userId, "auth", options.challenge);
  return { options, challengeToken };
}

/** Authentication — verify the assertion. */
export async function completeAuthentication(req, body) {
  const userId = req.user.id;
  const { rpID, expectedOrigin } = rpFromReq(req);
  const expectedChallenge = unpackChallenge(body.challengeToken, userId, "auth");

  // The response's rawId identifies which of the user's credentials was
  // used. Fetch that specific row so verifyAuthenticationResponse can
  // check the signature against the right public key.
  const rawIdB64 = body.response?.rawId;
  if (!rawIdB64) {
    const err = new Error("Malformed response");
    err.expose = true;
    throw err;
  }
  const rawIdBuf = Buffer.from(rawIdB64, "base64url");
  const row = await queryOne(
    "SELECT id, credential_id, public_key, counter FROM webauthn_credentials WHERE user_id = ? AND credential_id = ?",
    [userId, rawIdBuf]
  );
  if (!row) {
    const err = new Error("Unknown credential");
    err.expose = true;
    throw err;
  }

  const verification = await verifyAuthenticationResponse({
    response: body.response,
    expectedChallenge,
    expectedOrigin,
    expectedRPID: rpID,
    credential: {
      id: Buffer.from(row.credential_id).toString("base64url"),
      publicKey: new Uint8Array(row.public_key),
      counter: Number(row.counter) || 0,
    },
    requireUserVerification: true,
  });
  if (!verification.verified) {
    const err = new Error("Authentication failed");
    err.expose = true;
    throw err;
  }
  // Store the new counter + last-used stamp for replay protection.
  await query(
    `UPDATE webauthn_credentials
       SET counter = ?, last_used_at = NOW()
     WHERE id = ?`,
    [verification.authenticationInfo?.newCounter || 0, row.id]
  );
  return { ok: true };
}
