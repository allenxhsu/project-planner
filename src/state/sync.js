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
  portalApp, portalSession, portalRemote, requestPersistentStorage, storageStatus,
} from '../../sync-kit/js/index.js';
import { store, set, loadProject, markSaved, subscribe, revision, tryCommit, setAutosaveSink, readAutosave, clearLocalAutosave, AUTOSAVE_STORAGE_KEY } from './store.js';
import { uid } from '../util.js';
import { hosted as hostedPage } from '../host.js';
import { today } from '../model/calendar.js';
import { serialize, parse } from '../io/json.js';
import { computeSchedule } from '../model/schedule.js';
import { freshCopy } from '../model/setup.js';
import { slotsOf } from '../model/model.js';
import { parseTime } from '../model/agenda.js';
import { readProfile } from '../io/profile.js';

export const WORKSPACE = 'project';
/** This app's id on the Portal, which is the same word. */
export const APP_ID = 'project';
const SETTINGS_KEY = 'project-planner:sync';
const DEVICE_KEY = 'project-planner:deviceId';
/** How often a configured, enabled sync runs by itself. */
const INTERVAL_MS = 30_000;
/** How long after the last edit the plan is written to the record store. */
// In the Mac app nothing asks to save on close, so an edit has to be in the
// store before a quick ⌘Q can beat it.
const COMMIT_MS = hostedPage ? 200 : 800;
/** …and how long after that it goes to the server, when sync is on. */
const AUTOSAVE_MS = 2_500;

let recordStore = null;
let engine = null;
let doc = null;
let timer = null;
let commitTimer = null;
let autosaveTimer = null;
let unlisten = null;
let settings = { url: '', token: '', enabled: false };
/**
 * Served by the Portal, this is the workspace on the origin the page is
 * already on — no URL to paste and no token to keep, because the session
 * cookie is the credential. Null anywhere else, and then the pasted settings
 * are what sync runs on, exactly as before.
 */
let portal = null;
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
export const syncConfigured = () => !!(portal || (settings.url && settings.enabled));
/** True when the Portal is providing the server, so Settings has nothing to ask for. */
export const inPortal = () => !!portal;

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
// ------------------------------------------------------------ whole-store export
//
// A copy that can live anywhere without the server: every record this app
// holds, tombstones included, in one file. Tombstones matter — a backup that
// dropped them would resurrect everything anyone had deleted the moment it
// was imported.

export const STORE_EXPORT_FORMAT = 'project-planner.store';

/** Everything in the store, as one object. */
export async function exportStore() {
  if (!recordStore) throw new Error('The store is not open yet.');
  const records = await recordStore.all();
  return {
    format: STORE_EXPORT_FORMAT,
    version: 1,
    workspace: WORKSPACE,
    exportedAt: new Date().toISOString(),
    device: deviceId(),
    counts: {
      total: records.length,
      live: records.filter((r) => !r.deletedAt).length,
      deleted: records.filter((r) => r.deletedAt).length,
    },
    records,
  };
}

/**
 * Merge a file back in, by the rule sync already uses: the newer `updatedAt`
 * wins, and a tombstone is as good as a record. Importing is never a delete —
 * what is here and not in the file is left alone.
 *
 * @returns {{ added: number, replaced: number, kept: number }}
 */
export async function importStore(text) {
  if (!recordStore) throw new Error('The store is not open yet.');
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('That file is not JSON.'); }
  if (!doc || doc.format !== STORE_EXPORT_FORMAT) {
    throw new Error(`That is not a ${WORKSPACE} store export — it says its format is "${doc?.format ?? 'nothing'}".`);
  }
  const incoming = Array.isArray(doc.records) ? doc.records : [];
  const here = new Map((await recordStore.all()).map((r) => [r.id, r]));
  const write = [];
  let added = 0; let replaced = 0; let kept = 0;
  for (const r of incoming) {
    if (!r || typeof r.id !== 'string' || !Number.isFinite(+r.updatedAt)) continue;
    const mine = here.get(r.id);
    if (!mine) { write.push(r); added++; continue; }
    if (+r.updatedAt > +mine.updatedAt) { write.push(r); replaced++; } else kept++;
  }
  if (write.length) await recordStore.put(write);
  if (write.length && syncConfigured()) void syncNow();
  return { added, replaced, kept };
}

/** The last counts read, for a readout that renders synchronously. */
let counts = { local: 0, server: null, at: 0 };
export const lastCounts = () => ({ ...counts });

/** How many records are here, and how many the server says it holds. */
export async function storeCounts() {
  const local = recordStore ? (await recordStore.all()).length : 0;
  let server = null;
  const base = portal ? portal.baseUrl : settings.url;
  if (base) {
    try {
      const res = await fetch(`${String(base).replace(/\/+$/, '')}/sync/health`, {
        headers: settings.token && !portal ? { Authorization: `Bearer ${settings.token}` } : {},
        credentials: portal ? 'include' : 'same-origin',
      });
      if (res.ok) {
        const body = await res.json();
        server = Number.isFinite(+body?.records) ? +body.records : (Number.isFinite(+body?.count) ? +body.count : null);
      }
    } catch { server = null; }
  }
  counts = { local, server, at: Date.now() };
  announce();
  return { local, server };
}

// ------------------------------------------------------- local persistence
//
// "It is in the cloud" is not the same as "it is on this machine", and a
// browser's storage is not something a browser promises to keep: under
// pressure it evicts whole origins. sync-kit's requestPersistentStorage() asks
// it not to, and a browser that has seen the app installed, or added to a
// Home Screen, generally agrees. The engine also reads the answer on every
// sync, so the status event carries it.

const AUTOSAVE_META = 'autosave';
let persisted = { state: 'unknown', asked: false };

/** What the browser says about keeping this origin's data. */
export const persistence = () => ({ ...persisted });

const stateOf = (status) => (status === null ? 'unsupported' : status.persisted ? 'persisted' : 'at-risk');

/**
 * Ask to be kept, and remember the answer. Never awaited by anything that
 * matters: a browser that takes its time, or has no opinion, must not hold up
 * a plan appearing on screen.
 */
export async function requestPersistence() {
  try {
    // Already granted is not worth asking again, which in Firefox is a prompt.
    const now = await storageStatus();
    const status = now?.persisted ? now : (now === null ? null : await requestPersistentStorage());
    persisted = { state: stateOf(status), asked: true };
  } catch {
    persisted = { state: 'unknown', asked: true };
  }
  announce();
  return persisted;
}

