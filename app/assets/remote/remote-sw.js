// Network-only PWA worker. Never cache or intercept APIs, POSTs, credentials,
// conversations or commands. No background sync, replay, or forced page reload.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', event => {
	const request = event.request
	const url = new URL(request.url)
	if (
		request.method !== 'GET' ||
		request.mode !== 'navigate' ||
		url.origin !== self.location.origin ||
		url.pathname !== '/'
	)
		return
	event.respondWith(
		fetch(request).catch(
			() =>
				new Response(OFFLINE, {
					status: 503,
					headers: {
						'Content-Type': 'text/html; charset=utf-8',
						'Cache-Control': 'no-store',
						'Content-Security-Policy':
							"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
					},
				}),
		),
	)
})
// Static copy and Helm palette only. This document never contains runtime/private data.
const OFFLINE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark"><title>Helm Remote unavailable</title><style>:root{--pane:#141517;--text-0:#ececee;--text-1:#9a9ea6;--accent:#4c9aff}body{margin:0;padding:48px 24px;background:var(--pane);color:var(--text-0);font:16px/1.6 -apple-system,BlinkMacSystemFont,sans-serif}main{max-width:480px;margin:auto}h1{font-size:24px}p{color:var(--text-1)}a{display:inline-flex;align-items:center;min-height:44px;color:var(--accent)}</style><main><h1>Helm Remote unavailable</h1><p>Reconnect to your Mac through Tailscale. Conversations and commands aren’t stored offline.</p><a href="/">Try again</a></main></html>`
