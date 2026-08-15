// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Coinvane Service Worker — the ONLY reason this file exists is Web
// Push. It does not implement offline caching, background sync, or
// asset precaching, deliberately: the app's global no-cache HTTP
// policy would fight a caching SW, and offline PFM has no meaningful
// use case anyway (Plaid/backend are always required).
//
// The SW is registered from main.jsx on startup. On upgrade, we skip
// the waiting phase so the fresh handler code takes effect immediately
// after a deploy — matches the no-cache posture of the rest of the app.
//
// SW_VERSION: bumping this comment changes the file bytes, which is
// what triggers WebKit / Blink to notice the SW has updated on next
// navigation. Bump when materially changing push/notification handling.
//   v3 — 2026-08-15: badge set first + awaited; error reporting to
//                    open clients for iOS diagnostics.

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// SW-side diagnostics. postMessage reaches any open client. But push
// events fire when the app is CLOSED — no clients to receive — so we
// also persist to the Cache API. The client reads that cache entry on
// next mount and surfaces it in Settings. This is the only way to
// see what iOS is doing in the SW without a Mac + Web Inspector.
const DIAG_CACHE = "coinvane-diag-v1";
const DIAG_URL   = "https://sw.coinvane.local/last-badge-event.json";
async function recordDiag(payload) {
  const body = JSON.stringify({ __coinvaneSW: true, at: Date.now(), ...payload });
  try {
    const wins = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
    for (const w of wins) w.postMessage(JSON.parse(body));
  } catch { /* fall through to cache write */ }
  try {
    const cache = await caches.open(DIAG_CACHE);
    await cache.put(new Request(DIAG_URL), new Response(body, {
      headers: { "Content-Type": "application/json" },
    }));
  } catch { /* nothing else to do */ }
}

// The push event fires when the browser's push service delivers an
// encrypted payload for this origin. The payload is opaque to us —
// showNotification is what actually surfaces the OS-level banner.
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let data = {};
    try {
      data = event.data ? event.data.json() : {};
    } catch {
      data = { title: "Coinvane", body: (event.data && event.data.text && event.data.text()) || "" };
    }

    // ── Badge FIRST, awaited. iOS is picky about ordering — if we
    //    kick off showNotification concurrently, WebKit sometimes
    //    ignores the badge call entirely. Setting it first and
    //    awaiting guarantees the badge is committed before the
    //    notification banner grabs the SW's attention.
    //
    //    setAppBadge is only defined on browsers that support the
    //    Badging API — Android Chrome, iOS 16.4+ Safari (installed
    //    PWA only), macOS/Windows/ChromeOS installed apps. Elsewhere
    //    we silently skip.
    const badgeCount = data.badge;
    if (typeof badgeCount === "number") {
      if ("setAppBadge" in self.navigator) {
        try {
          if (badgeCount > 0) await self.navigator.setAppBadge(badgeCount);
          else                await self.navigator.clearAppBadge();
          await recordDiag({ event: "badge_set", value: badgeCount });
        } catch (e) {
          await recordDiag({ event: "badge_error", value: badgeCount, error: String(e && e.message || e) });
        }
      } else {
        await recordDiag({ event: "badge_unsupported", value: badgeCount });
      }
    }

    // ── Now show the notification.
    await self.registration.showNotification(data.title || "Coinvane", {
      body:  data.body || "",
      icon:  data.icon || "/icon-192.png",
      badge: "/icon-192.png",
      // `tag` collapses same-topic pushes into one on the lock screen
      // (e.g. two budget-usage alerts don't stack — the newer replaces
      // the older). Backend sets it to the notification `type`.
      tag:   data.tag || undefined,
      // Data field survives the notification click and is read by the
      // notificationclick handler to decide where to navigate.
      data:  { url: data.url || "/", ts: data.ts || Date.now() },
      // Renotify with the same tag on subsequent pushes — otherwise the
      // browser silently swaps the payload without alerting again.
      renotify: !!data.tag,
    });
  })());
});

// Notification click → focus an existing tab if the app is already
// open, else open a new one to the payload's `url`. This is what
// makes tapping a lock-screen alert deep-link into the right tab.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification?.data?.url || "/";
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      // Same origin? Focus and navigate.
      try {
        const wu = new URL(w.url);
        const cu = new URL(target, self.location.origin);
        if (wu.origin === cu.origin) {
          await w.focus();
          if (w.url !== cu.href) {
            try { await w.navigate(cu.href); } catch { /* older browsers */ }
          }
          return;
        }
      } catch { /* fall through to open */ }
    }
    await self.clients.openWindow(target);
  })());
});

// Push service occasionally rotates the subscription endpoint. When it
// does, `pushsubscriptionchange` fires — re-subscribe with the same
// applicationServerKey and POST the new subscription so the server
// starts sending to it instead. Best-effort: if any step fails, the
// browser will simply stop receiving until the user re-enables.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    try {
      const oldEndpoint = event.oldSubscription?.endpoint;
      const keyRes = await fetch("/api/auth/push/vapid-public-key");
      const { key } = await keyRes.json();
      if (!key) return;
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
      // We can't send an auth header from an unauth'd context — the
      // client's next foreground fetch is what re-registers cleanly.
      // But we CAN tell the server to invalidate the old row so it
      // doesn't keep hammering a 410. Silent-fail if unauth'd.
      if (oldEndpoint) {
        try {
          await fetch(`/api/auth/me/push-subscriptions?endpoint=${encodeURIComponent(oldEndpoint)}`,
            { method: "DELETE" });
        } catch { /* ok */ }
      }
      // Re-POST — will 401 without a session, that's expected. The
      // frontend will re-enroll on next visit via ensurePushSubscribed().
      try {
        await fetch("/api/auth/me/push-subscriptions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sub.toJSON()),
        });
      } catch { /* ok */ }
    } catch { /* ok */ }
  })());
});

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