/** How much this origin is using, when the browser will say. */
export async function storageEstimate() {
  try { return await globalThis.navigator?.storage?.estimate?.() ?? null; } catch { return null; }
}

/**
 * Move the autosave out of localStorage.
 *
 * The old key is left where it is until the new copy has been written *and*
 * read back, because the one thing worse than an autosave in the wrong place
 * is no autosave at all.
 */
async function adoptAutosave() {
  if (!recordStore?.setMeta) return;
  setAutosaveSink(async (plan) => {
    try { await recordStore.setMeta(AUTOSAVE_META, JSON.stringify(plan)); } catch { /* a full disk is not worth a dialog */ }
  });
  const old = readAutosave();
  if (!old) return;
  const here = await recordStore.meta(AUTOSAVE_META);
  if (!here) {
    await recordStore.setMeta(AUTOSAVE_META, JSON.stringify(old));
    const back = await recordStore.meta(AUTOSAVE_META);
    if (!back) return;                       // not written: keep the old one
  }
  clearLocalAutosave();
}

/** The autosave, wherever it now lives. */
export async function readStoredAutosave() {
  if (recordStore?.meta) {
    try {
      const raw = await recordStore.meta(AUTOSAVE_META);
      if (raw) return JSON.parse(raw);
    } catch { /* fall through to the old place */ }
  }
  return readAutosave();
}

/**
 * @param {{ preferStored?: boolean }} opts  preferStored: what is on screen is
 *   only the stand-in shown while the database opened (the sample), so the
 *   stored autosave replaces it — before anything below can edit the stand-in
 *   and write it over the plan that was really being worked on.
 */
export async function initSync({ preferStored = false } = {}) {
  try { settings = { ...settings, ...JSON.parse(read(SETTINGS_KEY, '{}')) }; } catch { /* keep defaults */ }
  // On the Portal the server is the origin this page came from, and the
  // signed-in session is the credential. Off it this is null and nothing
  // changes.
  if (portalApp() === APP_ID) {
    try { portal = portalRemote(APP_ID, await portalSession()); } catch { portal = null; }
  }
  recordStore = await openStore();
  await adoptAutosave();
  if (preferStored && !store.ui.dirty) {
    const stored = await readStoredAutosave();
    if (stored) { try { loadProject(parse(JSON.stringify(stored)).project); } catch { /* keep what is on screen */ } }
  }
  // Asked once a launch, and again whenever sync is switched on.
  void requestPersistence();
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
  // The blocks used to live in each plan. Gather them once, then keep every
  // plan in step with the shared set.
  await seedTimeBlocks();
  await ensureAnySchedule();
  await spreadTimeBlocks();
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

/** Whether edits are being kept by the store on their own — no Save needed. */
export const keepsEdits = () => !!recordStore;

/**
 * Write the open plan into the record store, where a push can find it, and —
 * when sync is on — send it shortly after. This is what "autosaved to the
 * cloud" means: nobody presses anything, and a plan is never only in a tab.
 */
async function commit() {
  if (!doc || adopting || store.project.id !== docPlanId) return;
  // An empty, untitled plan is what every new window starts as. Giving each one
  // a record would put a row on the shelf — and on every other device — for the
  // act of opening the app, so a plan earns its record by having something in it.
  const untouched = store.project.tasks.length === 0
    && !(store.project.events || []).length
    && store.project.name === 'Untitled project'
    && !doc.record.updatedAt;
  // Nothing in it is nothing to lose: an empty new window is not "unsaved".
  if (untouched) { if (store.ui.dirty) markSaved(null); return; }
  const body = serialize(store.project);
  const changed = body !== doc.body || store.project.name !== doc.name;
  if (changed) {
    doc.edit(body, store.project.name);
    await doc.save();
  }
  // In the store is saved: the plan is on this device, and on the others once
  // sync runs. Nothing is left for a Save to do, so nothing asks for one.
  if (store.ui.dirty && store.project.id === docPlanId) markSaved(null);
  if (!changed || !syncConfigured()) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => { void syncNow(); }, AUTOSAVE_MS);
}

/** Save new settings and restart. A changed URL clears both cursors: they belong to the old server. */
export async function applySettings(next) {
  if (next?.enabled && !settings.enabled) void requestPersistence();
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
  let transport = null;
  if (portal) transport = new HttpTransport({ baseUrl: portal.baseUrl, label: portal.workspace, onUnauthorized });
  else if (settings.url) transport = new HttpTransport({ baseUrl: settings.url, token: settings.token, label: WORKSPACE });
  if (!recordStore || !transport) { announce(); return; }
  engine = new SyncEngine(recordStore, transport, deviceId());
  if (syncConfigured()) timer = setInterval(() => { void syncNow(); }, INTERVAL_MS);
  announce();
}

/**
 * The session is gone.
 *
 * Nothing here can mend it — signing in is the Portal's business — so this
 * asks the bar to re-read `/auth/me`, which is what makes it show Sign in.
 */
function onUnauthorized() {
  document.querySelector('sc-portal-bar')?.refresh?.();
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
    // The readout says how many records are here and how many are there; a
    // sync is exactly when that can have changed.
    void storeCounts();
    return result;
  } catch (err) {
    lastStatus = { ...engine.status };
    set({ hint: `Sync failed: ${err.message}` });
    return null;
  }
}

/**
 * Settings handed over by the shell, because this Mac is paired with the
 * toolkit Portal. They are the same two values the dialog holds, so they are
 * applied the same way — including the cursor reset when the server changes.
 * Signed out (two empty strings) switches sync off rather than syncing nowhere.
 */
export async function adoptRemoteSettings({ url, token }) {
  const next = { url: (url || '').trim(), token: (token || '').trim() };
  if (next.url === settings.url && next.token === settings.token) return;
  await applySettings({ ...next, enabled: !!next.url });
}

/** Sync because the plan was just written to a file, if that is switched on. */
export function syncAfterSave() { if (syncConfigured()) void syncNow(); }

/**
 * `File ▸ Save`: put this plan on the server now, and say so. The cloud is
 * where a plan lives; `Save As…` is for taking a copy away to a file.
 */
