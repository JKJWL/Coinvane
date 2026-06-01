// SPDX-License-Identifier: AGPL-3.0-or-later
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { plaid } from "./plaid-client.js";

const keyCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function getVerificationKey(kid) {
  const cached = keyCache.get(kid);
  if (cached && cached.expires > Date.now()) return cached.key;
  const resp = await plaid.webhookVerificationKeyGet({ key_id: kid });
  const key = resp.data.key;
  keyCache.set(kid, { key, expires: Date.now() + CACHE_TTL_MS });
  return key;
}

function jwkToPem(jwk) {
  return crypto.createPublicKey({ key: jwk, format: "jwk" })
    .export({ type: "spki", format: "pem" });
}

export async function verifyPlaidWebhook(headerToken, rawBody) {
  if (!headerToken) throw new Error("Missing Plaid-Verification header");
  const decoded = jwt.decode(headerToken, { complete: true });
  if (!decoded || decoded.header.alg !== "ES256") {
    throw new Error("Invalid webhook JWT");
  }
  const jwk = await getVerificationKey(decoded.header.kid);
  const pem = jwkToPem(jwk);

  const claims = jwt.verify(headerToken, pem, { algorithms: ["ES256"] });

  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  if (claims.request_body_sha256 !== bodyHash) {
    throw new Error("Webhook body hash mismatch");
  }
  if (Date.now() / 1000 - claims.iat > 300) {
    throw new Error("Webhook token expired");
  }
  return true;
}