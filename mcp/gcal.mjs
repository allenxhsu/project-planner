#!/usr/bin/env node
// The planner on Google Calendar.
//
// Tasks have dates and hours but no time of day; the planner's calendar lays
// them into clock time (model/agenda.js: time blocks, pins, events, the
// day's focus). Google Calendar is where that layout is read during the
// day, one secondary calendar per plan (plan-calendars.json). This module
// is the bridge, one way: the layout is turned into one event per task per
// day on the plan's calendar, and a re-run reconciles against what is there.
//
// Three parts, kept apart so the first two need no Google:
//   - desiredEvents: plans → the events there should be (pure);
//   - diffEvents:    desired + what is there → create/update/adopt/tick/
//                    delete/keep (pure);
//   - GoogleCalendar: the Calendar API over fetch, with an installed-app
//                    OAuth flow, and syncCalendar, which runs the three.
//
// What the export made is marked with the plan, task, day and run in the
// event's private extended properties, so a re-run touches only its own
// events — plus "adoption": a hand-made event whose description starts with
// "Planner:" and overlaps a desired event on the same day is taken over
// rather than doubled. Anything else on a calendar is nobody's business.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { computeSchedule } from '../src/model/schedule.js';
import { planBlocksAcross } from '../src/model/agenda.js';
import { eventsOf, saveEvent } from '../src/model/model.js';
import { localDate, toDay, fromDay } from '../src/model/calendar.js';

/** Today through this many days: what a run exports and reconciles. */
export const HORIZON_DAYS = 14;
/** A task's merged run on a day shorter than this is not worth an event. */
export const MIN_MINUTES = 15;
/** Two blocks of one task on one day this close are one event. */
export const MERGE_GAP_MINUTES = 15;
/** The private extended property that marks an event as the export's. */
export const TAG_KEY = 'planner';
/** The first line of every exported description, and what adoption looks for. */
const DESCRIPTION_PREFIX = 'Planner:';
const TICK = '✓ ';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'project-planner');
export const CLIENT_PATH = path.join(CONFIG_DIR, 'gcal-client.json');
export const TOKEN_PATH = path.join(CONFIG_DIR, 'gcal-token.json');
export const CALENDARS_PATH = fileURLToPath(new URL('./plan-calendars.json', import.meta.url));

const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const dayMs = (iso) => new Date(`${iso}T00:00:00`).getTime();
/** Minutes into the day of a local Date. */
const minutesOf = (d) => d.getHours() * 60 + d.getMinutes();