export async function saveToCloud() {
  // On the Portal there is nothing to configure: the origin is the server.
  if (!portal && !settings.url) return { ok: false, reason: 'not-configured' };
  if (!portal && !settings.enabled) { await applySettings({ ...settings, enabled: true }); }
  await commit();
  const result = await syncNow();
  if (!result) return { ok: false, reason: 'failed', error: syncStatus().lastError };
  markSaved(store.ui.fileName);
  return { ok: true, pushed: result.pushed };
}

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

// ---------------------------------------------------------------- people
//
// One directory of people for every plan. A resource inside a plan still
// carries its own name and rate — a `.project.json` has to stand on its own —
// but it points at a person here, so the same Uma Chen in three plans is one
// person whose hours cannot be promised twice.
//
// People are records like plans are, in the same workspace, so the directory
// travels between devices with everything else.

const PERSON_TYPE = 'person';
const WORKSPACE_TYPE = 'workspace';
const TIMEBLOCK_TYPE = 'timeblock';

// -------------------------------------------------------------- time blocks
//
// The hours you study, the hours you work, the morning you keep for deep work:
// those belong to a week, not to a project. Defining them once per project was
// asking the same question of every plan and getting a different answer.
//
// So the blocks are records, like people and workspaces, and every plan keeps a
// copy of the list so a `.project.json` opened on its own still schedules.
// Editing goes to the records and is written through to every plan.

export async function listTimeBlocks() {
  if (!recordStore) return [];
  const all = await recordStore.all();
  return all
    .filter((r) => r && r.type === TIMEBLOCK_TYPE && !r.deletedAt && r.block)
    .map((r) => ({ ...r.block, id: r.id }))
    // By the clock, not by the text: "6:00" sorts after "18:00" as a string.
    .sort((a, b) => (parseTime(a.from) ?? 0) - (parseTime(b.from) ?? 0) || String(a.name).localeCompare(String(b.name)));
}

/** Write a block — new or changed — and push it into every plan. */
export async function saveTimeBlock(block) {
  if (!recordStore) return null;
  const id = block.id || `tb_${globalThis.crypto?.randomUUID?.().slice(0, 10) || Math.random().toString(36).slice(2, 12)}`;
  const existing = await recordStore.get(id);
  const record = {
    ...(existing || {}), id, type: TIMEBLOCK_TYPE, name: block.name,
    block: { id, name: block.name, from: block.from, to: block.to, days: [...block.days], ...(block.slots?.length ? { slots: block.slots.map((r) => ({ ...r })) } : {}) },
    updatedAt: Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1), deletedAt: null, origin: deviceId(),
  };
  await recordStore.put([record]);
  await spreadTimeBlocks();
  if (syncConfigured()) void syncNow();
  return record.block;
}

/** Several blocks at once — Motion's schedules, say — written, then spread once. */
export async function saveTimeBlocks(blocks) {
  if (!recordStore || !blocks.length) return 0;
  const at = Date.now();
  const records = [];
  for (const [i, block] of blocks.entries()) {
    const existing = await recordStore.get(block.id);
    records.push({
      ...(existing || {}), id: block.id, type: TIMEBLOCK_TYPE, name: block.name,
      block: { id: block.id, name: block.name, from: block.from, to: block.to, days: [...block.days], ...(block.slots?.length ? { slots: block.slots.map((r) => ({ ...r })) } : {}) },
      updatedAt: Math.max(at + i, (existing?.updatedAt ?? 0) + 1), deletedAt: null, origin: deviceId(),
    });
  }
  await recordStore.put(records);
  await spreadTimeBlocks();
  if (syncConfigured()) void syncNow();
  return records.length;
}

/** The schedule every project's tasks use when they name none. */
export async function setDefaultScheduleEverywhere(id) {
  if (!recordStore) return 0;
  const set = (p) => { p.agenda = { ...(p.agenda || {}), timeBlockId: id }; };
  if (store.project.agenda?.timeBlockId !== id) tryCommit('Default schedule', set);
  let n = 0;
  for (const record of await planRecords()) {
    if (record.id === store.project.id) continue;
    let project;
    try { project = parse(record.body).project; } catch { continue; }
    if (project.agenda?.timeBlockId === id) continue;
    set(project);
    await recordStore.put([{ ...record, body: serialize(project), updatedAt: Math.max(Date.now(), record.updatedAt + 1), origin: deviceId() }]);
    n++;
  }
  if (syncConfigured()) void syncNow();
  return n;
}

/** Take a block out. Tasks that used it fall back to the plan's default. */
export async function removeTimeBlockEverywhere(id) {
  if (!recordStore) return false;
  const record = await recordStore.get(id);
  if (!record || record.type !== TIMEBLOCK_TYPE) return false;
  if ((await listTimeBlocks()).length <= 1) return false;
  await recordStore.put([{ ...record, deletedAt: Date.now(), updatedAt: Math.max(Date.now(), record.updatedAt + 1), origin: deviceId() }]);
  await spreadTimeBlocks();
  if (syncConfigured()) void syncNow();
  return true;
}

/** Put the shared list into a plan, keeping what still points at it valid. */
export function applyTimeBlocks(project, list) {
  if (!list.length) return false;
  const before = JSON.stringify(project.timeBlocks || []);
  project.timeBlocks = list.map((b) => ({ ...b, days: [...b.days], ...(b.slots ? { slots: b.slots.map((r) => ({ ...r })) } : {}) }));
  const ids = new Set(list.map((b) => b.id));
  for (const t of project.tasks) {
    if (t.calendar?.timeBlockId && !ids.has(t.calendar.timeBlockId)) t.calendar = { ...t.calendar, timeBlockId: null };
  }
  if (project.agenda?.timeBlockId && !ids.has(project.agenda.timeBlockId)) {
    project.agenda = { ...project.agenda, timeBlockId: list[0].id };
  }
  return JSON.stringify(project.timeBlocks) !== before;
}

/** The shared list, into the open plan and every plan on the shelf. */
export async function spreadTimeBlocks() {
  const list = await listTimeBlocks();
  if (!list.length) return;
  // Asked of a copy: the open plan changes only through a commit, or it is
  // changed without being marked, and the commit after finds nothing to do.
  if (applyTimeBlocks(JSON.parse(JSON.stringify(store.project)), list)) {
    tryCommit('Time blocks', (p) => { applyTimeBlocks(p, list); });
  }
  for (const record of await planRecords()) {
    if (record.id === store.project.id) continue;
    let project;
    try { project = parse(record.body).project; } catch { continue; }
    if (!applyTimeBlocks(project, list)) continue;
    await recordStore.put([{ ...record, body: serialize(project), updatedAt: Math.max(Date.now(), record.updatedAt + 1), origin: deviceId() }]);
  }
}

