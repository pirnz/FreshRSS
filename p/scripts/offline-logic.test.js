/*!
 * node --test cases for the offline reading helpers.
 * @license GPL-2.0-or-later
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// offline-logic.js is a classic browser script. Evaluate it with the same global it uses.
const source = readFileSync(new URL('./offline-logic.js', import.meta.url), 'utf8');
const logic = (await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(
	source + '\nexport default globalThis.FreshRSS_OfflineLogic;\n'))).default;

test('coalesce replaces the target and bumps the revision', function () {
	const first = logic.coalesce(undefined, 'read', '7', true, 100);
	assert.equal(first.key, 'read:7');
	assert.equal(first.target, true);
	assert.equal(first.revision, 1);

	const second = logic.coalesce(first, 'read', '7', false, 200);
	assert.equal(second.target, false);
	assert.equal(second.revision, 2);
	assert.equal(second.key, first.key);
});

test('acknowledge ignores a stale reply once a newer toggle is stored', function () {
	const stored = { revision: 3, target: false };
	assert.equal(logic.acknowledge(stored, 3), true);
	assert.equal(logic.acknowledge(stored, 2), false);
	assert.equal(logic.acknowledge(undefined, 1), false);
});

test('groupReads splits ids by absolute target', function () {
	const groups = logic.groupReads([
		{ action: 'read', entryId: '1', target: true },
		{ action: 'favorite', entryId: '1', target: false },
		{ action: 'read', entryId: '2', target: false },
		{ action: 'read', entryId: '3', target: true },
	]);
	assert.deepEqual(groups.read, ['1', '3']);
	assert.deepEqual(groups.unread, ['2']);
});

test('prune drops oldest read non-favourites before unread ones', function () {
	const entries = [];
	for (let i = 0; i < 6; i++) {
		entries.push({ id: String(i), is_read: i < 4, is_favorite: false, captured: i });
	}
	const dropped = logic.prune(entries, new Set(), 3);
	assert.deepEqual(dropped, ['0', '1', '2']);
});

test('prune never drops a favourite or a pending mutation', function () {
	const entries = [
		{ id: '1', is_read: true, is_favorite: true, captured: 1 },
		{ id: '2', is_read: true, is_favorite: false, captured: 2 },
		{ id: '3', is_read: false, is_favorite: false, captured: 3 },
	];
	const dropped = logic.prune(entries, new Set(['3']), 1);
	assert.deepEqual(dropped, ['2']);
	assert.deepEqual(logic.prune(entries, new Set(['2', '3']), 1), []);
});

test('mergePending keeps the queued decision over the server snapshot', function () {
	const incoming = { id: '9', is_read: true, is_favorite: false, html: '<div></div>' };
	const merged = logic.mergePending(incoming, { target: false }, { target: true });
	assert.equal(merged.is_read, false);
	assert.equal(merged.is_favorite, true);
	assert.equal(merged.html, incoming.html);
	assert.equal(logic.mergePending(incoming, undefined, undefined).is_read, true);
});
