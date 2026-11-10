// Google Calendar from inside the app, through the sync server.
//
// The reconciliation is model/gcal.js — the same code the MCP runs. What is
// here is the app's plumbing around it: Google reached through the sync
// server (which holds the person's connected account and, when they granted
// it, the right to write events), the shelf's live plans with their
// schedules, the writes into plans (the open one through a commit, the rest
// through their records), and the quiet read-back that runs while the
// Calendar or Agenda is open so a block dragged in Google moves its task
// here within minutes.
//
// Two ways in. `planSync` works out everything a run would do and hands it
// to the Sync dialog (ui/gcalsync.js), which shows it and asks about the
// proposals; `applySync` then writes both sides. `readBack` applies only
// what the calendar did to linked events — no pushes, no proposals, no
// questions — which is what may happen without a person looking.

import { store, tryCommit } from './store.js';
import { serverFetch, serverOrigin, patchPlan, syncConfigured } from './sync.js';
import { toDay, fromDay } from '../model/calendar.js';
import { linksOf, getTask } from '../model/model.js';
import {
  HORIZON_DAYS, LOOKBACK_DAYS, PROP_PLAN, PROP_TASK,
  windowOf, reconcile, applyToPlan, recordLink, toGoogleEvent, fromGoogleEvent, describeActions,
  matchPlanCalendars, calendarIdsByPlanName, readBackActions, countOf,
} from '../model/gcal.js';

/** The server-side grant that lets the app write events. */
export const WRITE_FEATURE = 'calendar-write';
/** How often the quiet read-back runs while the calendar is open. */
export const READ_BACK_MS = 5 * 60 * 1000;

const dayMs = (iso) => new Date(`${iso}T00:00:00`).getTime();
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// ------------------------------------------------------------ the account

/**
 * Where the app stands with Google: the server it reaches, the accounts
 * connected there (with what each was granted), the calendars they hold.
 * `reason` says what is missing, in the order the dialog should raise it.
 */
export async function googleStatus() {
  if (!serverOrigin()) return { reason: 'no-server', accounts: [], calendars: [], writer: null };
  const res = await serverFetch('/connect');
  if (res.status === 401) return { reason: 'not-signed-in', accounts: [], calendars: [], writer: null };
  if (!res.ok) throw new Error(`The server could not list connections (${res.status}).`);
  const { providers } = await res.json();
  const google = (providers || []).find((p) => p.id === 'google') || { configured: false, accounts: [] };
  if (!google.configured) return { reason: 'not-configured', accounts: [], calendars: [], writer: null };
  const accounts = google.accounts || [];
  if (!accounts.length) return { reason: 'not-connected', accounts, calendars: [], writer: null };
  const calRes = await serverFetch('/calendar/google/calendars');
  const { calendars = [] } = calRes.ok ? await calRes.json() : {};
  const writer = accounts.find((a) => (a.features || []).includes(WRITE_FEATURE)) || null;
  // Only a writing account's calendars are plan calendars: the others cannot take an event.
  const mine = writer ? calendars.filter((c) => c.account === writer.id) : [];
  return { reason: writer ? null : 'not-granted', accounts, calendars: mine, allCalendars: calendars, writer };
}

