// omp collab dashboard service worker: shows Web Push notifications and opens what they are about on click.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
	let data = {};
	try {
		data = event.data ? event.data.json() : {};
	} catch {
		data = { title: "omp collab", body: event.data ? event.data.text() : "" };
	}
	event.waitUntil(
		self.registration.showNotification(data.title || "omp collab", {
			body: data.body || "",
			tag: data.tag,
			renotify: Boolean(data.tag),
			icon: "/icon.svg",
			badge: "/icon.svg",
			data: { url: data.url || "/", id: data.id || null, kind: data.kind || null },
		}),
	);
});

self.addEventListener("notificationclick", event => {
	event.notification.close();
	const { url = "/", id = null, kind = null } = event.notification.data || {};
	event.waitUntil(
		(async () => {
			// A pending plan is reviewed in the dashboard: reuse an open one instead of stacking windows.
			if (id && kind === "plan") {
				const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
				const dashboard = windows.find(w => {
					const u = new URL(w.url);
					return u.origin === self.location.origin && u.pathname === "/";
				});
				if (dashboard) {
					await dashboard.focus();
					dashboard.postMessage({ type: "open-notification", id });
					return;
				}
			}
			// `/n/<id>` redirects to the session itself, or to the dashboard when that is the right place.
			await self.clients.openWindow(new URL(url, self.location.origin).href);
		})(),
	);
});