/**
 * First run: the blocks live in the plans, so collect them into records.
 *
 * Every plan's blocks are taken, keyed by id, so the ones a plan invented —
 * Study, Late day study, Weekend — survive the move rather than being lost to
 * whichever plan happened to be open.
 */
/**
 * "Any": every day, 8 am to 9 pm — the schedule a task uses when it names
 * none, in every project. Made when missing (unless it was deleted on
 * purpose), and made every project's default once, on each device; after
 * that the default is whatever Settings ▸ Schedules says.
 */
const ANY_HOURS = { from: '08:00', to: '21:00' };
const ANY_DEFAULT_KEY = 'project-planner:any-default-v2';
async function ensureAnySchedule() {
  if (!recordStore) return;
  const days = [0, 1, 2, 3, 4, 5, 6];
  const fresh = { id: 'tb_any', name: 'Any', ...ANY_HOURS, days, slots: days.map((day) => ({ day, ...ANY_HOURS })) };
  const record = await recordStore.get('tb_any');
  // The first Any (5:30 am – 11 pm, Motion's hours) was never chosen by anyone: it becomes 8 am – 9 pm.
  const first = record?.block && slotsOf(record.block).every((r) => r.from === '05:30' && r.to === '23:00');
  if (!record || (first && !record.deletedAt)) await saveTimeBlocks([fresh]);
  else if (record.deletedAt) return;
  let done = false;
  try { done = localStorage.getItem(ANY_DEFAULT_KEY) === '1'; } catch { /* private mode */ }
  if (done) return;
  await setDefaultScheduleEverywhere('tb_any');
  try { localStorage.setItem(ANY_DEFAULT_KEY, '1'); } catch { /* private mode */ }
}

async function seedTimeBlocks() {
  if (!recordStore) return;
  if ((await listTimeBlocks()).length) return;
  const seen = new Map();
  const take = (project) => { for (const b of project.timeBlocks || []) if (b?.id && !seen.has(b.id)) seen.set(b.id, b); };
  take(store.project);
  for (const record of await planRecords()) {
    try { take(parse(record.body).project); } catch { /* unreadable */ }
  }
  if (!seen.size) return;
  const at = Date.now();
  await recordStore.put([...seen.values()].map((b, i) => ({
    id: b.id, type: TIMEBLOCK_TYPE, name: b.name,
    block: { id: b.id, name: b.name, from: b.from, to: b.to, days: [...b.days], ...(b.slots?.length ? { slots: b.slots.map((r) => ({ ...r })) } : {}) },
    updatedAt: at + i, deletedAt: null, origin: deviceId(),
  })));
  await spreadTimeBlocks();
  if (syncConfigured()) void syncNow();
}


// ------------------------------------------------------------- workspaces
//
// Work, personal and school are different lives that happen to use the same
// tool. Keeping them apart is not a filing preference: a Saturday spent on a
// course should not read as capacity for a customer's job, and a customer's
// deadline has no business in a personal week. So a plan belongs to a
// workspace, and the Projects screen, All Tasks, the calendar and what a
// person is carrying all follow whichever one is in front.
//
// A workspace is a record like a plan or a person, so it travels with them.
// Which one is open is this device's own business, and stays in localStorage.

const WORKSPACE_KEY = 'project-planner:workspace';
/** The workspace on screen. '' is all of them at once. */
export const activeWorkspace = () => read(WORKSPACE_KEY, '');
export function setActiveWorkspace(id) {
  write(WORKSPACE_KEY, id || '');
  set({});
}

/** The workspaces last read, for what has to know one without waiting (a new task's default assignee). */
let workspacesKnown = [];
export const workspaceNow = (id) => (id ? workspacesKnown.find((w) => w.id === id) || null : null);

export async function listWorkspaces() {
  if (!recordStore) return [];
  const all = await recordStore.all();
  workspacesKnown = all
    .filter((r) => r && r.type === WORKSPACE_TYPE && !r.deletedAt && r.name)
    // In the order they were dragged into, then by name.
    .sort((a, b) => (Number.isFinite(a.order) ? a.order : Infinity) - (Number.isFinite(b.order) ? b.order : Infinity) || String(a.name).localeCompare(String(b.name)));
  return workspacesKnown;
}

/** Give every open, unassigned task of a workspace's projects to `who`; how many it gave. */
export async function assignUnassigned(workspaceId, who) {
  if (!who?.name) return 0;
  const { assign, addResource, isSummary } = await import('../model/model.js');
  const norm = (s) => String(s || '').trim().toLowerCase();
  let n = 0;
  for (const s of await listPlans()) {
    if (s.workspaceId !== workspaceId || s.template) continue;
    await patchPlan(s.id, (p) => {
      const open = p.tasks.filter((t, i) => !isSummary(p, i) && !t.milestone && !t.archived && (t.percent ?? 0) < 100 && !t.assignments.length);
      if (!open.length) return;
      const r = p.resources.find((x) => (who.personId && x.personId === who.personId) || norm(x.name) === norm(who.name)) || addResource(p, { name: who.name, personId: who.personId || null });
      for (const t of open) { assign(p, t.id, r.id, 1); n++; }
    }, 'Assign unassigned tasks');
  }
  return n;
}

/** Who a workspace's new tasks go to unless someone else is named: { personId, name }, or null. */
export async function setWorkspaceAssignee(id, person) {
  const done = await patchWorkspace(id, (w) => { w.defaultAssignee = person && person.name ? { personId: person.personId || null, name: person.name } : null; });
  await listWorkspaces();
  return done;
}

/** Workspaces in a new order, top to bottom — kept in their records, so every device shows it. */
export async function arrangeWorkspaces(ids) {
  if (!recordStore) return;
  const at = Date.now();
  const changed = [];
  for (const [i, id] of ids.entries()) {
    const record = await recordStore.get(id);
    if (!record || record.type !== WORKSPACE_TYPE || record.order === (i + 1) * 10) continue;
    changed.push({ ...record, order: (i + 1) * 10, updatedAt: Math.max(at, record.updatedAt + 1), origin: deviceId() });
  }
  if (changed.length) await recordStore.put(changed);
  if (syncConfigured()) void syncNow();
}

