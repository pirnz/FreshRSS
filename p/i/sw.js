/*!
 * FreshRSS offline reading — service worker.
 * Scope is the directory it is served from (/i/, or the install prefix plus /i/).
 * Precaches only the static offline page and its script. Never caches PHP,
 * AJAX, API or redirected responses.
 * @license GPL-2.0-or-later
 */

const VERSION = '1';

/** Installation-specific prefix, so one origin can host several copies. */
function cachePrefix() {
	return 'freshrss-offline-' + encodeURIComponent(self.registration.scope) + '-';
}

function shellCacheName() {
	return cachePrefix() + 'shell-v' + VERSION;
}

function assetCacheName() {
	return cachePrefix() + 'assets-v' + VERSION;
}

const SHELL = ['./offline.html', '../scripts/offline.js', '../scripts/offline-logic.js'];
const ASSET_LIMIT = 60;

function isSameOrigin(url) {
	return url.origin === self.location.origin;
}

/** Public theme and script assets only. Exact URL, query string included. */
function isCacheableAsset(url) {
	if (!isSameOrigin(url)) {
		return false;
	}
	const scopeDir = new URL('./', self.registration.scope);
	const scriptsDir = new URL('../scripts/', scopeDir);
	const themesDir = new URL('../themes/', scopeDir);
	const path = url.pathname;
	return path.startsWith(scriptsDir.pathname) || path.startsWith(themesDir.pathname);
}

function isArticleNavigation(url) {
	if (!isSameOrigin(url) || !url.pathname.startsWith(new URL('./', self.registration.scope).pathname)) {
		return false;
	}
	const controller = url.searchParams.get('c') || 'index';
	const action = url.searchParams.get('a') || 'index';
	if (controller !== 'index') {
		return false;
	}
	return action === 'index' || action === 'normal';
}

self.addEventListener('install', function (event) {
	event.waitUntil(caches.open(shellCacheName()).then(function (cache) {
		return Promise.all(SHELL.map(function (path) {
			// A redirected response would be a login page. Refuse to cache it.
			return fetch(new URL(path, self.registration.scope), { cache: 'no-store', redirect: 'manual' })
				.then(function (response) {
					if (!response.ok || response.type !== 'basic') {
						throw new Error('offline shell fetch failed: ' + path);
					}
					return cache.put(path, response);
				});
		}));
	}));
});

self.addEventListener('activate', function (event) {
	event.waitUntil(caches.keys().then(function (keys) {
		const prefix = cachePrefix();
		const current = [shellCacheName(), assetCacheName()];
		return Promise.all(keys.map(function (key) {
			if (key.startsWith(prefix) && current.indexOf(key) < 0) {
				return caches.delete(key);
			}
			return undefined;
		}));
	}).then(function () {
		return self.clients.claim();
	}));
});

function trimAssetCache(cache) {
	return cache.keys().then(function (requests) {
		const extra = requests.length - ASSET_LIMIT;
		if (extra <= 0) {
			return undefined;
		}
		return Promise.all(requests.slice(0, extra).map(function (request) {
			return cache.delete(request);
		}));
	});
}

function cacheAsset(request) {
	return caches.open(assetCacheName()).then(function (cache) {
		return cache.match(request).then(function (cached) {
			if (cached) {
				return cached;
			}
			return fetch(request).then(function (response) {
				if (response.ok && response.type === 'basic') {
					cache.put(request, response.clone()).then(function () {
						return trimAssetCache(cache);
					});
				}
				return response;
			});
		});
	});
}

self.addEventListener('fetch', function (event) {
	const request = event.request;
	if (request.method !== 'GET') {
		return;
	}
	let url;
	try {
		url = new URL(request.url);
	} catch (e) {
		return;
	}
	if (!isSameOrigin(url)) {
		return;
	}

	if (request.mode === 'navigate') {
		const offlinePage = new URL('./offline.html', self.registration.scope).pathname;
		if (!isArticleNavigation(url) && url.pathname !== offlinePage) {
			return;
		}
		event.respondWith(fetch(request).catch(function () {
			// Transport failure only. HTTP errors never reach this branch.
			return caches.match('./offline.html', { cacheName: shellCacheName() });
		}));
		return;
	}

	// Shell scripts are precached by the install handler, which must see the
	// network itself. Caching them here would store a response before its status is checked.
	if (SHELL.some(function (path) { return url.pathname === new URL(path, self.registration.scope).pathname; })) {
		return;
	}

	if (isCacheableAsset(url)) {
		event.respondWith(cacheAsset(request));
	}
});
