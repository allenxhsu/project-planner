// CRUD reaches both copies — the local store and the server — and the other
// device agrees.
//
// Every other sync test here is one-sided: the client's merge rules, or the
// server's protocol. Both pass while a change never actually crosses. That is
// the shape of the bug that prompted this file: a plan deleted on the Mac was
// still on the deployed Portal, and nothing in either suite would have caught
// it, because deletePlan writes a perfectly correct tombstone and the server
// stores tombstones perfectly correctly.
//
// So: the REAL sync server (sync-kit/server/dist) on an ephemeral port, two
// independent devices with their own stores, and every operation asserted in
// three places — the device that made it, the server, and the other device.
// Skips with a message when sync-kit is not checked out beside this repo; a
// test that cannot see the other side must say so rather than pass.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SyncEngine, HttpTransport, MemoryStore } from '../sync-kit/js/index.js';

const KIT = fileURLToPath(new URL('../../sync-kit/server/dist/', import.meta.url));
const present = existsSync(`${KIT}server.js`);

const WORKSPACE = 'project';
const TOKEN = 'a-test-token-at-least-12-chars';

describe('CRUD reaches the local store, the server, and the other device', { skip: present ? false : 'sync-kit/server is not checked out beside this repo' }, () => {
  // Started once, on first use, and awaited by every test. A `before` hook
  // would be tidier and did not run here; a promise nobody can race is worth
  // more than tidiness in the one file that exists to catch silent failures.
  let booted = null;
  let running = null;
  const boot = () => (booted ??= start());

  async function start() {
    const { createApp } = await import(`${KIT}server.js`);
    const { loadConfig } = await import(`${KIT}config.js`);
    const { createStorage } = await import(`${KIT}storage/index.js`);
    const config = loadConfig({ STORAGE: 'memory', PORT: '0', HOST: '127.0.0.1', SYNC_TOKENS: `${WORKSPACE}:test:${TOKEN}` });
    const storage = await createStorage(config);
    const app = createApp(config, storage);
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    running = app;
    return `http://127.0.0.1:${app.address().port}/w/${WORKSPACE}`;
  }

  /** A device: its own store, its own id, its own cursors. */
  async function device(id, base) {
    const store = new MemoryStore();
    await store.open();
    const engine = new SyncEngine(store, new HttpTransport({ baseUrl: base, token: TOKEN }), id);
    // A sync that quietly fails is exactly what this file is here to catch, so
    // the harness refuses to let one pass as a no-op.
    const sync = async () => {
      const out = await engine.sync();
      if (!out || out.error) throw new Error(`${id} could not sync: ${out?.error ?? 'no result'}`);
      return out;
    };
    return { id, store, engine, sync };
  }

  /**
   * A plan exactly as Planner writes one (state/sync.js › commit).
   *
   * `origin` is the device that wrote it, and it is load-bearing: the engine
   * pushes only records this device authored, so that what it pulled from the
   * server is never echoed straight back. A fixture stamped with anything else
   * sits in the local store and never leaves it — which is a fair impression
   * of the bug this file is about, and cost an hour to notice.
   */
  const plan = (id, name, origin, tasks = []) => ({
    id, type: 'document', format: 'project-planner', name,
    body: JSON.stringify({ id, name, tasks, format: 'project-planner', version: 1 }),
    updatedAt: Date.now(), deletedAt: null, origin,
  });

  /** What the server itself holds: a brand-new device that has never seen anything. */
  async function onServer(id, base) {
    const fresh = await device(`audit_${Math.random().toString(36).slice(2, 8)}`, base);
    await fresh.sync();
    return (await fresh.store.all()).find((r) => r.id === id) ?? null;
  }

  after(() => running?.close());

  test('CREATE on one device reaches the server and the other device', async () => {
    const base = await boot();
    const a = await device('mac', base);
    const b = await device('portal', base);
    await a.store.put([plan('plan_alpha', 'Alpha', a.id)]);
    await a.sync();

    assert.ok((await a.store.all()).some((r) => r.id === 'plan_alpha'), 'the device that made it');
    assert.ok(await onServer('plan_alpha', base), 'the server');

    await b.sync();
    const there = (await b.store.all()).find((r) => r.id === 'plan_alpha');
    assert.ok(there, 'the other device');
    assert.equal(there.name, 'Alpha');
    assert.equal(JSON.parse(there.body).name, 'Alpha', 'body and all');
  });

  test('UPDATE on the second device comes back to the first', async () => {
    const base = await boot();
    const a = await device('mac', base);
    const b = await device('portal', base);
    await a.store.put([plan('plan_beta', 'Beta', a.id)]);
    await a.sync();
    await b.sync();

    const mine = (await b.store.all()).find((r) => r.id === 'plan_beta');
    await b.store.put([{ ...mine, name: 'Beta renamed', body: JSON.stringify({ id: 'plan_beta', name: 'Beta renamed', tasks: [{ id: 't1', name: 'One' }] }), updatedAt: mine.updatedAt + 1000, origin: 'portal' }]);
    await b.sync();

    assert.equal((await onServer('plan_beta', base)).name, 'Beta renamed', 'the server took the edit');
    await a.sync();
    const back = (await a.store.all()).find((r) => r.id === 'plan_beta');
    assert.equal(back.name, 'Beta renamed', 'and it came back to the first device');
    assert.equal(JSON.parse(back.body).tasks.length, 1, 'with the task that was added');
  });

  test('DELETE propagates as a tombstone — the bug this file exists for', async () => {
    const base = await boot();
    const a = await device('mac', base);
    const b = await device('portal', base);
    await a.store.put([plan('plan_gamma', 'Gamma', a.id)]);
    await a.sync();
    await b.sync();
    assert.ok((await b.store.all()).find((r) => r.id === 'plan_gamma' && !r.deletedAt), 'both have it to begin with');

    // Exactly what Planner's deletePlan writes.
    const mine = (await a.store.all()).find((r) => r.id === 'plan_gamma');
    const at = mine.updatedAt + 1000;
    await a.store.put([{ ...mine, body: '', deletedAt: at, updatedAt: at, origin: 'mac' }]);
    await a.sync();

    const served = await onServer('plan_gamma', base);
    assert.ok(served, 'the record is still there — a delete is a tombstone, not a hole');
    assert.ok(served.deletedAt, 'and the server carries the tombstone');

    await b.sync();
    const gone = (await b.store.all()).find((r) => r.id === 'plan_gamma');
    assert.ok(gone.deletedAt, 'the other device sees it deleted');
    // Both apps list plans as `!r.deletedAt`; this is that filter.
    assert.equal((await b.store.all()).filter((r) => r.type === 'document' && !r.deletedAt && r.id === 'plan_gamma').length, 0,
      'so it disappears from the plan list on the other device');
  });

  test('an edit made after a delete wins, and an older one does not resurrect it', async () => {
    const base = await boot();
    const a = await device('mac', base);
    const b = await device('portal', base);
    await a.store.put([plan('plan_delta', 'Delta', a.id)]);
    await a.sync();
    await b.sync();

    const mine = (await a.store.all()).find((r) => r.id === 'plan_delta');
    const at = mine.updatedAt + 1000;
    await a.store.put([{ ...mine, body: '', deletedAt: at, updatedAt: at, origin: 'mac' }]);
    await a.sync();

    // B edits with an OLDER stamp: last-write-wins must keep the delete.
    const stale = (await b.store.all()).find((r) => r.id === 'plan_delta');
    await b.store.put([{ ...stale, name: 'Delta stale', updatedAt: at - 500, deletedAt: null, origin: 'portal' }]);
    await b.sync();
    assert.ok((await onServer('plan_delta', base)).deletedAt, 'a stale edit does not bring a deleted plan back');

    // A newer edit does, which is how an undelete works at all.
    await b.store.put([{ ...stale, name: 'Delta again', updatedAt: at + 1000, deletedAt: null, origin: 'portal' }]);
    await b.sync();
    const revived = await onServer('plan_delta', base);
    assert.equal(revived.deletedAt, null, 'a newer edit revives it');
    assert.equal(revived.name, 'Delta again');
  });

  test('a device that never synced stays an island until it does', async () => {
    const base = await boot();
    // The actual situation: a Mac whose Settings › Sync was never filled in.
    const island = { store: new MemoryStore() };
    await island.store.open();
    await island.store.put([plan('plan_island', 'Island', 'island')]);
    assert.equal(await onServer('plan_island', base), null, 'nothing it does reaches the server');

    // And once connected, everything it holds goes up on the first sync.
    const joined = new SyncEngine(island.store, new HttpTransport({ baseUrl: base, token: TOKEN }), 'island');
    await joined.sync();
    assert.ok(await onServer('plan_island', base), 'the first sync uploads what was only local');
  });
});
