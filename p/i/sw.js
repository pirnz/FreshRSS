/*!
 * FreshRSS offline reading — service worker.
 * Scope is the directory it is served from (/i/, or the install prefix plus /i/).
 * Precaches only the static offline page and its script. Never caches PHP,
 * AJAX, API or redirected responses.
 * @license GPL-2.0-or-later
 */

const VERSION = '4';

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

const SHELL = [
	'./offline.html',
	'../scripts/offline.js',
	'../scripts/offline-logic.js',
	'../themes/icons/read.svg',
	'../themes/icons/unread.svg',
	'../themes/icons/starred.svg',
	'../themes/icons/non-starred.svg',
];
const ASSET_LIMIT = 80;

function isSameOrigin(url) {
	return url.origin === self.location.origin;
}

/**
 * Public assets the offline page can request. Exact URL, query string included.
 * f.php only serves a favicon for a hex hash; nothing else under that script is cached.
 */
function isCacheableAsset(url) {
	if (!isSameOrigin(url)) {
		return false;
	}
	const scopeDir = new URL('./', self.registration.scope);
	const scriptsDir = new URL('../scripts/', scopeDir);
	const themesDir = new URL('../themes/', scopeDir);
	const faviconScript = new URL('../f.php', scopeDir);
	const path = url.pathname;
	if (path.startsWith(scriptsDir.pathname) || path.startsWith(themesDir.pathname)) {
		return true;
	}
	return path === faviconScript.pathname && /^[0-9a-f]+$/i.test(url.searchParams.get('h') || '');
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
	// Take control before the next navigation, or the first offline reload
	// still hits the browser error page instead of offline.html.
	self.skipWaiting();
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

/**
 * Cache first, so a cached icon never waits on a dead connection.
 * A miss is fetched and stored only when the response is a real, non-redirected 2xx.
 */
function cacheAsset(request) {
	return caches.open(assetCacheName()).then(function (cache) {
		return cache.match(request).then(function (cached) {
			if (cached) {
				return cached;
			}
			return fetch(request, { redirect: 'manual' }).then(function (response) {
				if (response.ok && response.type === 'basic' && !response.redirected) {
					cache.put(request, response.clone()).then(function () {
						return trimAssetCache(cache);
					});
				}
				return response;
			});
		});
	});
}

self.addEventListener('message', function (event) {
	const data = event.data || {};
	if (data.type !== 'freshrss-warm' || !Array.isArray(data.urls)) {
		return;
	}
	const urls = data.urls.filter(function (href) {
		try {
			return isCacheableAsset(new URL(href));
		} catch (e) {
			return false;
		}
	}).slice(0, ASSET_LIMIT);
	event.waitUntil(Promise.all(urls.map(function (href) {
		return cacheAsset(new Request(href)).catch(function () { return undefined; });
	})));
});

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
			// match() resolves undefined on a miss; respondWith then throws a network error.
			return caches.match('./offline.html', { cacheName: shellCacheName() }).then(function (cached) {
				return cached || new Response('Offline page is not cached yet.', {
					status: 503,
					statusText: 'offline',
					headers: { 'Content-Type': 'text/plain; charset=utf-8' },
				});
			});
		}));
		return;
	}

	// Only the offline page's own requests are answered from the cache.
	// The live page stylesheet is not one of them: a worker response for it blanks that page.
	if (isCacheableAsset(url) && event.clientId) {
		event.respondWith(self.clients.get(event.clientId).then(function (client) {
			if (!client || !isOfflineClient(new URL(client.url))) {
				return fetch(request);
			}
			return cacheAsset(request);
		}));
	}
});

/**
 * The static reader only. An authenticated page that happens to sit under /i/ is not it.
 * @param {URL} url
 * @returns {boolean}
 */
function isOfflineClient(url) {
	return url.pathname === new URL('./offline.html', self.registration.scope).pathname;
}