export async function createWorkspace(name) {
  if (!recordStore) return null;
  const clean = String(name || '').trim();
  if (!clean) return null;
  const known = (await listWorkspaces()).find((w) => String(w.name).trim().toLowerCase() === clean.toLowerCase());
  if (known) return known;
  const record = {
    id: `ws_${globalThis.crypto?.randomUUID?.().slice(0, 12) || Math.random().toString(36).slice(2, 14)}`,
    type: WORKSPACE_TYPE, name: clean, updatedAt: Date.now(), deletedAt: null, origin: deviceId(),
  };
  await recordStore.put([record]);
  if (syncConfigured()) void syncNow();
  return record;
}

export async function renameWorkspace(id, name) {
  if (!recordStore) return false;
  const record = await recordStore.get(id);
  if (!record || record.type !== WORKSPACE_TYPE) return false;
  const clean = String(name || '').trim();
  if (!clean) return false;
  await recordStore.put([{ ...record, name: clean, updatedAt: Math.max(Date.now(), record.updatedAt + 1), origin: deviceId() }]);
  if (syncConfigured()) void syncNow();
  return true;
}

/** Remove a workspace. Its plans are kept and become unfiled, never deleted. */
export async function deleteWorkspace(id) {
  if (!recordStore) return false;
  const record = await recordStore.get(id);
  if (!record || record.type !== WORKSPACE_TYPE) return false;
  for (const plan of await planRecords()) {
    let project;
    try { project = parse(plan.body).project; } catch { continue; }
    if (project.workspaceId !== id) continue;
    await setPlanWorkspace(plan.id, null);
  }
  await recordStore.put([{ ...record, deletedAt: Date.now(), updatedAt: Math.max(Date.now(), record.updatedAt + 1), origin: deviceId() }]);
  if (activeWorkspace() === id) setActiveWorkspace('');
  if (syncConfigured()) void syncNow();
  return true;
}

/**
 * Pin a plan to the top of the shelf, or unpin it.
 *
 * The shelf used to be ordered by what changed last, which meant opening a
 * project moved it — the list rearranged itself under the pointer as you
 * clicked. Order is by name now, and pinning is how something is deliberately
 * kept at the top rather than by accident of being touched.
 */
export const setPlanPinned = (id, on) =>
  patchPlan(id, (project) => { project.pinned = !!on; }, on ? 'Pin to the top' : 'Unpin');

/** File a plan under a workspace, or take it out of one with null. It leaves any folder it was in. */
export const setPlanWorkspace = (id, workspaceId) =>
  patchPlan(id, (project) => { project.workspaceId = workspaceId || null; project.folderId = null; }, 'Move to a workspace');

/** Put a plan in a workspace and a folder of it (null for none). */
export const setPlanFolder = (id, workspaceId, folderId) =>
  patchPlan(id, (project) => { project.workspaceId = workspaceId || null; project.folderId = (workspaceId && folderId) || null; }, 'Move to a folder');

/**
 * The sidebar order of the plans in one place (a workspace, or a folder of
 * one), top to bottom, written into the plans so every device shows it; a
 * plan dragged in from elsewhere is moved there too. Only plans whose place
 * or position changed are written.
 */
export async function arrangePlans(ids, workspaceId, folderId = null) {
  const summaries = new Map((await listPlans()).map((s) => [s.id, s]));
  for (const [i, id] of ids.entries()) {
    const s = summaries.get(id);
    if (!s) continue;
    const order = (i + 1) * 10;
    const ws = workspaceId || null;
    const folder = (ws && folderId) || null;
    if (s.sortOrder === order && (s.workspaceId || null) === ws && (s.folderId || null) === folder) continue;
    await patchPlan(id, (project) => { project.sortOrder = order; project.workspaceId = ws; project.folderId = folder; }, 'Arrange projects');
  }
}

// ----------------------------------------------------------------- folders
//
// A workspace's folders are part of its record, in the order they are shown,
// so they travel with it. A plan says which folder it is in.

async function patchWorkspace(id, change) {
  if (!recordStore) return null;
  const record = await recordStore.get(id);
  if (!record || record.type !== WORKSPACE_TYPE) return null;
  const next = { ...record, folders: Array.isArray(record.folders) ? record.folders.map((f) => ({ ...f })) : [] };
  change(next);
  await recordStore.put([{ ...next, updatedAt: Math.max(Date.now(), record.updatedAt + 1), origin: deviceId() }]);
  if (syncConfigured()) void syncNow();
  return next;
}

/**
 * Two workspaces become one: every project of `fromId` moves into `intoId`,
 * each folder going into the target's folder of the same name (made if it is
 * not there), and `fromId`, empty, is deleted.
 */
export async function mergeWorkspaces(fromId, intoId, choices = {}) {
  if (!recordStore || !fromId || !intoId || fromId === intoId) return 0;
  const from = await recordStore.get(fromId);
  if (!from || from.type !== WORKSPACE_TYPE) return 0;
  const norm = (s) => String(s || '').trim().toLowerCase();
  // Folders: choices.folders[id] is a target folder's id, 'new', or 'none';
  // unsaid, a folder joins the target's of the same name, or is made there.
  const map = new Map();
  // As one folder: every project goes into a folder of the target named
  // choices.asFolder (the workspace's own name, usually), made if missing.
  let single = null;
  if (choices.asFolder) {
    const into = await recordStore.get(intoId);
    const same = foldersOf(into).find((x) => norm(x.name) === norm(choices.asFolder));
    single = same ? same.id : (await createFolder(intoId, choices.asFolder))?.id || null;
  }
  for (const f of choices.asFolder ? [] : foldersOf(from)) {
    const pick = choices.folders?.[f.id];
    const into = await recordStore.get(intoId);
    const same = foldersOf(into).find((x) => norm(x.name) === norm(f.name));
    if (pick === 'none') map.set(f.id, null);
    else if (pick && pick !== 'new') map.set(f.id, pick);
    else if (!pick && same) map.set(f.id, same.id);
    else map.set(f.id, (await createFolder(intoId, f.name))?.id || null);
  }
  const { mapStatus, mapLabel } = await import('../model/model.js');
  const statuses = Object.entries(choices.statuses || {}).filter(([a, b]) => b && a !== b);
  const labels = Object.entries(choices.labels || {}).filter(([a, b]) => a !== b);
  let moved = 0;
  for (const s of await listPlans()) {
    if (s.workspaceId !== fromId) continue;
    const folderId = single || (s.folderId ? map.get(s.folderId) || null : null);
    await patchPlan(s.id, (p) => {
      p.workspaceId = intoId;
      p.folderId = folderId;
      for (const [a, b] of statuses) mapStatus(p, a, b);
      for (const [a, b] of labels) mapLabel(p, a, b);
    }, 'Merge workspaces');
    moved++;
  }
  await deleteWorkspace(fromId);
  if (activeWorkspace() === fromId) setActiveWorkspace(intoId);
  return moved;
}

