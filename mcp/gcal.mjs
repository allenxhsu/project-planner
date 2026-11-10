#!/usr/bin/env node
// The planner and Google Calendar, kept in step — as a command and an MCP tool.
//
// The reconciliation itself is src/model/gcal.js, shared with the app (which
// runs it in the browser through the sync server). This file is what needs
// node: the plan → calendar map on disk, the Calendar API with a local OAuth
// client, the consent flow, and the run that reads the plans through the
// planner client and writes both sides.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { toDay, fromDay } from '../src/model/calendar.js';
import { linksOf } from '../src/model/model.js';
import {
  HORIZON_DAYS, LOOKBACK_DAYS, PROP_PLAN, PROP_TASK,
  calendarMap, liveEntries, windowOf, reconcile, applyToPlan, recordLink, toGoogleEvent, fromGoogleEvent, describeActions,
} from '../src/model/gcal.js';

export * from '../src/model/gcal.js';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'project-planner');
export const CLIENT_PATH = path.join(CONFIG_DIR, 'gcal-client.json');
export const TOKEN_PATH = path.join(CONFIG_DIR, 'gcal-token.json');
export const CALENDARS_PATH = fileURLToPath(new URL('./plan-calendars.json', import.meta.url));
const dayMs = (iso) => new Date(`${iso}T00:00:00`).getTime();

