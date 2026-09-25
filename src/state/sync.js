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
import { store, set, loadProject, markSaved, subscribe, revision, tryCommit } from './store.js';
import { uid } from '../util.js';
import { today } from '../model/calendar.js';
import { serialize, parse } from '../io/json.js';
import { computeSchedule } from '../model/schedule.js';
import { readProfile } from '../io/profile.js';

export const WORKSPACE = 'project';
const SETTINGS_KEY = 'project-planner:sync';
const DEVICE_KEY = 'project-planner:deviceId';
/** How often a configured, enabled sync runs by itself. */
const INTERVAL_MS = 30_000;
/** How long after the last edit the plan is written to the record store. */
const COMMIT_MS = 800;
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
    && store.project.name === 'Untitled project'
    && !doc.record.updatedAt;
  if (untouched) return;
  const body = serialize(store.project);
  if (body === doc.body && store.project.name === doc.name) return;
  doc.edit(body, store.project.name);
  await doc.save();
  if (!syncConfigured()) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => { void syncNow(); }, AUTOSAVE_MS);
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
  if (!settings.url) return { ok: false, reason: 'not-configured' };
  if (!settings.enabled) { await applySettings({ ...settings, enabled: true }); }
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
    project.start = today();
    project.statusDate = null;
    project.timesheets = [];
    for (const t of project.tasks) {
      t.percent = 0;
      t.stageId = null;
      t.deadline = null;
      // A date pinned to last quarter would drag the whole copy back with it.
      if (t.constraint?.date) t.constraint = { type: 'ASAP', date: null };
    }
  }
  loadProject(project, null);
  markSaved(null);
  await openDocument();
  if (syncConfigured()) void syncNow();
  return project;
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