export const foldersOf = (workspace) => (Array.isArray(workspace?.folders) ? workspace.folders.filter((f) => f && f.id && f.name) : []);

export async function createFolder(workspaceId, name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const folder = { id: `fd_${Math.random().toString(36).slice(2, 12)}`, name: clean };
  return (await patchWorkspace(workspaceId, (w) => { w.folders.push(folder); })) ? folder : null;
}

export const renameFolder = (workspaceId, folderId, name) => {
  const clean = String(name || '').trim();
  if (!clean) return Promise.resolve(null);
  return patchWorkspace(workspaceId, (w) => { const f = w.folders.find((x) => x.id === folderId); if (f) f.name = clean; });
};

/** Folders of a workspace in a new order (ids top to bottom). */
export const arrangeFolders = (workspaceId, ids) =>
  patchWorkspace(workspaceId, (w) => { w.folders.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); });

/** Remove a folder. Its plans stay in the workspace, outside any folder. */
export async function deleteFolder(workspaceId, folderId) {
  for (const s of await listPlans()) if (s.folderId === folderId) await setPlanFolder(s.id, workspaceId, null);
  return patchWorkspace(workspaceId, (w) => { w.folders = w.folders.filter((f) => f.id !== folderId); });
}

/** Whether a plan belongs in the workspace on screen. '' shows everything. */
export function inActiveWorkspace(project) {
  const active = activeWorkspace();
  if (!active) return true;
  return (project?.workspaceId || null) === active;
}