/** The plan-name → calendarId map as committed. */
export function loadCalendars(file = CALENDARS_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** The plans that are laid: every unarchived one, with its schedule. */
export function liveEntries(plans) {
  return plans
    .map((x) => x.project || x)
    .filter((project) => project && !project.archived)
    .map((project) => ({ project, schedule: computeSchedule(project) }));
}

/**
 * Busy time from outside the planner, as planner events on a copy of the
 * first plan: lane `*`, so every person's hours are taken, no travel time
 * of its own (the calendar's travel buffers are already events there).
 * `busy` is `{ title, start, end, allDay?, busy?, location? }` in ms; one
 * with `busy: false` books nothing and is dropped.
 */
export function withBusy(entries, busy) {
  const taken = (busy || []).filter((b) => b && b.busy !== false && Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start);
  if (!taken.length || !entries.length) return entries;
  const copy = { ...entries[0].project, events: [...eventsOf(entries[0].project)] };
  for (const b of taken) {
    const s = new Date(b.start), e = new Date(b.end);
    const day = localDate(s);
    // An end at midnight belongs to the day before it.
    const endDay = localDate(new Date(b.end - 1));
    saveEvent(copy, {
      id: `ev_busy_${crypto.createHash('sha1').update(`${b.title}|${b.start}|${b.end}`).digest('hex').slice(0, 12)}`,
      title: String(b.title || 'Busy'), day, endDay, allDay: !!b.allDay,
      start: minutesOf(s), end: minutesOf(e) === 0 && endDay < localDate(e) ? 24 * 60 : minutesOf(e),
      busy: true, travel: 0, location: b.location || '', notes: 'From Google Calendar',
    });
  }
  return [{ ...entries[0], project: copy }, ...entries.slice(1)];
}

/** The horizon as `[firstIso, lastIso]`, today through today + days − 1. */
export function horizonOf(now, horizonDays = HORIZON_DAYS) {
  const first = toDay(localDate(now));
  return [fromDay(first), fromDay(first + horizonDays - 1)];
}

/**
 * The events there should be: one per task per day on the plan's calendar.
 *
 * @param entries as liveEntries returns them
 * @param {{ calendars: Record<string,string>, now?: Date, horizonDays?: number, busy?: Array }} opts
 * @returns {{ events: Array, unmapped: string[], layout: object, horizon: [string, string] }}
 */
export function desiredEvents(entries, { calendars = {}, now = new Date(), horizonDays = HORIZON_DAYS, busy = [] } = {}) {
  const laid = withBusy(entries, busy);
  const layout = planBlocksAcross(laid, { now });
  const [first, last] = horizonOf(now, horizonDays);
  const projects = new Map(entries.map((e) => [e.project.id, e.project]));

  // Group the horizon's blocks by plan, task and day.
  const groups = new Map();
  for (const b of layout.blocks) {
    if (b.dateIso < first || b.dateIso > last) continue;
    const project = projects.get(b.planId);
    const task = project?.tasks.find((t) => t.id === b.taskId);
    if (!task || task.builtin) continue;
    const key = `${b.planId}|${b.taskId}|${b.dateIso}`;
    if (!groups.has(key)) groups.set(key, { project, task, dateIso: b.dateIso, blocks: [] });
    groups.get(key).blocks.push(b);
  }

  const events = [];
  const unmapped = new Set();
  for (const { project, task, dateIso, blocks } of groups.values()) {
    const calendarId = calendars[project.name];
    // Merge the day's blocks into runs.
    const runs = [];
    for (const b of [...blocks].sort((x, y) => x.start - y.start)) {
      const run = runs[runs.length - 1];
      if (run && b.start - run.end <= MERGE_GAP_MINUTES) {
        run.end = Math.max(run.end, b.end);
        run.blocks.push(b);
      } else runs.push({ start: b.start, end: b.end, blocks: [b] });
    }
    let n = 0;
    for (const run of runs) {
      if (run.end - run.start < MIN_MINUTES) continue;
      n += 1;
      if (!calendarId) { unmapped.add(project.name); continue; }
      const flags = [
        run.blocks.some((b) => b.pinned) ? 'Pinned' : null,
        run.blocks.some((b) => b.late) ? 'After its deadline' : null,
        run.blocks.some((b) => b.overdue) ? 'Overdue' : null,
      ].filter(Boolean);
      const notes = String(task.notes || '').trim();
      events.push({
        key: `${project.id}|${task.id}|${dateIso}|${n}`,
        calendarId, planId: project.id, planName: project.name, taskId: task.id, taskName: task.name, dateIso,
        start: run.start, end: run.end,
        title: `${task.name} (${project.name})`,
        description: [`${DESCRIPTION_PREFIX} ${project.name} › ${task.name}`, notes || null, flags.length ? flags.join(' · ') : null].filter(Boolean).join('\n'),
      });
    }
  }
  events.sort((a, b) => a.dateIso.localeCompare(b.dateIso) || a.start - b.start || a.title.localeCompare(b.title));
  return { events, unmapped: [...unmapped].sort(), layout, horizon: [first, last] };
}

const same = (d, e) => d.title === e.title && d.description === e.description && d.dateIso === e.dateIso && d.start === e.start && d.end === e.end;
const overlaps = (a, b) => a.dateIso === b.dateIso && a.start < b.end && b.start < a.end;
const endMs = (e) => dayMs(e.dateIso) + e.end * 60000;

/**
 * What to do to make the calendars hold the desired events.
 *
 * `existing` are normalised events (fromGoogleEvent). `taskState(planId,
 * taskId)` says 'open', 'done' or 'gone'. A tagged event the layout no longer
 * makes is deleted when it lies ahead, kept when it already ended (what was
 * planned stays on the record), ticked when its task is done, deleted when
 * its task is gone.
 */
export function diffEvents(desired, existing, { now = Date.now(), taskState = () => 'open' } = {}) {
  const out = { create: [], update: [], adopt: [], tick: [], delete: [], keep: [] };
  const tagged = new Map();
  const loose = [];
  for (const e of existing) {
    if (!e) continue;
    if (e.key) tagged.set(`${e.calendarId}|${e.key}`, e);
    else loose.push(e);
  }
  const claimed = new Set();
  for (const d of desired) {
    const hit = tagged.get(`${d.calendarId}|${d.key}`);
    if (hit) {
      claimed.add(hit);
      (same(d, hit) ? out.keep : out.update).push(same(d, hit) ? hit : { existing: hit, desired: d });
      continue;
    }
    const hand = loose.find((e) => !claimed.has(e) && !e.allDay && e.calendarId === d.calendarId
      && String(e.description || '').trimStart().startsWith(DESCRIPTION_PREFIX) && overlaps(e, d));
    if (hand) { claimed.add(hand); out.adopt.push({ existing: hand, desired: d }); continue; }
    out.create.push(d);
  }
  for (const e of tagged.values()) {
    if (claimed.has(e)) continue;
    const [planId, taskId] = String(e.key).split('|');
    const state = taskState(planId, taskId);
    if (state === 'done') {
      if (e.title.startsWith(TICK.trim())) out.keep.push(e);
      else out.tick.push({ ...e, title: `${TICK}${e.title}` });
    } else if (state === 'gone') out.delete.push(e);
    else if (endMs(e) <= now) out.keep.push(e);
    else out.delete.push(e);
  }
  return out;
}

/** A desired event as the Calendar API takes it. */
export function toGoogleEvent(d, timeZone) {
  const at = (iso, minutes) => minutes >= 24 * 60
    ? { dateTime: `${fromDay(toDay(iso) + 1)}T00:00:00`, timeZone }
    : { dateTime: `${iso}T${clock(minutes)}:00`, timeZone };
  return {
    summary: d.title,
    description: d.description,
    start: at(d.dateIso, d.start),
    end: at(d.dateIso, d.end),
    extendedProperties: { private: { [TAG_KEY]: d.key } },
    transparency: 'opaque',
  };
}

/** A Calendar API event, normalised; null when it is cancelled or has no start. */
export function fromGoogleEvent(raw, calendarId) {
  if (!raw || raw.status === 'cancelled' || !raw.start) return null;
  const base = {
    id: raw.id, calendarId,
    key: raw.extendedProperties?.private?.[TAG_KEY] || null,
    title: raw.summary || '', description: raw.description || '',
    location: raw.location || '',
    transparent: raw.transparency === 'transparent',
  };
  if (raw.start.date) {
    return { ...base, allDay: true, dateIso: raw.start.date, start: 0, end: 24 * 60,
      startMs: dayMs(raw.start.date), endMs: dayMs(raw.end?.date || raw.start.date) };
  }
  const s = new Date(raw.start.dateTime), e = new Date(raw.end?.dateTime || raw.start.dateTime);
  const dateIso = localDate(s);
  return { ...base, allDay: false, dateIso, start: minutesOf(s), end: localDate(e) === dateIso ? minutesOf(e) : 24 * 60,
    startMs: s.getTime(), endMs: e.getTime() };
}

/** The plan as text: counts, then one line per change. */
export function describeActions(actions, { unmapped = [], horizon = null } = {}) {
  const span = (e) => `${e.dateIso} ${clock(e.start)}–${clock(e.end)}`;
  const lines = [];
  if (horizon) lines.push(`Horizon ${horizon[0]} → ${horizon[1]}.`);
  lines.push(['create', 'update', 'adopt', 'tick', 'delete', 'keep'].map((k) => `${k} ${actions[k].length}`).join(', '));
  for (const d of actions.create) lines.push(`+ ${span(d)} ${d.title}`);
  for (const { existing, desired } of actions.update) lines.push(`~ ${span(desired)} ${desired.title} (was ${span(existing)})`);
  for (const { existing, desired } of actions.adopt) lines.push(`↺ ${span(desired)} ${desired.title} (adopts “${existing.title}”)`);
  for (const e of actions.tick) lines.push(`✓ ${span(e)} ${e.title}`);
  for (const e of actions.delete) lines.push(`- ${span(e)} ${e.title}`);
  if (unmapped.length) lines.push(`no calendar: ${unmapped.join(', ')}`);
  return lines.join('\n');
}

// ------------------------------------------------------------ the transport

const API = 'https://www.googleapis.com/calendar/v3';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

/**
 * The Calendar API over fetch. `open()` signs in: the client JSON from
 * Google Cloud (a Desktop app OAuth client) at CLIENT_PATH, the refresh
 * token at TOKEN_PATH; without a token it runs the consent flow in the
 * browser, listening on a loopback port for the code.
 */
export class GoogleCalendar {
  constructor({ accessToken, fetchFn = globalThis.fetch, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
    this.accessToken = accessToken;
    this.fetchFn = fetchFn;
    this.timeZone = timeZone;
  }

  static async open({ clientPath = CLIENT_PATH, tokenPath = TOKEN_PATH, interactive = false, fetchFn = globalThis.fetch, log = () => {} } = {}) {
    if (!fs.existsSync(clientPath)) {
      throw new Error(`No Google OAuth client at ${clientPath}. In Google Cloud make a Desktop-app OAuth client with the Calendar API enabled and save its JSON there.`);
    }
    const raw = JSON.parse(fs.readFileSync(clientPath, 'utf8'));
    const client = raw.installed || raw.web || raw;
    if (!client.client_id || !client.client_secret) throw new Error(`${clientPath} has no client_id/client_secret.`);
    let token = fs.existsSync(tokenPath) ? JSON.parse(fs.readFileSync(tokenPath, 'utf8')) : null;
    if (!token?.refresh_token) {
      if (!interactive) throw new Error(`Not signed in to Google Calendar. Run \`node mcp/gcal.mjs --auth\` once.`);
      token = await consent(client, fetchFn, log);
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
      fs.writeFileSync(tokenPath, JSON.stringify(token, null, 2), { mode: 0o600 });
    }
    const res = await fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, refresh_token: token.refresh_token, grant_type: 'refresh_token' }),
    });
    if (!res.ok) throw new Error(`Google refused the refresh token (${res.status}). Delete ${tokenPath} and run \`node mcp/gcal.mjs --auth\` again.`);
    const { access_token } = await res.json();
    return new GoogleCalendar({ accessToken: access_token, fetchFn });
  }

  async call(method, url, body) {
    const res = await this.fetchFn(url, {
      method, headers: { authorization: `Bearer ${this.accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`Google Calendar ${method} ${url.replace(API, '')} → ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  /** Every event on a calendar between two instants, expanded, as the API returns them. */
  async listEvents(calendarId, fromMs, toMs) {
    const items = [];
    let pageToken = null;
    do {
      const q = new URLSearchParams({
        singleEvents: 'true', orderBy: 'startTime', maxResults: '250', showDeleted: 'false',
        timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(),
        ...(pageToken ? { pageToken } : {}),
      });
      const page = await this.call('GET', `${API}/calendars/${encodeURIComponent(calendarId)}/events?${q}`);
      items.push(...(page?.items || []));
      pageToken = page?.nextPageToken || null;
    } while (pageToken);
    return items;
  }
  insert(calendarId, body) { return this.call('POST', `${API}/calendars/${encodeURIComponent(calendarId)}/events`, body); }
  patch(calendarId, id, body) { return this.call('PATCH', `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`, body); }
  remove(calendarId, id) { return this.call('DELETE', `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`); }
}

/** The installed-app consent flow: a loopback redirect catches the code. */
async function consent(client, fetchFn, log) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(12).toString('hex');
  let redirect = '';
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/') { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'text/plain' });
      if (u.searchParams.get('state') !== state || !u.searchParams.get('code')) {
        res.end('Something went wrong; close this tab and try again.');
        return;
      }
      res.end('Signed in. You can close this tab.');
      server.close();
      resolve(u.searchParams.get('code'));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      redirect = `http://127.0.0.1:${server.address().port}/`;
      const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: client.client_id, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
        access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
      })}`;
      log(`Open this in the browser and allow Calendar access:\n${url}\n`);
      import('node:child_process').then(({ spawn }) => spawn('open', [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()).catch(() => {});
    });
    setTimeout(() => { server.close(); reject(new Error('No sign-in within 5 minutes.')); }, 5 * 60 * 1000).unref();
  });
  const res = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect }),
  });
  const token = await res.json();
  if (!res.ok || !token.refresh_token) throw new Error(`Google did not give a refresh token: ${JSON.stringify(token).slice(0, 300)}`);
  return { refresh_token: token.refresh_token, scope: token.scope, obtained: new Date().toISOString() };
}

// ------------------------------------------------------------------ the run

/** The one plan a name or id means among the entries, or an error that lists the candidates. */
function pickPlan(entries, ref) {
  const q = String(ref).trim().toLowerCase();
  const exact = entries.filter((e) => e.project.id === ref || String(e.project.name).toLowerCase() === q);
  const hits = exact.length ? exact : entries.filter((e) => String(e.project.name).toLowerCase().includes(q));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`Several plans match “${ref}”: ${hits.map((e) => e.project.name).join(', ')}. Say which.`);
  throw new Error(`No live plan matches “${ref}”.`);
}

/**
 * Lay the plans, read the calendars, work out the difference and — unless
 * `dryRun` — apply it. `plan` narrows the writes to one plan; the layout is
 * still of every plan, since they share the hours.
 *
 * @returns {{ actions, text, applied: boolean, unmapped: string[], horizon: [string, string], desired: Array }}
 */
export async function syncCalendar({ client, gcal, calendars, now = new Date(), horizonDays = HORIZON_DAYS, dryRun = true, plan = null }) {
  await client.sync();
  const all = await client.plans();
  const entries = liveEntries(all);
  const only = plan ? pickPlan(entries, plan) : null;
  const [first, last] = horizonOf(now, horizonDays);
  const fromMs = dayMs(first), toMs = dayMs(fromDay(toDay(last) + 1));

  // Busy time on the primary calendar: anything not marked free.
  const primary = (await gcal.listEvents('primary', fromMs, toMs)).map((raw) => fromGoogleEvent(raw, 'primary')).filter(Boolean);
  const busy = primary.map((e) => ({ title: e.title, start: e.startMs, end: e.endMs, allDay: e.allDay, busy: !e.transparent, location: e.location }));

  let { events: desired, unmapped, horizon } = desiredEvents(entries, { calendars, now, horizonDays, busy });
  if (only) {
    desired = desired.filter((d) => d.planId === only.project.id);
    unmapped = unmapped.filter((name) => name === only.project.name);
  }

  // What is there, on every calendar in scope.
  const scope = (only ? [only] : entries).map((e) => calendars[e.project.name]).filter(Boolean);
  const existing = [];
  for (const calendarId of [...new Set(scope)]) {
    for (const raw of await gcal.listEvents(calendarId, fromMs, toMs)) {
      const e = fromGoogleEvent(raw, calendarId);
      if (e) existing.push(e);
    }
  }

  const projects = new Map(all.map((x) => x.project || x).map((p) => [p.id, p]));
  const taskState = (planId, taskId) => {
    const t = projects.get(planId)?.tasks.find((x) => x.id === taskId);
    if (!t) return 'gone';
    return (t.percent || 0) >= 100 ? 'done' : 'open';
  };
  const actions = diffEvents(desired, existing, { now: now.getTime(), taskState });
  const text = describeActions(actions, { unmapped, horizon });

  if (!dryRun) {
    for (const d of actions.create) await gcal.insert(d.calendarId, toGoogleEvent(d, gcal.timeZone));
    for (const { existing: e, desired: d } of [...actions.update, ...actions.adopt]) await gcal.patch(e.calendarId, e.id, toGoogleEvent(d, gcal.timeZone));
    for (const e of actions.tick) await gcal.patch(e.calendarId, e.id, { summary: e.title });
    for (const e of actions.delete) await gcal.remove(e.calendarId, e.id);
  }
  return { actions, text, applied: !dryRun, unmapped, horizon, desired };
}

// ------------------------------------------------------------------- CLI

async function main(argv) {
  const flag = (name) => argv.includes(name);
  const value = (name, fallback = null) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : fallback; };
  if (flag('--help') || flag('-h')) {
    console.log('node mcp/gcal.mjs [--dry-run | --apply] [--days N] [--plan NAME] [--auth]\n'
      + 'Reads PROJECT_SYNC_URL and PROJECT_SYNC_TOKEN. --auth signs in to Google Calendar once.');
    return;
  }
  const gcal = await GoogleCalendar.open({ interactive: flag('--auth'), log: (s) => console.error(s) });
  if (flag('--auth') && argv.length === 1) { console.log(`Signed in; token kept at ${TOKEN_PATH}.`); return; }
  const { PlannerClient } = await import('./planner.mjs');
  const client = await PlannerClient.open({ url: process.env.PROJECT_SYNC_URL, token: process.env.PROJECT_SYNC_TOKEN, deviceId: 'gcal' });
  const out = await syncCalendar({
    client, gcal, calendars: loadCalendars(), dryRun: !flag('--apply'),
    horizonDays: +value('--days', HORIZON_DAYS) || HORIZON_DAYS, plan: value('--plan'),
  });
  console.log(out.text);
  console.log(out.applied ? 'Applied.' : 'Dry run; nothing written. Add --apply to write.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exit(1); });
}
