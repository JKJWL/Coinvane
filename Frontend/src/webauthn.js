// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WebAuthn helpers for the biometric app-lock. Wraps @simplewebauthn/
// browser's `startRegistration` + `startAuthentication` so the settings
// toggle and the LockScreen share the same code paths.
//
// This ISN'T a login replacement — Google SSO stays. It gates the
// app's front-end display after a session is already valid, and only
// on mobile. Desktop calls to enable/lock are no-ops (frontend hides
// the surface, but if the endpoint somehow gets called it'll succeed
// harmlessly on desktop platforms too).
import { startRegistration, startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { api } from "./api/client.js";

// Rough human-readable device label from the current UA. Server stores
// this so the manage-devices list is legible ("Safari on iPhone" beats
// a raw UA blob).
function guessDeviceName() {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  let os = "Device";
  if (/iPhone/.test(ua)) os = "iPhone";
  else if (/iPad/.test(ua)) os = "iPad";
  else if (/Android/.test(ua)) os = "Android";
  else if (/Macintosh|Mac OS/.test(ua)) os = "Mac";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/Linux/.test(ua)) os = "Linux";
  let browser = "Browser";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/CriOS|Chrome\//.test(ua)) browser = "Chrome";
  else if (/FxiOS|Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua)) browser = "Safari";
  return `${browser} on ${os}`;
}

export function webauthnSupported() {
  return typeof window !== "undefined" && browserSupportsWebAuthn();
}

/**
 * Enroll this device. Triggers the OS FaceID/TouchID/Windows Hello
 * prompt via startRegistration, then hands the attestation to the
 * server. On success the server flips biometric_lock_enabled=true.
 * Returns { ok: true } or { ok: false, reason }.
 */
export async function enrollBiometric() {
  if (!webauthnSupported()) return { ok: false, reason: "unsupported" };
  try {
    const { options, challengeToken } = await api.webauthnRegisterOptions();
    let attestation;
    try {
      attestation = await startRegistration({ optionsJSON: options });
    } catch (e) {
      // NotAllowedError = user cancelled or denied the OS prompt; treat
      // as a graceful decline, not a failure worth toasting hard.
      if (e?.name === "NotAllowedError") return { ok: false, reason: "denied" };
      throw e;
    }
    await api.webauthnRegister({
      challengeToken,
      response: attestation,
      device_name: guessDeviceName(),
    });
    return { ok: true };
  } catch (e) {
    console.warn("[webauthn] enroll failed:", e);
    return { ok: false, reason: e?.message || "error" };
  }
}

/**
 * Try to unlock. Server issues a challenge, browser prompts biometric,
 * server verifies signature. Returns { ok: true } / { ok: false, reason }.
 */
export async function unlockBiometric() {
  if (!webauthnSupported()) return { ok: false, reason: "unsupported" };
  try {
    const { options, challengeToken } = await api.webauthnAuthOptions();
    let assertion;
    try {
      assertion = await startAuthentication({ optionsJSON: options });
    } catch (e) {
      if (e?.name === "NotAllowedError") return { ok: false, reason: "denied" };
      throw e;
    }
    await api.webauthnVerify({ challengeToken, response: assertion });
    return { ok: true };
  } catch (e) {
    console.warn("[webauthn] unlock failed:", e);
    return { ok: false, reason: e?.message || "error" };
  }
}