/** The Calendar API, as the model expects it, over the sync server. */
export class ServerCalendar {
  constructor(account) {
    this.account = account;
    this.timeZone = timeZone();
  }
  async call(method, path, body) {
    const res = await serverFetch(path, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (res.ok) return res.status === 204 ? null : res.json();
    const text = await res.text().catch(() => '');
    let error = text;
    try { error = JSON.parse(text).error || text; } catch { /* plain */ }
    if (error === 'reconnect') throw new Error('Google no longer honours this connection. Connect the account again in Settings ▸ Calendars.');
    if (error === 'not-granted') throw new Error('This Google account was connected for reading only. Allow writing to make and move events.');
    throw new Error(`Google Calendar ${method} failed (${res.status}): ${String(error).slice(0, 200)}`);
  }
  /** Every event between two instants, in the Calendar API's own shape (model/gcal.js fromGoogleEvent reads it). */
  async listEvents(calendarId, fromMs, toMs) {
    const q = new URLSearchParams({ account: this.account, calendar: calendarId, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() });
    const { events = [] } = await this.call('GET', `/calendar/google/events?${q}`);
    return events.map(rawOf);
  }
  async insert(calendarId, body) { return this.call('POST', '/calendar/google/events', { account: this.account, calendar: calendarId, event: body }); }
  async patch(calendarId, id, body) { return this.call('PATCH', `/calendar/google/events/${encodeURIComponent(id)}`, { account: this.account, calendar: calendarId, patch: body }); }
  async remove(calendarId, id) { return this.call('DELETE', `/calendar/google/events/${encodeURIComponent(id)}?${new URLSearchParams({ account: this.account, calendar: calendarId })}`); }
}

/** The server's event (title, start, busy, props, updated) back into the API shape the model reads. */
function rawOf(e) {
  return {
    id: e.id || e.uid, summary: e.title, description: e.description || '', location: e.location || '',
    transparency: e.busy === false ? 'transparent' : 'opaque', updated: e.updated || null,
    start: e.allDay ? { date: e.start } : { dateTime: e.start }, end: e.allDay ? { date: e.end } : { dateTime: e.end },
    ...(e.props ? { extendedProperties: { private: e.props } } : {}),
  };
}

// --------------------------------------------------------------- the plans

/** Every live plan with its schedule: the open one and the shelf's (ui/calendar.js keeps them laid). */
async function liveEntries() {
  const { shelfEntries } = await import('../ui/calendar.js');
  return shelfEntries();
}

/** Change a plan wherever it is: the open one through a commit, another through its record. */
async function editPlan(planId, label, fn) {
  if (planId === store.project.id) { tryCommit(label, (p) => { fn(p); }); return true; }
  return patchPlan(planId, fn, label);
}

// ---------------------------------------------------------------- the run

/**
 * Everything one run would do, for the dialog to show. `calendars` maps
 * each plan to its Google calendar (its setting, else the one named for it);
 * `actions` is reconcile's result; `text` is the run as lines.
 */
export async function planSync({ now = new Date(), horizonDays = HORIZON_DAYS, lookbackDays = LOOKBACK_DAYS } = {}) {
  const status = await googleStatus();
  if (status.reason && status.reason !== 'not-granted') return { ...status, ok: false };
  const entries = await liveEntries();
  const account = status.writer?.id || status.accounts[0]?.id;
  const calendars = matchPlanCalendars(entries, status.writer ? status.calendars : (status.allCalendars || []).filter((c) => c.account === account));
  const ids = calendarIdsByPlanName(entries, calendars);
  const gcal = new ServerCalendar(account);
  const [first, last] = windowOf(now, { horizonDays, lookbackDays });
  const fromMs = dayMs(first), toMs = dayMs(fromDay(toDay(last) + 1));

  // Busy time on the primary calendar: laid around, never touched.
  const primary = (await gcal.listEvents('primary', fromMs, toMs).catch(() => [])).map((raw) => fromGoogleEvent(raw, 'primary')).filter(Boolean);
  const busy = primary.map((e) => ({ title: e.title, start: e.startMs, end: e.endMs, allDay: e.allDay, busy: !e.transparent, location: e.location }));

  const existing = [];
  for (const calendarId of new Set(Object.values(ids))) {
    for (const raw of await gcal.listEvents(calendarId, fromMs, toMs)) {
      const e = fromGoogleEvent(raw, calendarId);
      if (e) existing.push(e);
    }
  }
  const actions = reconcile(entries, existing, { calendars: ids, now, horizonDays, lookbackDays, busy });
  return {
    ok: true, reason: status.reason, status, entries, calendars, ids, gcal, actions,
    text: describeActions(actions, { unmapped: actions.unmapped, window: actions.window }),
    count: countOf(actions),
  };
}

/**
 * Write a run: Google first, so the planner learns the new event ids, then
 * each touched plan. `links` and `orphans` are the proposals the person
 * ticked (indexes into actions.link / actions.orphans). With `quiet`, only
 * the calendar's own doing to linked events is applied — the read-back.
 */
export async function applySync(run, { links = [], orphans = [], quiet = false } = {}) {
  const base = quiet ? readBackActions(run.actions) : run.actions;
  const actions = { ...base, link: links.map((i) => base.link[i]).filter(Boolean), orphans: orphans.map((i) => base.orphans[i]).filter(Boolean) };
  const { gcal } = run;
  const made = [];
  if (!quiet) {
    if (actions.create.length + actions.update.length + actions.delete.length + actions.link.length > 0 && !run.status.writer) {
      throw new Error('This Google account was connected for reading only. Allow writing to push the week.');
    }
    for (const d of actions.create) {
      const ev = await gcal.insert(d.calendarId, toGoogleEvent(d, gcal.timeZone));
      made.push({ planId: d.planId, taskId: d.taskId, event: { ...d, id: ev.id } });
    }
    for (const { existing: e, desired: d } of actions.update) await gcal.patch(e.calendarId, e.id, toGoogleEvent(d, gcal.timeZone));
    for (const e of actions.delete) await gcal.remove(e.calendarId, e.id);
    for (const l of actions.link) await gcal.patch(l.event.calendarId, l.event.id, { extendedProperties: { private: { [PROP_PLAN]: l.planId, [PROP_TASK]: l.taskId } } });
  }
  const touched = new Set([...actions.pull, ...actions.unlink, ...made, ...actions.link, ...actions.orphans].map((x) => x.planId));
  const adopted = [];
  let changed = 0;
  for (const planId of touched) {
    await editPlan(planId, 'Google Calendar', (p) => {
      changed += applyToPlan(p, actions, { confirmLinks: true, adoptNew: true });
      for (const m of made) if (m.planId === p.id) { recordLink(p, m.taskId, m.event); changed += 1; }
      for (const ev of actions.orphans) if (ev.planId === p.id) {
        const task = p.tasks.find((t) => linksOf(t).some((l) => l.eventId === ev.id));
        if (task) adopted.push({ ev, taskId: task.id });
      }
    });
  }
  for (const { ev, taskId } of adopted) await gcal.patch(ev.calendarId, ev.id, { extendedProperties: { private: { [PROP_PLAN]: ev.planId, [PROP_TASK]: taskId } } });
  if (touched.size) void import('../ui/calendar.js').then((m) => m.reloadCalendarPlans());
  return { changed, pushed: made.length + actions.update.length + actions.delete.length, pulled: actions.pull.length + actions.unlink.length, linked: actions.link.length, adopted: adopted.length };
}

// ------------------------------------------------------------ the read-back

let readingBack = false;
/**
 * The quiet read-back: what the calendar did to linked events, applied
 * without asking. Returns how many tasks changed, or null when it could not
 * run (no server, nobody connected) — never throws.
 */
export async function readBack({ now = new Date() } = {}) {
  if (readingBack || !syncConfigured()) return null;
  readingBack = true;
  try {
    const run = await planSync({ now });
    if (!run.ok) return null;
    const quiet = readBackActions(run.actions);
    if (!countOf(quiet)) return 0;
    const out = await applySync(run, { quiet: true });
    return out.pulled;
  } catch {
    return null;
  } finally {
    readingBack = false;
  }
}

let timer = null;
/**
 * Read back every few minutes while the Calendar or Agenda is open and the
 * tab is visible — and once, right away, when either is opened. A change is
 * said in the hint bar.
 */
export function startReadBack({ isOpen = () => store.ui.view === 'calendar' || store.ui.view === 'today', every = READ_BACK_MS } = {}) {
  if (timer) return;
  let lastView = null;
  const tick = async () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (!isOpen()) return;
    const n = await readBack();
    if (n) { const { set } = await import('./store.js'); set({ hint: `Google Calendar: ${n} task${n === 1 ? '' : 's'} moved there, moved here too.` }); }
  };
  timer = setInterval(() => { void tick(); }, every);
  // Opening the calendar reads back at once, not in five minutes: a cheap look at the view every few seconds.
  const opener = setInterval(() => { const v = store.ui.view; if (v !== lastView && isOpen()) void tick(); lastView = v; }, 5000);
  return () => { clearInterval(timer); clearInterval(opener); timer = null; };
}

/** The task a pull names, for the dialog's lines. */
export const taskNamed = (entries, planId, taskId) => getTask(entries.find((e) => e.project.id === planId)?.project || { tasks: [] }, taskId);
