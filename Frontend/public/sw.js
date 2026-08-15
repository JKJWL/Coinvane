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

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// The push event fires when the browser's push service delivers an
// encrypted payload for this origin. The payload is opaque to us —
// showNotification is what actually surfaces the OS-level banner.
// Badge is set first + awaited before showNotification per Apple's
// WWDC guidance — running them concurrently can drop the badge on
// WebKit.
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let data = {};
    try {
      data = event.data ? event.data.json() : {};
    } catch {
      data = { title: "Coinvane", body: (event.data && event.data.text && event.data.text()) || "" };
    }

    // setAppBadge is only defined on browsers that support the Badging
    // API — Android Chrome, iOS 16.4+ Safari (installed PWA only),
    // macOS/Windows/ChromeOS installed apps. Silently skip elsewhere.
    const badgeCount = data.badge;
    if (typeof badgeCount === "number" && "setAppBadge" in self.navigator) {
      try {
        if (badgeCount > 0) await self.navigator.setAppBadge(badgeCount);
        else                await self.navigator.clearAppBadge();
      } catch { /* OS refused — nothing else to do */ }
    }

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