export async function listPeople() {
  if (!recordStore) return [];
  const all = await recordStore.all();
  return all
    .filter((r) => r && r.type === PERSON_TYPE && !r.deletedAt && r.name)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** Put someone in the directory, or find them if they are already in it. */
export async function rememberPerson({ name, initials = '', type = 'work', rate = 0, group = '' }) {
  if (!recordStore) return null;
  const clean = String(name || '').trim();
  if (!clean) return null;
  const known = (await listPeople()).find((p) => String(p.name).trim().toLowerCase() === clean.toLowerCase());
  if (known) return known;
  const record = {
    id: `person_${globalThis.crypto?.randomUUID?.().slice(0, 12) || Math.random().toString(36).slice(2, 14)}`,
    type: PERSON_TYPE, name: clean, initials, resourceType: type, rate: Number(rate) || 0, group,
    updatedAt: Date.now(), deletedAt: null, origin: deviceId(),
  };
  await recordStore.put([record]);
  if (syncConfigured()) void syncNow();
  return record;
}

/**
 * Change a person once, everywhere.
 *
 * The directory is the record of who someone is, but each plan carries its own
 * copy of the name and the rate so a `.project.json` still opens on its own.
 * Centralised means those copies are not separate truths: an edit here is
 * written through to every plan on the shelf that uses them, and to the open
 * plan in memory.
 */
export async function updatePerson(id, patch) {
  if (!recordStore) return null;
  const record = await recordStore.get(id);
  if (!record || record.type !== PERSON_TYPE) return null;
  const next = {
    ...record,
    ...('name' in patch ? { name: String(patch.name).trim() || record.name } : {}),
    ...('initials' in patch ? { initials: String(patch.initials).trim().toUpperCase().slice(0, 4) } : {}),
    ...('resourceType' in patch ? { resourceType: patch.resourceType } : {}),
    ...('rate' in patch ? { rate: Number(patch.rate) || 0 } : {}),
    ...('group' in patch ? { group: String(patch.group).trim() } : {}),
    ...('team' in patch ? { team: String(patch.team).trim() } : {}),
    ...('role' in patch ? { role: String(patch.role).trim() } : {}),
    ...('email' in patch ? { email: String(patch.email).trim() } : {}),
    ...('profile' in patch ? { profile: patch.profile } : {}),
    updatedAt: Math.max(Date.now(), record.updatedAt + 1), origin: deviceId(),
  };
  await recordStore.put([next]);
  await writeThrough(next);
  if (syncConfigured()) void syncNow();
  return next;
}

/** Push a person's details into every plan that uses them. */
async function writeThrough(person) {
  const fields = (r) => ({ ...r, name: person.name, initials: person.initials || r.initials, type: person.resourceType || r.type, rate: person.rate ?? r.rate, group: person.group ?? r.group });

  // The open plan, through the store, so the screen follows at once.
  if (store.project.resources.some((r) => r.personId === person.id)) {
    tryCommit('Update a person', (p) => {
      p.resources = p.resources.map((r) => (r.personId === person.id ? fields(r) : r));
    });
  }

  for (const record of await planRecords()) {
    if (record.id === store.project.id) continue;
    let project;
    try { project = parse(record.body).project; } catch { continue; }
    if (!project.resources.some((r) => r.personId === person.id)) continue;
    project.resources = project.resources.map((r) => (r.personId === person.id ? fields(r) : r));
    const at = Math.max(Date.now(), record.updatedAt + 1);
    await recordStore.put([{ ...record, body: serialize(project), updatedAt: at, origin: deviceId() }]);
  }
}

/**
 * Attach a Profiler profile to someone in the directory.
 *
 * Profiler owns stakeholder profiles; this keeps the summary so the People
 * screen can show who someone is next to what they are carrying. `team` and
 * `role` come across too, because Profiler's subject has them and a planner
 * would otherwise type them twice.
 */
export async function attachProfile(id, text) {
  const profile = readProfile(text);
  const patch = { profile };
  if (profile.team) patch.team = profile.team;
  if (profile.role) patch.role = profile.role;
  return updatePerson(id, patch);
}

/** Forget the attached profile. Profiler still has it; this stops showing it. */
export const detachProfile = (id) => updatePerson(id, { profile: null });

/**
 * Everyone in the directory, with what they are carrying across every plan:
 * which plans, how many tasks, how many hours.
 */
export async function peopleWithLoad() {
  const people = await listPeople();
  const byPerson = new Map(people.map((p) => [p.id, { person: p, plans: [], tasks: 0, hours: 0, cost: 0 }]));
  const loose = new Map();
  const seen = [];

  // A plan written before the directory existed carries a name and no link. The
  // same spelling is the same person, or the screen would show Uma Chen twice
  // and promise her hours twice.
  const byName = new Map(people.map((p) => [String(p.name).trim().toLowerCase(), p]));

  const count = (project, schedule, planName) => {
    for (const r of project.resources) {
      const matched = r.personId ? byPerson.get(r.personId) : byPerson.get(byName.get(String(r.name).trim().toLowerCase())?.id);
      const entry = matched;
      const bucket = entry || loose.get(`who:${r.name.toLowerCase()}`) || { person: { id: null, name: r.name, initials: r.initials, resourceType: r.type, rate: r.rate, group: r.group }, plans: [], tasks: 0, hours: 0, cost: 0 };
      if (!entry) loose.set(`who:${r.name.toLowerCase()}`, bucket);
      let tasks = 0, hours = 0;
      for (const t of project.tasks) {
        const info = schedule.tasks[t.id];
        if (!info || info.summary) continue;
        const share = info.workShares?.get(r.id);
        if (share === undefined) continue;
        tasks++;
        hours += share;
      }
      if (!tasks && !project.tasks.some((t) => t.assignments.some((a) => a.resourceId === r.id))) {
        if (!bucket.plans.includes(planName)) bucket.plans.push(planName);
        continue;
      }
      bucket.tasks += tasks;
      bucket.hours += hours;
      bucket.cost += hours * (r.rate || 0);
      if (!bucket.plans.includes(planName)) bucket.plans.push(planName);
    }
  };

  count(store.project, store.schedule, store.project.name);
  seen.push(store.project.id);
  for (const record of await planRecords()) {
    if (seen.includes(record.id)) continue;
    try {
      const project = parse(record.body).project;
      // An archived plan's hours are history, not what someone is carrying.
      // Every workspace counts: a person's week is all of it.
      if (!isLiveWork(project)) continue;
      count(project, computeSchedule(project), project.name || record.name);
    } catch { /* a plan that cannot be read adds nothing */ }
  }
  return [...byPerson.values(), ...loose.values()].sort((a, b) => String(a.person.name).localeCompare(String(b.person.name)));
}

/**
 * Point every plan's resources at the directory, by name.
 *
 * Plans made before a person was in the directory name them and nothing more.
 * This is the one-off that turns those names into links, so an edit in one
 * place reaches them. Only an exact name match is linked — a near miss is a
 * judgement call, and guessing would merge two different people.
 *
 * @returns {{ linked: number, plans: number }}
 */
export async function linkPlansToDirectory() {
  if (!recordStore) return { linked: 0, plans: 0 };
  const byName = new Map((await listPeople()).map((p) => [String(p.name).trim().toLowerCase(), p]));
  const match = (r) => (r.personId ? null : byName.get(String(r.name).trim().toLowerCase()) || null);
  let linked = 0;
  let plans = 0;

  const open = store.project.resources.filter((r) => match(r));
  if (open.length) {
    plans++;
    linked += open.length;
    tryCommit('Link people to the directory', (p) => {
      p.resources = p.resources.map((r) => { const who = match(r); return who ? { ...r, personId: who.id } : r; });
    });
  }

  for (const record of await planRecords()) {
    if (record.id === store.project.id) continue;
    let project;
    try { project = parse(record.body).project; } catch { continue; }
    const hits = project.resources.filter((r) => match(r));
    if (!hits.length) continue;
    project.resources = project.resources.map((r) => { const who = match(r); return who ? { ...r, personId: who.id } : r; });
    const at = Math.max(Date.now(), record.updatedAt + 1);
    await recordStore.put([{ ...record, body: serialize(project), updatedAt: at, origin: deviceId() }]);
    plans++;
    linked += hits.length;
  }
  if (linked && syncConfigured()) void syncNow();
  return { linked, plans };
}

/** How many plan resources name someone in the directory without pointing at them. */
export async function unlinkedCount() {
  if (!recordStore) return 0;
  const byName = new Map((await listPeople()).map((p) => [String(p.name).trim().toLowerCase(), p]));
  const count = (project) => project.resources.filter((r) => !r.personId && byName.has(String(r.name).trim().toLowerCase())).length;
  let n = count(store.project);
  for (const record of await planRecords()) {
    if (record.id === store.project.id) continue;
    try { n += count(parse(record.body).project); } catch { /* unreadable */ }
  }
  return n;
}

/**
 * Two people who are one: in every plan, whoever is `drop` becomes `keep` —
 * by directory link, or by name where a plan never linked them — and where a
 * plan has both, their work is joined (model.mergeResources). `drop` then
 * leaves the directory. Each is { id?, name, initials? }.
 */
export async function mergePeople(keep, drop) {
  if (!recordStore) return 0;
  const norm = (s) => String(s || '').trim().toLowerCase();
  const isKeep = (r) => (keep.id ? r.personId === keep.id : false) || (!r.personId && norm(r.name) === norm(keep.name));
  const isDrop = (r) => (drop.id ? r.personId === drop.id : false) || (!r.personId && norm(r.name) === norm(drop.name));
  const { mergeResources } = await import('../model/model.js');
  const change = (p) => {
    const drops = p.resources.filter((r) => isDrop(r) && !isKeep(r));
    let kept = p.resources.find(isKeep) || null;
    for (const d of drops) {
      if (!kept) { kept = d; continue; }
      mergeResources(p, kept.id, d.id);
    }
    if (kept) {
      kept.personId = keep.id || kept.personId || null;
      kept.name = keep.name;
      if (keep.initials) kept.initials = keep.initials;
    }
  };
  let plans = 0;
  for (const record of await planRecords()) {
    let project;
    try { project = parse(record.body).project; } catch { continue; }
    // Plans with the other one, and plans naming this one without the link to the directory.
    if (!project.resources.some((r) => (isDrop(r) && !isKeep(r)) || (keep.id && isKeep(r) && r.personId !== keep.id))) continue;
    await patchPlan(record.id, change, 'Merge people');
    plans++;
  }
  if (drop.id && drop.id !== keep.id) await forgetPerson(drop.id);
  return plans;
}

/** Take someone out of the directory. Plans that already use them are untouched. */
export async function forgetPerson(id) {
  if (!recordStore) return;
  const record = await recordStore.get(id);
  if (!record) return;
  const at = Math.max(Date.now(), record.updatedAt + 1);
  await recordStore.put([{ ...record, deletedAt: at, updatedAt: at, origin: deviceId() }]);
  if (syncConfigured()) void syncNow();
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
    template: project.template === true,
    pinned: project.pinned === true,
    workspaceId: project.workspaceId || null,
    colour: Number.isFinite(project.colour) ? project.colour : null,
    folderId: project.folderId || null,
    docs: (Array.isArray(project.docs) ? project.docs : []).map((d) => ({ id: d.id, kind: d.kind, title: d.title })),
    sortOrder: Number.isFinite(project.sortOrder) ? project.sortOrder : null,
    archived: project.archived === true,
    archivedAt: project.archivedAt || null,
    onCalendar: project.tasks.filter((t) => t.calendar?.show).length,
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
    .map(planSummary)
    // Pinned first, then by name. Never by what was touched last: a list that
    // rearranges itself as you open things is a list you cannot point at.
    .sort((a, b) => (b.pinned === true) - (a.pinned === true) || String(a.name).localeCompare(String(b.name)));
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

/** A plan on the shelf, read without opening it. Null when it cannot be read. */
export async function readPlan(id) {
  const record = recordStore && await recordStore.get(id);
  if (!record || record.deletedAt) return null;
  try { return parse(record.body).project; } catch { return null; }
}

/** Put a plan on the shelf without opening it — a template, or an imported project. */
export async function storePlan(project) { return saveTemplatePlan(project); }
export async function saveTemplatePlan(project) {
  if (!recordStore) { set({ hint: 'Templates live on the shelf, which is not open yet.' }); return false; }
  const at = Date.now();
  await recordStore.put([{ id: project.id, type: 'document', format: 'project-planner', name: project.name, body: serialize(project), updatedAt: at, deletedAt: null, origin: deviceId() }]);
  if (syncConfigured()) void syncNow();
  return true;
}

/** Open a plan made here — by the new-project wizard — and put it on the shelf. */
export async function startPlan(project) {
  loadProject(project, null);
  markSaved(null);
  await openDocument();
  if (syncConfigured()) void syncNow();
  return project;
}

/**
 * Copy a plan. `asTemplate` keeps the shape and drops the history: nobody's
 * progress, nobody's logged hours, and no dates pinned to a project that has
 * already happened — which is what makes an old plan usable as a starting
 * point rather than a thing to correct.
 */
export async function duplicatePlan(id, { asTemplate = false, name } = {}) {
  if (!recordStore) return null;
  const record = await recordStore.get(id);
  if (!record) return null;
  let project;
  try { project = parse(record.body).project; } catch { set({ hint: 'That plan could not be read.' }); return null; }

  project.id = uid('plan');
  project.name = name || `${project.name}${asTemplate ? ' (template)' : ' (copy)'}`;
  if (asTemplate) {
    freshCopy(project, today());
    // A template is a pattern, not this week's work. Left on the shared
    // calendar it books hours twice: once for the plan and once for its copy.
    project.template = true;
  }
  loadProject(project, null);
  markSaved(null);
  await openDocument();
  if (syncConfigured()) void syncNow();
  return project;
}

/**
 * Whether a plan counts as work in hand.
 *
 * A template is a pattern to copy and an archived plan is finished or shelved.
 * Neither is anyone's current work, so neither belongs on the calendar, in All
 * Tasks, or in what a person is carrying. Both are kept in full.
 */
export const isCurrentWork = (project) => isLiveWork(project) && inActiveWorkspace(project);

/**
 * Live work, whatever workspace is in front: not a template, not archived.
 * The calendar and a person's load use this. A workspace narrows the lists
 * of projects and tasks, but a week has one set of hours in it — a meeting
 * filed under Work still takes the evening a Personal task wanted, and
 * switching workspace must not make it vanish or let something be laid on
 * top of it.
 */
export const isLiveWork = (project) => !project?.template && !project?.archived;

/**
 * Archive a plan, or bring it back.
 *
 * Archiving is not deleting: the plan keeps every task, every assignment and
 * every logged hour, and it stays on the shelf and in sync. It simply stops
 * being counted among the work in hand, which is what someone means when a
 * project is over but its record still matters.
 */
export async function setPlanArchived(id, on) {
  const stamp = on ? today() : null;
  return patchPlan(id, (project) => {
    project.archived = !!on;
    project.archivedAt = stamp;
    // Archived work stops asking for hours in anyone's week.
    if (on) for (const t of project.tasks) if (t.calendar?.show) t.calendar = { ...t.calendar, show: false };
  }, on ? 'Archive' : 'Bring back from the archive');
}

/**
 * Change a plan wherever it is: the open one through the store so the screen
 * follows, any other through its record on the shelf.
 */
export async function patchPlan(id, change, label) {
  if (!recordStore) return false;
  if (id === store.project.id) {
    tryCommit(label, (p) => change(p));
    await openDocument();
    if (syncConfigured()) void syncNow();
    return true;
  }
  const record = await recordStore.get(id);
  if (!record) return false;
  let project;
  try { project = parse(record.body).project; } catch { return false; }
  change(project);
  await recordStore.put([{ ...record, body: serialize(project), updatedAt: Math.max(Date.now(), record.updatedAt + 1), origin: deviceId() }]);
  if (syncConfigured()) void syncNow();
  return true;
}

/**
 * Mark a plan as a template, or stop it being one.
 *
 * A template is a shape to copy. Its tasks are not hours anyone is spending,
 * so they stay off the shared calendar however many of them were released
 * before it became one.
 */
export async function setPlanTemplate(id, on) {
  return patchPlan(id, (project) => {
    project.template = !!on;
    if (on) for (const t of project.tasks) if (t.calendar?.show) t.calendar = { ...t.calendar, show: false };
  }, on ? 'Mark as a template' : 'No longer a template');
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
