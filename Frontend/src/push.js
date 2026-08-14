// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Web Push helpers — service-worker registration + enroll/unenroll.
// Kept in a standalone module so the settings toggle and the app-load
// resurrect flow can share the same code paths.
import { api } from "./api/client.js";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported() {
  return typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

// iOS Safari only lets a site subscribe to Web Push AFTER it's been
// installed as a home-screen PWA (iOS 16.4+). Detect the combo so we
// can surface a one-time hint instead of silently failing on iPhone.
export function isIosSafariNotInstalled() {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const iOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  if (!iOS) return false;
  const standalone = window.navigator.standalone === true
    || window.matchMedia?.("(display-mode: standalone)").matches;
  return !standalone;
}

// Register the service worker exactly once per app load. Idempotent —
// browsers already dedupe by scope, so calling it repeatedly is fine.
let registrationPromise = null;
export function registerServiceWorker() {
  if (!pushSupported()) return Promise.resolve(null);
  if (registrationPromise) return registrationPromise;
  registrationPromise = navigator.serviceWorker.register("/sw.js", { scope: "/" })
    .catch((e) => { console.warn("[push] SW register failed:", e); return null; });
  return registrationPromise;
}

/**
 * Ask the browser for notification permission and subscribe.
 * Returns { ok: true } on success, { ok: false, reason } otherwise.
 * Reasons: "unsupported" | "denied" | "no-key" | "ios-install-required" | "error"
 */
export async function enablePush() {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  if (isIosSafariNotInstalled()) return { ok: false, reason: "ios-install-required" };
  const reg = await registerServiceWorker();
  if (!reg) return { ok: false, reason: "error" };
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, reason: "denied" };
  // Fetch the VAPID public key from the backend (server-configured).
  let keyRes;
  try { keyRes = await api.getVapidPublicKey(); }
  catch { return { ok: false, reason: "error" }; }
  if (!keyRes?.key) return { ok: false, reason: "no-key" };
  try {
    // Re-use an existing subscription if the browser already has one
    // for this scope — otherwise browsers throw on double-subscribe.
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyRes.key),
      });
    }
    await api.registerPushSubscription(sub.toJSON());
    return { ok: true };
  } catch (e) {
    console.warn("[push] subscribe failed:", e);
    return { ok: false, reason: "error" };
  }
}

/**
 * Unsubscribe from the browser AND tell the server to forget this
 * endpoint. Called from the settings toggle when the user turns push
 * off. Silent-fail — an already-unsubscribed browser is fine.
 */
export async function disablePush() {
  if (!pushSupported()) return { ok: true };
  try {
    const reg = await registerServiceWorker();
    if (!reg) return { ok: true };
    const sub = await reg.pushManager.getSubscription();
    const endpoint = sub?.endpoint;
    if (sub) await sub.unsubscribe();
    if (endpoint) {
      try { await api.deletePushSubscription(endpoint); } catch { /* ok */ }
    }
    return { ok: true };
  } catch (e) {
    console.warn("[push] unsubscribe failed:", e);
    return { ok: false };
  }
}

/**
 * Called on app load. If the user still has permission granted AND a
 * subscription exists, POST it again so the backend has the current
 * endpoint (rotations, re-installs, another device etc). No-op if
 * permission isn't granted — never triggers the browser prompt.
 */
export async function resurrectPushIfEnabled() {
  if (!pushSupported()) return;
  if (Notification.permission !== "granted") return;
  const reg = await registerServiceWorker();
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  try { await api.registerPushSubscription(sub.toJSON()); }
  catch { /* silent — session probably still initialising */ }
}
