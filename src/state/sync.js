// Sync: the settings, the engine over a record store, and when it runs.
// The only module that imports from sync-kit.
//
// Workspace "project". One plan is one record — a sync-kit `DocumentRecord`
// whose `body` is exactly the bytes `File ▸ Save` writes, so a plan that
// travelled through sync and a plan that travelled on a USB stick are the same
// plan. The server never learns what any of it means.
//
// The rule that matters is the last one in `adopt()`: a newer plan from
// somewhere else replaces this one only while there is nothing unsaved here.
// Overwriting someone's unsaved work is never acceptable, so that case asks.

import {
  SyncEngine, HttpTransport, SyncedDocument, LocalStore, IndexedDbStore,
  SYNC_CURSOR_KEYS, SYNC_EVENTS, publishStatus, onSyncNow,
} from '../../sync-kit/js/index.js';
import { store, set, loadProject, markSaved, subscribe, revision } from './store.js';
import { serialize, parse } from '../io/json.js';
import { computeSchedule } from '../model/schedule.js';

export const WORKSPACE = 'project';
const SETTINGS_KEY = 'project-planner:sync';
const DEVICE_KEY = 'project-planner:deviceId';
/** How often a configured, enabled sync runs by itself. */
const INTERVAL_MS = 30_000;
/** How long after the last edit the plan is written to the record store. */
const COMMIT_MS = 800;

let recordStore = null;
let engine = null;
let doc = null;
let timer = null;
let commitTimer = null;
let unlisten = null;
let settings = { url: '', token: '', enabled: false };
/** True while a pulled plan is being loaded, so the load is not sent back out. */
let adopting = false;
/** The plan the record store currently describes; a different plan starts a new document. */
let docPlanId = null;
let lastStatus = { phase: 'idle', lastSyncAt: null, lastError: null, pulled: 0, pushed: 0 };

const read = (key, fallback) => { try { const v = localStorage.getItem(key); return v == null ? fallback : v; } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode, quota */ } };

/** A stable id for this device. It is the `origin` of every record written here. */
export function deviceId() {
  let id = read(DEVICE_KEY, '');
  if (!id) {
    id = (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).slice(0, 8);
    write(DEVICE_KEY, id);
  }
  return id;
}

export const getSettings = () => ({ ...settings });
export const syncStatus = () => (engine ? engine.status : lastStatus);
export const syncConfigured = () => !!(settings.url && settings.enabled);

/**
 * IndexedDB where there is one, `localStorage` where there is not. A plan's
 * JSON is far larger than a note, and a WKWebView serving a custom scheme has
 * not always had a working IndexedDB, so the fallback is not theoretical.
 */
async function openStore() {
  try {
    const idb = new IndexedDbStore({ name: 'project-planner' });
    await idb.open();
    return idb;
  } catch {
    const local = new LocalStore({ prefix: 'project-planner' });
    await local.open();
    return local;
  }
}

/** Call once, after the first plan is loaded. */
export async function initSync() {
  try { settings = { ...settings, ...JSON.parse(read(SETTINGS_KEY, '{}')) }; } catch { /* keep defaults */ }
  recordStore = await openStore();
  await openDocument();

  // The record store follows the plan: every committed edit, debounced.
  let lastRev = revision();
  let lastId = store.project.id;
  subscribe(() => {
    if (store.project.id !== lastId) { lastId = store.project.id; lastRev = revision(); void openDocument(); return; }
    if (revision() === lastRev) return;
    lastRev = revision();
    if (adopting) return;
    clearTimeout(commitTimer);
    commitTimer = setTimeout(() => { void commit(); }, COMMIT_MS);
  });

  if (typeof window !== 'undefined') {
    unlisten = onSyncNow(() => { void syncNow(); });
    // Coming back to the window is the moment a stale plan is most obvious.
    window.addEventListener('focus', () => { if (syncConfigured()) void syncNow(); });
  }
  rebuild();
}

/** Point the document at the open plan, reading what the store already holds. */
async function openDocument() {
  if (!recordStore) return;
  docPlanId = store.project.id;
  doc = new SyncedDocument(recordStore, {
    id: docPlanId, origin: deviceId(), format: store.project.format, name: store.project.name,
  });
  await doc.load();
  await commit();
}

/** Write the open plan into the record store, where a push can find it. */
async function commit() {
  if (!doc || adopting || store.project.id !== docPlanId) return;
  const body = serialize(store.project);
  if (body === doc.body && store.project.name === doc.name) return;
  doc.edit(body, store.project.name);
  await doc.save();
}

/** Save new settings and restart. A changed URL clears both cursors: they belong to the old server. */
export async function applySettings(next) {
  const urlChanged = (next.url || '').trim() !== settings.url;
  settings = { url: (next.url || '').trim(), token: (next.token || '').trim(), enabled: !!next.enabled };
  write(SETTINGS_KEY, JSON.stringify(settings));
  if (urlChanged && recordStore) {
    // A cursor describes a position against one particular server and means
    // nothing against another; a client that keeps them uploads nothing at all.
    for (const key of SYNC_CURSOR_KEYS) await recordStore.setMeta(key, 0);
  }
  rebuild();
  if (syncConfigured()) await syncNow();
  announce();
}

function rebuild() {
  clearInterval(timer);
  timer = null;
  engine = null;
  if (!recordStore || !settings.url) { announce(); return; }
  const transport = new HttpTransport({ baseUrl: settings.url, token: settings.token, label: WORKSPACE });
  engine = new SyncEngine(recordStore, transport, deviceId());
  if (settings.enabled) timer = setInterval(() => { void syncNow(); }, INTERVAL_MS);
  announce();
}

