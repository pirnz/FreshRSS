/*!
 * FreshRSS offline reading — pure helpers, no DOM and no storage.
 * Shared by p/scripts/offline.js and the node --test suite.
 * @license GPL-2.0-or-later
 */
(function (root, factory) {
	const api = factory();
	if (typeof module === 'object' && module.exports) {
		module.exports = api;
	} else {
		root.FreshRSS_OfflineLogic = api;
	}
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	const MAX_ENTRIES = 250;

	/**
	 * Latest absolute target wins. A second toggle replaces the record; it never
	 * cancels it, because the first request may already have reached the server.
	 * @param {object|undefined} existing
	 * @param {string} action 'read' | 'favorite'
	 * @param {string} entryId
	 * @param {boolean} target
	 * @param {number} now
	 * @returns {object}
	 */
	function coalesce(existing, action, entryId, target, now) {
		const revision = existing && typeof existing.revision === 'number' ? existing.revision + 1 : 1;
		return {
			key: action + ':' + entryId,
			action: action,
			entryId: String(entryId),
			target: !!target,
			revision: revision,
			updated: now,
		};
	}

	/**
	 * Drop an acknowledged item only when nothing newer was queued while it was in flight.
	 * @param {object|undefined} stored
	 * @param {number} sentRevision
	 * @returns {boolean} true when the stored record should be deleted
	 */
	function acknowledge(stored, sentRevision) {
		if (!stored) {
			return false;
		}
		return stored.revision === sentRevision;
	}

	/**
	 * Group read mutations by their absolute target so one request can carry many ids.
	 * @param {Array<object>} items
	 * @returns {{read: string[], unread: string[]}}
	 */
	function groupReads(items) {
		const read = [];
		const unread = [];
		for (let i = 0; i < items.length; i++) {
			if (items[i].action !== 'read') {
				continue;
			}
			(items[i].target ? read : unread).push(String(items[i].entryId));
		}
		return { read: read, unread: unread };
	}

	function isProtected(entry, pendingIds) {
		return entry.is_favorite === true || pendingIds.has(String(entry.id));
	}

	/**
	 * Keep at most `limit` entries. Drop oldest read non-favourites first, then oldest
	 * unread non-favourites. Never drop a favourite or an entry with a pending mutation.
	 * @param {Array<object>} entries
	 * @param {Set<string>} pendingIds
	 * @param {number} [limit]
	 * @returns {string[]} ids to delete
	 */
	function prune(entries, pendingIds, limit) {
		const cap = typeof limit === 'number' ? limit : MAX_ENTRIES;
		if (entries.length <= cap) {
			return [];
		}
		const disposable = entries.filter(function (entry) {
			return !isProtected(entry, pendingIds);
		});
		disposable.sort(function (a, b) {
			if (a.is_read !== b.is_read) {
				return a.is_read ? -1 : 1;
			}
			return (a.captured || 0) - (b.captured || 0);
		});
		const overflow = entries.length - cap;
		return disposable.slice(0, overflow).map(function (entry) {
			return String(entry.id);
		});
	}

	/**
	 * A freshly rendered server snapshot must not clobber a decision still waiting in the outbox.
	 * @param {object} incoming
	 * @param {object|undefined} pendingRead
	 * @param {object|undefined} pendingFavorite
	 * @returns {object}
	 */
	function mergePending(incoming, pendingRead, pendingFavorite) {
		const merged = Object.assign({}, incoming);
		if (pendingRead) {
			merged.is_read = !!pendingRead.target;
		}
		if (pendingFavorite) {
			merged.is_favorite = !!pendingFavorite.target;
		}
		return merged;
	}

	return {
		MAX_ENTRIES: MAX_ENTRIES,
		coalesce: coalesce,
		acknowledge: acknowledge,
		groupReads: groupReads,
		prune: prune,
		mergePending: mergePending,
	};
}));