/** The plan-name → calendarId map as committed (plan-calendars.json). */
export function loadCalendars(file = CALENDARS_PATH) {
  return calendarMap(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// ------------------------------------------------------------ the transport

const API = 'https://www.googleapis.com/calendar/v3';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

/**
 * The Calendar API over fetch. `open()` signs in: the client JSON from
 * Google Cloud (a Desktop-app OAuth client) at CLIENT_PATH, the refresh
 * token at TOKEN_PATH; without a token, and `interactive`, it runs the
 * consent flow in the browser, listening on a loopback port for the code.
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
      if (!interactive) throw new Error('Not signed in to Google Calendar. Run `node mcp/gcal.mjs --auth` once.');
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

  /** Every event on a calendar between two instants, series expanded, as the API returns them. */
  async listEvents(calendarId, fromMs, toMs) {
    const items = [];
    let pageToken = null;
    do {
      const q = new URLSearchParams({
        singleEvents: 'true', orderBy: 'startTime', maxResults: '250', showDeleted: 'false',
        timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(), ...(pageToken ? { pageToken } : {}),
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
      if (u.searchParams.get('state') !== state || !u.searchParams.get('code')) { res.end('Something went wrong; close this tab and try again.'); return; }
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

/** The one live plan a name or id means, or an error that lists the candidates. */
function pickPlan(entries, ref) {
  const q = String(ref).trim().toLowerCase();
  const exact = entries.filter((e) => e.project.id === ref || String(e.project.name).toLowerCase() === q);
  const hits = exact.length ? exact : entries.filter((e) => String(e.project.name).toLowerCase().includes(q));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`Several plans match “${ref}”: ${hits.map((e) => e.project.name).join(', ')}. Say which.`);
  throw new Error(`No live plan matches “${ref}”.`);
}

/**
 * One run: lay the plans, read the calendars, reconcile and — unless
 * `dryRun` — write both sides. `plan` narrows the writes to one plan (the
 * layout is still of every plan, since they share the hours); `push: false`
 * keeps new events from going out, for a run that only links and pulls;
 * `skip` names event ids the run must leave alone.
 */
export async function syncCalendar({ client, gcal, calendars, now = new Date(), horizonDays = HORIZON_DAYS, lookbackDays = LOOKBACK_DAYS, dryRun = true, plan = null, confirmLinks = false, adoptNew = false, push = true, skip = [] }) {
  await client.sync();
  const all = await client.plans();
  const entries = liveEntries(all);
  const only = plan ? pickPlan(entries, plan) : null;
  const [first, last] = windowOf(now, { horizonDays, lookbackDays });
  const fromMs = dayMs(first), toMs = dayMs(fromDay(toDay(last) + 1));

  const primary = (await gcal.listEvents('primary', fromMs, toMs)).map((raw) => fromGoogleEvent(raw, 'primary')).filter(Boolean);
  const busy = primary.map((e) => ({ title: e.title, start: e.startMs, end: e.endMs, allDay: e.allDay, busy: !e.transparent, location: e.location }));

  // Events named in `skip` are left as they are: not linked, not pulled, not listed.
  const skipped = new Set(skip || []);
  const scope = (only ? [only] : entries).map((e) => calendars[e.project.name]).filter(Boolean);
  const existing = [];
  for (const calendarId of [...new Set(scope)]) {
    for (const raw of await gcal.listEvents(calendarId, fromMs, toMs)) {
      const e = fromGoogleEvent(raw, calendarId);
      if (e && !skipped.has(e.id)) existing.push(e);
    }
  }

  const actions = reconcile(entries, existing, { calendars, now, horizonDays, lookbackDays, busy, planId: only?.project.id || null });
  if (!push) actions.create = [];        // link and pull only: nothing new goes out
  const text = describeActions(actions, { unmapped: actions.unmapped, window: actions.window });
  if (dryRun) return { actions, text, applied: false, unmapped: actions.unmapped, window: actions.window };

  // Google first, so the planner learns the new event ids.
  const made = [];
  for (const d of actions.create) {
    const ev = await gcal.insert(d.calendarId, toGoogleEvent(d, gcal.timeZone));
    made.push({ planId: d.planId, taskId: d.taskId, event: { ...d, id: ev.id } });
  }
  for (const { existing: e, desired: d } of actions.update) await gcal.patch(e.calendarId, e.id, toGoogleEvent(d, gcal.timeZone));
  for (const e of actions.delete) await gcal.remove(e.calendarId, e.id);
  if (confirmLinks) for (const l of actions.link) await gcal.patch(l.event.calendarId, l.event.id, { extendedProperties: { private: { [PROP_PLAN]: l.planId, [PROP_TASK]: l.taskId } } });

  const touched = new Set([...actions.pull, ...actions.unlink, ...made, ...(confirmLinks ? actions.link : []), ...(adoptNew ? actions.orphans : [])].map((x) => x.planId));
  const adopted = [];
  for (const planId of touched) {
    await client.edit(planId, (p) => {
      applyToPlan(p, actions, { confirmLinks, adoptNew });
      for (const m of made) if (m.planId === p.id) recordLink(p, m.taskId, m.event);
      if (adoptNew) for (const ev of actions.orphans) if (ev.planId === p.id) {
        const task = p.tasks.find((t) => linksOf(t).some((l) => l.eventId === ev.id));
        if (task) adopted.push({ ev, taskId: task.id });
      }
    });
  }
  // An adopted event learns the id of the task it became.
  for (const { ev, taskId } of adopted) await gcal.patch(ev.calendarId, ev.id, { extendedProperties: { private: { [PROP_PLAN]: ev.planId, [PROP_TASK]: taskId } } });
  return { actions, text, applied: true, unmapped: actions.unmapped, window: actions.window };
}

// ------------------------------------------------------------------- CLI

async function main(argv) {
  const flag = (name) => argv.includes(name);
  const value = (name, fallback = null) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : fallback; };
  if (flag('--help') || flag('-h')) {
    console.log('node mcp/gcal.mjs [--dry-run | --apply] [--confirm-links] [--adopt-new] [--no-push] [--skip id,id] [--days N] [--plan NAME] [--auth]\n'
      + 'Reads PROJECT_SYNC_URL and PROJECT_SYNC_TOKEN. --auth signs in to Google Calendar once.');
    return;
  }
  const gcal = await GoogleCalendar.open({ interactive: flag('--auth'), log: (s) => console.error(s) });
  if (flag('--auth') && argv.length === 1) { console.log(`Signed in; token kept at ${TOKEN_PATH}.`); return; }
  const { PlannerClient } = await import('./planner.mjs');
  const client = await PlannerClient.open({ url: process.env.PROJECT_SYNC_URL, token: process.env.PROJECT_SYNC_TOKEN, deviceId: 'gcal' });
  const out = await syncCalendar({
    client, gcal, calendars: loadCalendars(), dryRun: !flag('--apply'), confirmLinks: flag('--confirm-links'), adoptNew: flag('--adopt-new'), push: !flag('--no-push'),
    skip: String(value('--skip', '')).split(',').map((x) => x.trim()).filter(Boolean),
    horizonDays: +value('--days', HORIZON_DAYS) || HORIZON_DAYS, plan: value('--plan'),
  });
  console.log(out.text);
  console.log(out.applied ? 'Applied.' : 'Dry run; nothing written. Add --apply to write.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exit(1); });
}