function announce() {
  lastStatus = { ...syncStatus() };
  publishStatus(lastStatus);
}

/** One sync, now. A failure is reported through the status, never thrown at a caller. */
export async function syncNow() {
  if (!engine) { set({ hint: 'Set a sync URL in Sync… first.' }); return null; }
  await commit();
  try {
    const result = await engine.sync();
    if (result.applied.length) await adopt(result.applied);
    lastStatus = { ...engine.status };
    return result;
  } catch (err) {
    lastStatus = { ...engine.status };
    set({ hint: `Sync failed: ${err.message}` });
    return null;
  }
}

/** Sync because the plan was just written to a file, if that is switched on. */
export function syncAfterSave() { if (syncConfigured()) void syncNow(); }

/**
 * What to do with a plan that arrived from somewhere else.
 *
 *   'ignore'  nothing for this plan came back
 *   'take'    it is newer and nothing here is unsaved: replace what is open
 *   'ask'     it is newer but this plan has unsaved edits, and discarding
 *             someone's work is never a decision this code gets to make
 *
 * Pure, and exported, because it is the one rule in this module worth reading
 * on its own — and the one worth a test that does not need a browser.
 */
export function decideRemote({ dirty, applied, planId }) {
  const remote = (applied || []).find((r) => r.id === planId && !r.deletedAt);
  if (!remote) return { action: 'ignore', remote: null };
  return { action: dirty ? 'ask' : 'take', remote };
}

/**
 * A newer version of this plan arrived. Take it when nothing here is unsaved;
 * otherwise ask, because the alternative is discarding someone's work.
 */
async function adopt(applied) {
  const { action, remote } = decideRemote({ dirty: store.ui.dirty, applied, planId: docPlanId });
  if (action === 'ignore' || !doc) return;
  if (action === 'take') { load(remote); return; }
  const { confirmDialog } = await import('../ui/dialog.js');
  const theirs = await confirmDialog(
    'A newer plan arrived',
    `Another device saved “${remote.name}” after your last save, and this plan has changes you have not saved to a file. Replace them with the version that arrived, or keep yours and send it on the next sync?`,
    'Use the newer plan');
  if (theirs) load(remote);
  else { doc.edit(serialize(store.project), store.project.name); await doc.save(); }
}

/** Put a record's plan on screen. */
function load(remote) {
  if (!doc.accept(remote)) return;
  let parsed;
  try { parsed = parse(remote.body); } catch { set({ hint: 'A plan arrived that could not be read.' }); return; }
  adopting = true;
  try {
    loadProject(parsed.project, store.ui.fileName);
    markSaved(store.ui.fileName);
    set({ hint: `Updated from ${remote.origin === deviceId() ? 'another window' : 'another device'}.` });
  } finally {
    adopting = false;
  }
}

// ---------------------------------------------------------------- the shelf
//
// Every plan this device has opened is a record, and a sync brings back every
// plan any device has opened. That set — not the file system — is what the
// Projects screen lists.

/** What a card needs, read out of a record. Pure, and never throws on a bad body. */
export function planSummary(record) {
  const base = { id: record.id, name: record.name || 'Untitled project', updatedAt: record.updatedAt, origin: record.origin, ok: false };
  let project;
  try { project = parse(record.body).project; } catch { return base; }
  let schedule = null;
  try { schedule = computeSchedule(project); } catch { /* an unreadable plan still gets a card */ }
  return {
    ...base, ok: true, name: project.name || base.name,
    tasks: project.tasks.length, resources: project.resources.length,
    startIso: schedule?.startIso || project.start, finishIso: schedule?.finishIso || null,
    percent: schedule?.percent ?? 0, critical: schedule?.criticalCount ?? 0,
  };
}

/** The raw records, for a caller that wants the plans themselves, not a summary. */
export async function planRecords() {
  if (!recordStore) return [];
  const all = await recordStore.all();
  return all
    .filter((r) => r && r.type === 'document' && !r.deletedAt && typeof r.body === 'string')
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Every plan on the shelf, the most recently touched first. */
export async function listPlans() {
  if (!recordStore) return [];
  const all = await recordStore.all();
  return all
    .filter((r) => r && r.type === 'document' && !r.deletedAt && typeof r.body === 'string')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(planSummary);
}

/** Put one of them on screen. */
export async function openPlan(id) {
  if (!recordStore) return false;
  const record = await recordStore.get(id);
  if (!record || record.deletedAt) { set({ hint: 'That plan is no longer on the shelf.' }); return false; }
  let parsed;
  try { parsed = parse(record.body); } catch { set({ hint: 'That plan could not be read.' }); return false; }
  adopting = true;
  try {
    loadProject(parsed.project, null);
    markSaved(null);
  } finally {
    adopting = false;
  }
  await openDocument();
  return true;
}

/**
 * Take a plan off the shelf everywhere. A tombstone, not a hole: the record
 * stays so the deletion reaches the other devices too.
 */
export async function deletePlan(id) {
  if (!recordStore) return;
  const record = await recordStore.get(id);
  if (!record) return;
  const at = Math.max(Date.now(), record.updatedAt + 1);
  await recordStore.put([{ ...record, body: '', deletedAt: at, updatedAt: at, origin: deviceId() }]);
  if (syncConfigured()) void syncNow();
}

/** Pull now, so the shelf shows what other devices have added. */
export async function refreshPlans() {
  if (syncConfigured()) await syncNow();
  return listPlans();
}

/** Stop everything. Only tests need this. */
export function stopSync() {
  clearInterval(timer);
  clearTimeout(commitTimer);
  unlisten?.();
  timer = null;
  engine = null;
}

export { SYNC_EVENTS };
