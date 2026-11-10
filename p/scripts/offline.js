/*!
 * FreshRSS offline reading.
 * On an authenticated page: register the worker, harvest rendered articles, replay the outbox.
 * On the static offline page: render harvested articles and queue read/favourite actions.
 * Depends on p/scripts/offline-logic.js, loaded first.
 * @license GPL-2.0-or-later
 */
(function () {
	'use strict';

	const logic = window.FreshRSS_OfflineLogic;
	if (!logic) {
		return;
	}

	const DB_VERSION = 1;
	const META_DB = 'freshrss-offline-meta';
	const CHANNEL = 'freshrss-offline';

	const state = {
		ready: false,
		db: null,
		username: null,
		partition: null,
		unavailable: false,
	};

	function secureContext() {
		return window.isSecureContext === true;
	}

	function supported() {
		return secureContext() && 'serviceWorker' in navigator && typeof indexedDB !== 'undefined';
	}

	/** Install path up to and including /i/, so two copies on one origin stay apart. */
	function installationKey() {
		const path = window.location.pathname;
		const marker = '/i/';
		const at = path.indexOf(marker);
		return at < 0 ? path : path.slice(0, at + marker.length);
	}

	function partitionName(username) {
		return 'freshrss-offline::' + installationKey() + '::' + username;
	}

	function t(key, fallback) {
		const i18n = window.context && window.context.i18n;
		const value = i18n && i18n[key];
		return typeof value === 'string' && value !== '' ? value : fallback;
	}

	function notify(message, level) {
		if (typeof window.openNotification === 'function') {
			window.openNotification(message, level || 'bad');
			return;
		}
		setStatus(message);
	}

	function banner() {
		let bar = document.getElementById('freshrss-offline-banner');
		if (bar) {
			return bar;
		}
		bar = document.createElement('div');
		bar.id = 'freshrss-offline-banner';
		bar.className = 'freshrss-offline-banner';
		bar.hidden = true;
		const text = document.createElement('span');
		text.className = 'freshrss-offline-banner-text';
		const dismiss = document.createElement('button');
		dismiss.type = 'button';
		dismiss.className = 'freshrss-offline-banner-dismiss';
		dismiss.textContent = '×';
		dismiss.addEventListener('click', function () {
			bar.hidden = true;
			fitBanner(bar);
		});
		bar.appendChild(text);
		bar.appendChild(dismiss);
		(document.body || document.documentElement).prepend(bar);
		return bar;
	}

	/** #global is viewport-tall minus the header. Tell it how tall this banner is.
	 *  Set on both roots: some themes give html its own height, which blocks inheritance. */
	function fitBanner(bar) {
		const roots = [document.documentElement, document.body].filter(Boolean);
		if (!bar || bar.hidden) {
			roots.forEach(function (node) { node.style.removeProperty('--frss-offline-banner-height'); });
			return;
		}
		const height = bar.offsetHeight + 'px';
		roots.forEach(function (node) { node.style.setProperty('--frss-offline-banner-height', height); });
	}

	function showBanner(message) {
		const bar = banner();
		bar.querySelector('.freshrss-offline-banner-text').textContent = message;
		bar.hidden = false;
		fitBanner(bar);
	}

	function watchBannerSize() {
		window.addEventListener('resize', function () {
			fitBanner(document.getElementById('freshrss-offline-banner'));
		});
	}

	function setStatus(message) {
		const node = document.getElementById('offline-status');
		if (node) {
			node.textContent = message;
		} else if (message) {
			showBanner(message);
		}
	}

	function openDatabase(name) {
		return new Promise(function (resolve, reject) {
			const request = indexedDB.open(name, DB_VERSION);
			request.onupgradeneeded = function () {
				const db = request.result;
				if (!db.objectStoreNames.contains('entries')) {
					db.createObjectStore('entries', { keyPath: 'id' });
				}
				if (!db.objectStoreNames.contains('outbox')) {
					db.createObjectStore('outbox', { keyPath: 'key' });
				}
				if (!db.objectStoreNames.contains('meta')) {
					db.createObjectStore('meta');
				}
			};
			request.onsuccess = function () { resolve(request.result); };
			request.onerror = function () { reject(request.error); };
		});
	}

	function requestToPromise(request) {
		return new Promise(function (resolve, reject) {
			request.onsuccess = function () { resolve(request.result); };
			request.onerror = function () { reject(request.error); };
		});
	}

	function txDone(tx) {
		return new Promise(function (resolve, reject) {
			tx.oncomplete = function () { resolve(); };
			tx.onabort = function () { reject(tx.error); };
			tx.onerror = function () { reject(tx.error); };
		});
	}

	function storeGet(storeName, key) {
		const tx = state.db.transaction(storeName, 'readonly');
		return requestToPromise(tx.objectStore(storeName).get(key));
	}

	function storeGetAll(storeName) {
		const tx = state.db.transaction(storeName, 'readonly');
		return requestToPromise(tx.objectStore(storeName).getAll());
	}

	function storePut(storeName, value, key) {
		const tx = state.db.transaction(storeName, 'readwrite');
		tx.objectStore(storeName).put(value, key);
		return txDone(tx);
	}

	function storeDelete(storeName, key) {
		const tx = state.db.transaction(storeName, 'readwrite');
		tx.objectStore(storeName).delete(key);
		return txDone(tx);
	}

	function metaGet(key) {
		return openDatabase(META_DB).then(function (db) {
			const tx = db.transaction('meta', 'readonly');
			return requestToPromise(tx.objectStore('meta').get(installationKey() + ':' + key)).finally(function () {
				db.close();
			});
		});
	}

	function metaSet(key, value) {
		return openDatabase(META_DB).then(function (db) {
			const tx = db.transaction('meta', 'readwrite');
			tx.objectStore('meta').put(value, installationKey() + ':' + key);
			return txDone(tx).finally(function () { db.close(); });
		});
	}

	function failClosed(error) {
		state.unavailable = true;
		console.error('FreshRSS offline storage unavailable', error);
		notify(t('offline_unavailable', 'Offline reading is unavailable in this browser. Actions were not saved.'), 'bad');
	}

	function stripTransient(node) {
		node.classList.remove('current', 'active');
		node.querySelectorAll('.spinner').forEach(function (icon) {
			icon.classList.remove('spinner');
		});
		return node;
	}

	function textOf(node) {
		return node ? node.textContent.replace(/\s+/g, ' ').trim() : '';
	}

	/**
	 * Keep only what the generated offline list needs. The saved HTML is a fallback
	 * for copies captured before these fields existed; new captures do not store it.
	 */
	function entryFromFlux(div) {
		const id = div.getAttribute('data-entry') || div.id.replace(/^flux_/, '');
		if (!/^\d+$/.test(id)) {
			return null;
		}
		const clone = stripTransient(div.cloneNode(true));
		const time = clone.querySelector('time[datetime]');
		const date = time ? Date.parse(time.getAttribute('datetime')) : NaN;
		const favicon = clone.querySelector('.flux_header img.favicon');
		const text = clone.querySelector('.flux_content .content .text');
		if (text) {
			text.querySelectorAll('img, video, audio, picture, source, iframe, object, embed').forEach(function (media) {
				media.remove();
			});
		}
		return {
			id: id,
			feed_id: parseInt(div.getAttribute('data-feed'), 10) || 0,
			is_read: !div.classList.contains('not_read'),
			is_favorite: div.classList.contains('favorite'),
			captured: Number.isNaN(date) ? Date.now() : date,
			title: textOf(clone.querySelector('.flux_header a.title')) || textOf(clone.querySelector('h1.title')),
			feed_name: (clone.querySelector('.flux_header') || clone).getAttribute('data-website-name') ||
				textOf(clone.querySelector('.flux_header .websiteName')),
			favicon: favicon ? favicon.getAttribute('src') : '',
			link: div.getAttribute('data-link') || '',
			date_label: textOf(time),
			content: text ? text.innerHTML : '',
		};
	}

	function harvest(root) {
		if (!state.ready || state.username === null) {
			return Promise.resolve();
		}
		const nodes = (root || document).querySelectorAll('.flux[data-entry]');
		const incoming = [];
		nodes.forEach(function (div) {
			const entry = entryFromFlux(div);
			if (entry) {
				incoming.push(entry);
			}
		});
		if (incoming.length === 0) {
			return Promise.resolve();
		}
		return storeGetAll('outbox').then(function (outbox) {
			const pending = {};
			outbox.forEach(function (item) { pending[item.key] = item; });
			const tx = state.db.transaction('entries', 'readwrite');
			const store = tx.objectStore('entries');
			incoming.forEach(function (entry) {
				store.put(logic.mergePending(entry, pending['read:' + entry.id], pending['favorite:' + entry.id]));
			});
			return txDone(tx);
		}).then(pruneEntries).then(warmIcons).catch(failClosed);
	}

	function pruneEntries() {
		return Promise.all([storeGetAll('entries'), storeGetAll('outbox')]).then(function (result) {
			const pendingIds = new Set(result[1].map(function (item) { return String(item.entryId); }));
			const drop = logic.prune(result[0], pendingIds);
			if (drop.length === 0) {
				return undefined;
			}
			const tx = state.db.transaction('entries', 'readwrite');
			const store = tx.objectStore('entries');
			drop.forEach(function (id) { store.delete(id); });
			return txDone(tx);
		});
	}

	/**
	 * Queue the absolute target before the caller treats the action as done.
	 * @returns {Promise<boolean>} false when the write did not land
	 */
	function queue(action, entryId, target) {
		if (!state.ready) {
			notify(t('offline_unavailable', 'Offline reading is unavailable in this browser. Actions were not saved.'), 'bad');
			return Promise.resolve(false);
		}
		const key = action + ':' + entryId;
		return storeGet('outbox', key).then(function (existing) {
			return storePut('outbox', logic.coalesce(existing, action, entryId, target, Date.now()));
		}).then(function () {
			return storeGet('entries', String(entryId));
		}).then(function (entry) {
			if (!entry) {
				return true;
			}
			if (action === 'read') {
				entry.is_read = !!target;
			} else {
				entry.is_favorite = !!target;
			}
			return storePut('entries', entry).then(function () { return true; });
		}).catch(function (error) {
			failClosed(error);
			return false;
		});
	}

	function applySnapshot(div, action, target) {
		if (action === 'read') {
			div.classList.toggle('not_read', !target);
		} else {
			div.classList.toggle('favorite', target);
		}
	}

	function broadcast(type) {
		if (typeof BroadcastChannel !== 'function') {
			return;
		}
		try {
			const channel = new BroadcastChannel(CHANNEL);
			channel.postMessage({ type: type, installation: installationKey(), username: state.username });
			channel.close();
		} catch (e) { /* a missing channel must not break logout */ }
	}

	function clearPartition() {
		const name = state.partition;
		if (state.db) {
			state.db.close();
			state.db = null;
		}
		state.ready = false;
		return new Promise(function (resolve) {
			if (!name) {
				resolve();
				return;
			}
			const request = indexedDB.deleteDatabase(name);
			request.onsuccess = function () { resolve(); };
			request.onerror = function () { resolve(); };
			request.onblocked = function () { resolve(); };
		}).then(function () {
			return metaSet('activeUser', null);
		});
	}

	function onAccountSwitch(previous) {
		const label = previous || '';
		showBanner(t('offline_account_switch', 'Offline articles saved for another account are still on this device.') + ' ' + label);
		const bar = banner();
		if (bar.querySelector('.freshrss-offline-discard')) {
			return;
		}
		const discard = document.createElement('button');
		discard.type = 'button';
		discard.className = 'freshrss-offline-discard';
		discard.textContent = t('offline_discard_other', 'Remove other account data');
		discard.addEventListener('click', function () {
			const name = partitionName(previous);
			const request = indexedDB.deleteDatabase(name);
			request.onsuccess = function () { bar.hidden = true; fitBanner(bar); };
		});
		bar.appendChild(discard);
		fitBanner(bar);
	}

	function activate(username) {
		state.username = username;
		state.partition = partitionName(username);
		return openDatabase(state.partition).then(function (db) {
			state.db = db;
			state.ready = true;
			return metaSet('activeUser', username);
		}).then(function () {
			return rememberTheme();
		}).catch(failClosed);
	}

	function rememberTheme() {
		const links = [];
		document.querySelectorAll('link[rel="stylesheet"]').forEach(function (link) {
			const href = link.getAttribute('href') || '';
			if (href.indexOf('/themes/') >= 0 && href.indexOf('c=extension') < 0) {
				// Absolute, so the worker cache key matches the offline page request.
				links.push(new URL(href, window.location.href).href);
			}
		});
		const html = document.documentElement;
		return storePut('meta', {
			stylesheets: links,
			htmlClass: html.className,
			// hide_posts lives on #stream, not <html>. The theme hides every article body
			// until the article is .active, and the offline page never sets that class.
			hidePosts: !!document.querySelector('#stream.hide_posts'),
		}, 'theme');
	}

	function registerWorker() {
		if (!('serviceWorker' in navigator)) {
			return Promise.resolve();
		}
		// A worker registered after this page loaded does not control it until the next
		// navigation. skipWaiting() plus clients.claim() fires controllerchange; reload
		// once so the worker is already answering when the user later goes offline.
		// Guarded so a later update does not reload the page out from under the user.
		if (!navigator.serviceWorker.controller) {
			navigator.serviceWorker.addEventListener('controllerchange', function () {
				if (navigator.serviceWorker.controller) {
					window.location.reload();
				}
			}, { once: true });
		}
		return navigator.serviceWorker.register('./sw.js').then(function (registration) {
			return navigator.serviceWorker.ready.then(function () {
				return warmIcons();
			});
		}).catch(function (error) {
			console.error('FreshRSS service worker registration failed', error);
		});
	}

	/** Hand the worker the favicons this account's articles use, so they survive going offline. */
	function warmIcons() {
		const worker = navigator.serviceWorker && navigator.serviceWorker.controller;
		if (!worker || !state.ready) {
			return Promise.resolve();
		}
		return storeGetAll('entries').then(function (entries) {
			const urls = {};
			entries.forEach(function (entry) {
				const src = safeFavicon(entry.favicon);
				if (src) {
					urls[src] = true;
				}
			});
			worker.postMessage({ type: 'freshrss-warm', urls: Object.keys(urls) });
		}).catch(function () { /* a missed warm-up only costs icons, not articles */ });
	}

	function freshContext() {
		const url = new URL('./?c=index&a=normal', window.location.href);
		return fetch(url, { cache: 'no-store', credentials: 'same-origin', redirect: 'manual' }).then(function (response) {
			if (!response.ok || response.type !== 'basic') {
				return null;
			}
			return response.text();
		}).then(function (html) {
			if (!html) {
				return null;
			}
			const doc = new DOMParser().parseFromString(html, 'text/html');
			const node = doc.getElementById('jsonVars');
			if (!node) {
				return null;
			}
			let parsed;
			try {
				parsed = JSON.parse(node.textContent);
			} catch (e) {
				return null;
			}
			const ctx = parsed && parsed.context;
			if (!ctx || ctx.anonymous !== false || !ctx.csrf || !ctx.username) {
				return null;
			}
			return ctx;
		}).catch(function () {
			return null;
		});
	}

	function postJSON(url, body) {
		return fetch(url, {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json; charset=UTF-8' },
			body: JSON.stringify(body),
		}).then(function (response) {
			if (!response.ok) {
				throw new Error('status ' + response.status);
			}
			const type = response.headers.get('content-type') || '';
			if (type.indexOf('application/json') < 0) {
				throw new Error('not json');
			}
			return response.json();
		});
	}

	function dropIfCurrent(item) {
		return storeGet('outbox', item.key).then(function (stored) {
			if (logic.acknowledge(stored, item.revision)) {
				return storeDelete('outbox', item.key);
			}
			return undefined;
		});
	}

	function replayItems(items, csrf) {
		const reads = items.filter(function (item) { return item.action === 'read'; });
		const favourites = items.filter(function (item) { return item.action === 'favorite'; });
		const groups = logic.groupReads(reads);
		const jobs = [];
		[['read', true], ['unread', false]].forEach(function (pair) {
			const ids = groups[pair[0]];
			if (ids.length === 0) {
				return;
			}
			const sent = reads.filter(function (item) { return item.target === pair[1]; });
			const url = './?c=entry&a=read' + (pair[1] ? '' : '&is_read=0');
			jobs.push(function () {
				return postJSON(url, { ajax: true, _csrf: csrf, id: ids }).then(function () {
					return Promise.all(sent.map(dropIfCurrent));
				});
			});
		});
		favourites.forEach(function (item) {
			const url = './?c=entry&a=bookmark&id=' + encodeURIComponent(item.entryId) + (item.target ? '' : '&is_favorite=0');
			jobs.push(function () {
				return postJSON(url, { ajax: true, _csrf: csrf }).then(function () {
					return dropIfCurrent(item);
				});
			});
		});
		return jobs.reduce(function (chain, job) {
			return chain.then(job);
		}, Promise.resolve());
	}

	let replaying = false;

	function withLock(work) {
		if (navigator.locks && typeof navigator.locks.request === 'function') {
			return navigator.locks.request('freshrss-offline-' + installationKey(), { ifAvailable: true }, function (lock) {
				if (!lock) {
					setStatus(t('offline_sync_paused', 'Sync is paused: another tab is handling it.'));
					return undefined;
				}
				return work();
			});
		}
		if (replaying) {
			setStatus(t('offline_sync_paused', 'Sync is paused: another tab is handling it.'));
			return Promise.resolve();
		}
		replaying = true;
		return work().finally(function () { replaying = false; });
	}

	function replay() {
		if (!state.ready || !navigator.onLine) {
			return Promise.resolve();
		}
		// Read the outbox inside the lock, so two tabs can never send the same snapshot.
		return withLock(function () {
			return storeGetAll('outbox').then(function (items) {
				if (!items || items.length === 0) {
					return undefined;
				}
				return freshContext().then(function (ctx) {
					if (!ctx) {
						setStatus(t('offline_sync_paused', 'Sync is paused until you are signed in again.'));
						return undefined;
					}
					if (ctx.username !== state.username) {
						onAccountSwitch(state.username);
						return undefined;
					}
					return replayItems(items, ctx.csrf).then(function () {
						return storeGetAll('outbox');
					}).then(function (left) {
						if (left.length === 0 && typeof window.refreshUnreads === 'function') {
							window.refreshUnreads();
						}
						if (left.length === 0) {
							setStatus('');
						}
					});
				});
			});
		}).catch(function (error) {
			console.error('FreshRSS offline replay stopped', error);
			setStatus(t('offline_sync_failed', 'Sync failed. Pending changes were kept.'));
		});
	}

	function watchOnline() {
		window.addEventListener('online', function () { replay(); });
		document.addEventListener('visibilitychange', function () {
			if (document.visibilityState === 'visible') {
				replay();
			}
		});
		window.addEventListener('focus', function () { replay(); });
	}

	function watchAccountChanges() {
		if (typeof BroadcastChannel !== 'function') {
			return;
		}
		const channel = new BroadcastChannel(CHANNEL);
		channel.addEventListener('message', function (event) {
			const data = event.data || {};
			if (data.installation !== installationKey()) {
				return;
			}
			if (data.type === 'logout' || (data.type === 'switch' && data.username !== state.username)) {
				const offlineStream = document.getElementById('offline-stream');
				(offlineStream || document).querySelectorAll('[data-entry]').forEach(function (div) { div.remove(); });
				setStatus(t('offline_cleared', 'Offline articles were cleared.'));
			}
		});
	}

	function interceptLogout() {
		document.addEventListener('submit', function (event) {
			const form = event.target;
			if (!form || !form.querySelector || !form.querySelector('button.signout, .signout')) {
				return;
			}
			if (!state.ready) {
				return;
			}
			event.preventDefault();
			storeGetAll('outbox').finally(function () {
				return clearPartition();
			}).then(function () {
				broadcast('logout');
				form.submit();
			}).catch(function () {
				form.submit();
			});
		}, true);
	}

	function startOnline() {
		const ctx = window.context;
		if (!ctx || ctx.anonymous !== false || !ctx.username) {
			metaGet('activeUser').then(function (previous) {
				if (previous) {
					onAccountSwitch(previous);
				}
			}).catch(function () { /* metadata is optional */ });
			return;
		}
		watchBannerSize();
		activate(ctx.username).then(function () {
			watchOnline();
			watchAccountChanges();
			interceptLogout();
			document.addEventListener('freshrss:load-more', function (event) {
				harvest((event.target && event.target.id === 'stream') ? event.target : document.getElementById('stream'));
			});
			document.addEventListener('freshrss:entryStateChange', function (event) {
				const detail = event.detail || {};
				const div = document.getElementById('flux_' + detail.id);
				if (div) {
					harvest(div.parentNode || div);
				}
			});
			harvest(document.getElementById('stream'));
			if (!navigator.onLine) {
				showBanner(t('offline_banner', 'You are offline. Reading changes are saved on this device and sent when you reconnect.'));
			}
			return replay();
		});
	}

	/** Same-origin favicon only. Anything else is dropped rather than requested. */
	function safeFavicon(src) {
		if (!src) {
			return '';
		}
		let url;
		try {
			url = new URL(src, window.location.href);
		} catch (e) {
			return '';
		}
		if (url.origin !== window.location.origin || !url.pathname.endsWith('/f.php')) {
			return '';
		}
		return /^[0-9a-f]+$/i.test(url.searchParams.get('h') || '') ? url.href : '';
	}

	function iconUrl(name) {
		return new URL('../themes/icons/' + name + '.svg', window.location.href).href;
	}

	function makeIcon(name, alt) {
		const img = document.createElement('img');
		img.className = 'icon';
		img.src = iconUrl(name);
		img.alt = alt;
		return img;
	}

	/** Article body captured from FreshRSS's own rendered HTML. Images are already gone. */
	function fillContent(node, html) {
		const doc = new DOMParser().parseFromString('<div class="text">' + (html || '') + '</div>', 'text/html');
		const parsed = doc.querySelector('.text');
		if (!parsed) {
			return;
		}
		parsed.querySelectorAll('img, video, audio, picture, source, iframe, object, embed, script, link').forEach(function (media) {
			media.remove();
		});
		node.appendChild(parsed);
	}

	/** One row, built here. Never the saved page HTML. */
	/**
	 * Copies saved before the field split only have the rendered article HTML.
	 * Read the same fields out of it, and drop its images.
	 */
	function fieldsFromHtml(entry) {
		if (entry.title || !entry.html) {
			return entry;
		}
		const doc = new DOMParser().parseFromString(entry.html, 'text/html');
		const flux = doc.querySelector('.flux') || doc.body;
		const time = flux.querySelector('time[datetime]');
		const favicon = flux.querySelector('.flux_header img.favicon');
		const text = flux.querySelector('.flux_content .content .text');
		if (text) {
			text.querySelectorAll('img, video, audio, picture, source, iframe, object, embed').forEach(function (media) {
				media.remove();
			});
		}
		return Object.assign({}, entry, {
			title: textOf(flux.querySelector('.flux_header a.title')) || textOf(flux.querySelector('h1.title')),
			feed_name: (flux.querySelector('.flux_header') || flux).getAttribute('data-website-name') ||
				textOf(flux.querySelector('.flux_header .websiteName')),
			favicon: favicon ? favicon.getAttribute('src') : '',
			date_label: textOf(time),
			content: text ? text.innerHTML : '',
		});
	}

	function renderEntry(entry) {
		const article = document.createElement('article');
		article.className = 'offline-article' + (entry.is_read ? '' : ' not_read') + (entry.is_favorite ? ' favorite' : '');
		article.setAttribute('data-entry', String(entry.id));

		const row = document.createElement('div');
		row.className = 'offline-row';

		const read = document.createElement('button');
		read.type = 'button';
		read.className = 'offline-icon read';
		read.appendChild(makeIcon(entry.is_read ? 'read' : 'unread', entry.is_read ? '☑' : '□'));
		row.appendChild(read);

		const star = document.createElement('button');
		star.type = 'button';
		star.className = 'offline-icon bookmark';
		star.appendChild(makeIcon(entry.is_favorite ? 'starred' : 'non-starred', entry.is_favorite ? '★' : '☆'));
		row.appendChild(star);

		const faviconSrc = safeFavicon(entry.favicon);
		if (faviconSrc) {
			const favicon = document.createElement('img');
			favicon.className = 'favicon';
			favicon.src = faviconSrc;
			favicon.alt = '';
			row.appendChild(favicon);
		}

		const title = document.createElement('span');
		title.className = 'offline-title';
		title.textContent = entry.title || '';
		row.appendChild(title);

		const body = document.createElement('div');
		body.className = 'offline-body';
		body.hidden = true;
		if (entry.feed_name || entry.date_label) {
			const meta = document.createElement('p');
			meta.className = 'offline-meta';
			meta.textContent = [entry.feed_name, entry.date_label].filter(Boolean).join(' · ');
			body.appendChild(meta);
		}
		fillContent(body, entry.content || '');
		if (entry.link) {
			let href = '';
			try {
				const url = new URL(entry.link, window.location.href);
				if (url.protocol === 'http:' || url.protocol === 'https:') {
					href = url.href;
				}
			} catch (e) { /* a bad link is omitted, not rendered */ }
			if (href) {
				const source = document.createElement('a');
				source.className = 'offline-source';
				source.href = href;
				source.target = '_blank';
				source.rel = 'noreferrer';
				source.textContent = href;
				body.appendChild(source);
			}
		}

		article.appendChild(row);
		article.appendChild(body);
		return article;
	}

	function renderOffline() {
		const stream = document.getElementById('offline-stream');
		const empty = document.getElementById('offline-empty');
		return storeGetAll('entries').then(function (stored) {
			const entries = stored.slice().sort(function (a, b) { return (b.captured || 0) - (a.captured || 0); });
			stream.textContent = '';
			entries.forEach(function (entry) {
				if (!entry || !/^\d+$/.test(String(entry.id))) {
					return;
				}
				stream.appendChild(renderEntry(fieldsFromHtml(entry)));
			});
			if (empty) {
				empty.hidden = entries.length > 0;
				empty.textContent = t('offline_empty', 'No articles have been saved for offline reading yet.');
			}
		});
	}

	function setIcon(button, name, alt) {
		const img = button.querySelector('img');
		if (img) {
			img.src = iconUrl(name);
			img.alt = alt;
		}
	}

	/** Row opens the article. Read and favourite buttons queue instead. */
	function handleOfflineClick(event) {
		const stream = document.getElementById('offline-stream');
		const button = event.target.closest('button.read, button.bookmark');
		if (button && stream.contains(button)) {
			const article = button.closest('.offline-article');
			if (!article) {
				return;
			}
			event.preventDefault();
			const entryId = article.getAttribute('data-entry');
			const action = button.classList.contains('read') ? 'read' : 'favorite';
			const target = action === 'read' ? article.classList.contains('not_read') : !article.classList.contains('favorite');
			queue(action, entryId, target).then(function (ok) {
				if (!ok) {
					return;
				}
				applySnapshot(article, action, target);
				if (action === 'read') {
					setIcon(button, target ? 'read' : 'unread', target ? '☑' : '□');
				} else {
					setIcon(button, target ? 'starred' : 'non-starred', target ? '★' : '☆');
				}
				setStatus(t('offline_queued', 'Saved on this device. It will sync next time you are online.'));
			});
			return;
		}
		if (event.target.closest('a')) {
			return;
		}
		const row = event.target.closest('.offline-row');
		if (!row || !stream.contains(row)) {
			return;
		}
		const article = row.parentElement;
		const body = article.querySelector('.offline-body');
		const open = article.classList.contains('active');
		stream.querySelectorAll('.offline-article.active').forEach(function (other) {
			other.classList.remove('active');
			const otherBody = other.querySelector('.offline-body');
			if (otherBody) {
				otherBody.hidden = true;
			}
		});
		if (!open) {
			article.classList.add('active');
			body.hidden = false;
			// The normal view marks an article read when it is opened.
			if (article.classList.contains('not_read')) {
				const readButton = article.querySelector('button.read');
				queue('read', article.getAttribute('data-entry'), true).then(function (ok) {
					if (!ok) {
						return;
					}
					applySnapshot(article, 'read', true);
					if (readButton) {
						setIcon(readButton, 'read', '☑');
					}
				});
			}
		}
	}

	function claimOfflineClient() {
		if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
			return;
		}
		navigator.serviceWorker.controller.postMessage({ type: 'freshrss-offline-client', active: true });
	}

	function startOfflinePage() {
		claimOfflineClient();
		if (navigator.serviceWorker) {
			navigator.serviceWorker.addEventListener('controllerchange', claimOfflineClient);
		}
		document.getElementById('offline-stream').addEventListener('click', handleOfflineClick);
		document.getElementById('offline-clear').addEventListener('click', function () {
			clearPartition().then(function () {
				broadcast('logout');
				document.getElementById('offline-stream').textContent = '';
				setStatus(t('offline_cleared', 'Offline articles were cleared from this device.'));
			});
		});
		const reload = document.getElementById('offline-reload');
		window.addEventListener('online', function () {
			reload.hidden = false;
		});
		reload.addEventListener('click', function () { window.location.reload(); });
		setStatus(t('offline_notice',
			'Saved articles stay readable on this device until you clear them. The server cannot check your session while you are offline.'));

		metaGet('activeUser').then(function (username) {
			const account = document.getElementById('offline-account');
			if (!username) {
				if (account) {
					account.textContent = t('offline_no_account', 'No account cached yet.');
				}
				return undefined;
			}
			if (account) {
				account.textContent = username;
			}
			return activate(username).then(renderOffline);
		}).catch(failClosed);
	}

	function whenContext(run) {
		if (window.context) {
			run();
			return;
		}
		// main.js sets context and fires this event synchronously while it parses.
		// Both scripts are async, so that event may already have fired before this
		// script ran. A one-shot listener registered now would never run, and the
		// worker would never be registered. Poll until context appears.
		const started = Date.now();
		(function wait() {
			if (window.context) {
				run();
				return;
			}
			if (Date.now() - started > 10000) {
				return;
			}
			setTimeout(wait, 50);
		}());
	}

	function isOfflinePage() {
		return !!document.querySelector('body[data-offline-reader]');
	}

	if (isOfflinePage()) {
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', startOfflinePage);
		} else {
			startOfflinePage();
		}
		return;
	}

	window.FreshRSS_Offline = {
		queue: queue,
		clear: function () {
			return clearPartition().then(function () { broadcast('logout'); });
		},
		ready: function () { return state.ready; },
	};

	if (!supported()) {
		state.unavailable = true;
		return;
	}

	// Register before context is ready. Both scripts load async, so this script can
	// run before main.js sets window.context — and the user can go offline before it
	// arrives. An unregistered worker cannot answer the reload, so the browser shows
	// its own offline page instead of offline.html.
	registerWorker();
	whenContext(startOnline);
}());
