// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Microsoft ID-token verifier (multi-tenant + personal MSA accounts).
//
// Mirrors what google-auth-library does for Google — fetch the signing
// keys (JWKS), verify the RS256 signature, check issuer + audience +
// expiry. We don't take a new dep for this: node's crypto module can
// import a JWK directly (Node 15+), and jsonwebtoken is already in the
// tree (used for our own session JWTs).
//
// Trust model:
//   The Entra app is registered as "any organizational directory + personal
//   Microsoft accounts", so the ID token's issuer can be any Microsoft
//   tenant's `/v2.0` endpoint. What actually keeps a random-tenant token
//   from signing anyone in on this server is the aud check — the token
//   must have been minted for THIS server's client id. The allowlist
//   (ALLOWED_EMAILS) is the second gate: even if someone had a valid
//   MSA-issued token addressed to our client id, they still need to be
//   on the allowlist to actually pass /auth/microsoft. Belt + suspenders.
//
//   Issuer is validated by shape (must be login.microsoftonline.com and
//   end in /v2.0) plus a self-consistency check that the tenant GUID in
//   `iss` matches the `tid` claim inside the token. That combination
//   makes it impossible to forge iss/tid independently.
import cryptoNode from "node:crypto";
import jwt from "jsonwebtoken";

// JWKS for the multi-tenant + personal endpoint. `common` returns keys
// that sign tokens from any Microsoft tenant AND from the MSA-consumers
// tenant. Same set of keys signs everything Microsoft issues via v2.0
// regardless of what tenant scope our registration is set to, so we
// always fetch from `common` — the tenant-scope policy check happens
// downstream against the payload's `tid` claim.
const JWKS_URL = "https://login.microsoftonline.com/common/discovery/v2.0/keys";
// Regex for issuer validation. Must be login.microsoftonline.com, a
// tenant GUID (hex-with-dashes), and the /v2.0 suffix. `sts.windows.net`
// (the v1.0 endpoint) is deliberately NOT accepted — MSAL 3.x is a v2.0-
// only library, so anything from v1.0 is either a misconfigured client
// or an attacker feeding us a stale token.
const ISSUER_RE = /^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0$/i;

// The fixed tenant GUID for personal Microsoft accounts (MSA). Used
// by the tenant-scope policy check when the operator restricts to
// `consumers` or explicitly excludes personal accounts via
// `organizations`.
export const MSA_TENANT_GUID = "9188040d-6c67-4c5b-b112-36a304b66dad";

// JWKS is cached for an hour. Microsoft rotates rarely; on a kid miss
// we force-refresh once before giving up. This keeps steady-state
// verification synchronous-ish (one HTTPS call every ~hour) and still
// tolerates a mid-flight rotation.
let jwksCache = null;
let jwksExpiresAt = 0;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function fetchJwks() {
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`Microsoft JWKS fetch failed: ${res.status}`);
  const body = await res.json();
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  if (keys.length === 0) throw new Error("Microsoft JWKS empty");
  jwksCache = keys;
  jwksExpiresAt = Date.now() + JWKS_TTL_MS;
  return keys;
}

async function getKeys(force = false) {
  if (!force && jwksCache && Date.now() < jwksExpiresAt) return jwksCache;
  return await fetchJwks();
}

function jwkToPem(jwk) {
  // Node's KeyObject can import a JWK straight from an object literal.
  // Exporting to SPKI PEM gives us a value jsonwebtoken.verify accepts.
  return cryptoNode
    .createPublicKey({ key: jwk, format: "jwk" })
    .export({ type: "spki", format: "pem" });
}

/**
 * Verify a Microsoft ID token issued to a personal (MSA) account.
 * @param {string} idToken   raw ID token from MSAL.loginPopup()
 * @param {string} audience  the Entra Application (client) ID
 * @returns {Promise<object>} decoded JWT payload on success; throws on failure
 */
export async function verifyMicrosoftIdToken(idToken, audience) {
  if (!idToken || typeof idToken !== "string") throw new Error("id_token required");
  if (!audience) throw new Error("audience required");

  const decoded = jwt.decode(idToken, { complete: true });
  const kid = decoded?.header?.kid;
  if (!kid) throw new Error("Malformed ID token");

  let keys = await getKeys();
  let jwk = keys.find(k => k.kid === kid);
  if (!jwk) {
    // Signing key rotation: force-refetch once before giving up.
    keys = await getKeys(true);
    jwk = keys.find(k => k.kid === kid);
  }
  if (!jwk) throw new Error("Unknown signing key");

  const pem = jwkToPem(jwk);
  // jsonwebtoken.verify covers: signature, exp, nbf, iat, aud. Issuer
  // is passed as a callable-shape check via the manual iss validation
  // below (we can't pass `issuer` here because our registration is
  // multi-tenant — the issuer varies per user).
  const payload = jwt.verify(idToken, pem, {
    algorithms: ["RS256"],
    audience,
  });

  // ── Issuer shape check + tid self-consistency ─────────────────────
  // The token could come from any Microsoft tenant (multi-tenant app).
  // Validate:
  //   1. iss is a login.microsoftonline.com/{guid}/v2.0 URL
  //   2. the guid inside iss equals the `tid` claim
  // Both together stop an attacker from stuffing an arbitrary iss
  // string into a forged token — the JWKS signature check upstream
  // is what makes iss/tid trustworthy in the first place.
  const iss = String(payload.iss || "");
  const m = ISSUER_RE.exec(iss);
  if (!m) throw new Error(`Untrusted issuer: ${iss}`);
  const issuerTenant = m[1].toLowerCase();
  const tid = String(payload.tid || "").toLowerCase();
  if (!tid || tid !== issuerTenant) {
    throw new Error(`Issuer/tid mismatch: iss tenant=${issuerTenant} tid=${tid}`);
  }

  return payload;
}

/**
 * Enforce the operator's tenant-scope policy against a verified token
 * payload. Returns null on pass, or an error message string on reject.
 *
 * Valid `tenantPolicy` values:
 *   "common"       — any Microsoft tenant OR personal MSA (default)
 *   "consumers"    — personal MSA accounts only
 *   "organizations"— any Entra work/school tenant, NO personal MSA
 *   <36-char guid> — that specific Entra tenant only
 *
 * Case-insensitive on the guid comparison.
 */
export function checkMicrosoftTenantPolicy(payload, tenantPolicy) {
  const policy = String(tenantPolicy || "common").toLowerCase();
  const tid = String(payload?.tid || "").toLowerCase();
  if (!tid) return "Token missing tid claim";
  if (policy === "common") return null;
  if (policy === "consumers") {
    return tid === MSA_TENANT_GUID
      ? null
      : "This instance only accepts personal Microsoft accounts";
  }
  if (policy === "organizations") {
    return tid !== MSA_TENANT_GUID
      ? null
      : "This instance only accepts work or school accounts";
  }
  if (/^[0-9a-f-]{36}$/i.test(policy)) {
    return tid === policy
      ? null
      : "This instance only accepts accounts from a specific Microsoft tenant";
  }
  return `Invalid MICROSOFT_TENANT value: ${tenantPolicy}`;
}
