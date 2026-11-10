// Google Calendar inside the app: the pure layer the page uses (model/gcal.js).
//
// mcp/gcal.mjs grew the sync as a command and an MCP tool; the app runs the
// same reconciliation in the browser, through the sync server. So the pure
// part — matching, desired events, reconcile, apply — lives in the model with
// nothing from node in it, and the MCP re-exports it. Two small pieces are
// the app's own: which Google calendar a plan has, and what the quiet
// read-back may apply without asking.
//
// Run with:  node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import * as model from '../src/model/gcal.js';
import * as mcp from '../mcp/gcal.mjs';
import { createProject, insertTask, setScheduled } from '../src/model/model.js';

test('the model layer has nothing from node in it, and the MCP re-exports it', () => {
  const source = fs.readFileSync(new URL('../src/model/gcal.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from 'node:/, 'browser-safe');
  for (const name of ['matchEvents', 'desiredEvents', 'reconcile', 'applyToPlan', 'recordLink', 'toGoogleEvent', 'fromGoogleEvent', 'describeActions', 'withBusy', 'parseTitle', 'windowOf', 'horizonOf', 'calendarMap', 'liveEntries', 'PROP_PLAN', 'PROP_TASK']) {
    assert.equal(mcp[name], model[name], `${name} is one function, not two`);
  }
});

test('busy time from outside gets a stable id without a hash from node', () => {
  const p = createProject('P', '2026-09-21');
  const busy = [{ title: 'Smog check', start: Date.parse('2026-09-21T10:00:00'), end: Date.parse('2026-09-21T11:00:00') }];
  const [a] = model.withBusy([{ project: p, schedule: null }], busy);
  const [b] = model.withBusy([{ project: p, schedule: null }], busy);
  assert.equal(a.project.events.length, 1);
  assert.equal(a.project.events[0].id, b.project.events[0].id, 'the same meeting is the same event');
  assert.match(a.project.events[0].id, /^ev_busy_/);
});

const google = (name, { id = name.toLowerCase().replace(/\W+/g, '-'), access = 'owner', account = 'allen.c.xu@gmail.com' } = {}) => ({ account, id, name, access });

test('a plan’s calendar is the one it was given, else the Google calendar named for it', () => {
  const alcon = createProject('Alcon');
  const zip = createProject('Zipline SO 287137 WO 423177');
  const l3 = createProject('L3 Harris');
  l3.gcal = { account: 'allen.c.xu@gmail.com', calendarId: 'given@group.calendar.google.com', calendarName: 'Whatever it is called' };
  const nothing = createProject('Swoboda');
  const calendars = [
    google('Claude - Work - Alcon'),
    google('Zipline SO 287137 WO 423177'),
    google('Claude - Work - L3 Harris', { id: 'by-name-but-not-used' }),
    google('Claude - Work - Swoboda', { access: 'reader' }),
    google('Alcon', { id: 'alcon-plain' }),
  ];
  const map = model.matchPlanCalendars([alcon, zip, l3, nothing], calendars);
  assert.equal(map.get(alcon.id).calendarId, 'claude-work-alcon', 'the prefixed name wins over a bare one');
  assert.equal(map.get(alcon.id).source, 'name');
  assert.equal(map.get(zip.id).calendarId, 'zipline-so-287137-wo-423177', 'an exact name is a match too');
  assert.equal(map.get(l3.id).calendarId, 'given@group.calendar.google.com', 'a setting is not second-guessed');
  assert.equal(map.get(l3.id).source, 'setting');
  assert.equal(map.has(nothing.id), false, 'a calendar this account cannot write to is not a plan calendar');
  assert.deepEqual(model.calendarIdsByPlanName([alcon, zip, l3, nothing], map), {
    Alcon: 'claude-work-alcon', 'Zipline SO 287137 WO 423177': 'zipline-so-287137-wo-423177', 'L3 Harris': 'given@group.calendar.google.com',
  }, 'the shape reconcile takes');
});

test('the quiet read-back applies only what the calendar did to linked events', () => {
  const actions = {
    pull: [{ taskId: 'a' }], unlink: [{ taskId: 'b' }], link: [{ taskId: 'c' }], ambiguous: [{}], orphans: [{}],
    create: [{}], update: [{}], delete: [{}], keep: 3, window: ['x', 'y'], unmapped: ['P'],
  };
  const quiet = model.readBackActions(actions);
  assert.deepEqual(quiet.pull, actions.pull);
  assert.deepEqual(quiet.unlink, actions.unlink);
  for (const k of ['link', 'ambiguous', 'orphans', 'create', 'update', 'delete']) assert.deepEqual(quiet[k], [], `${k} waits for the button`);
  assert.equal(quiet.keep, 3);
  assert.equal(model.countOf(quiet), 2, 'what it would do');
  assert.equal(model.countOf(actions), 8, 'everything a full sync would do, proposals included');
});

test('a scheduled sitting is what the planner pushes for that day, pinned there', () => {
  // The task sheet writes a sitting; the sync must push exactly that, not a re-layout.
  const p = createProject('Alcon', '2026-09-21');
  p.statusDate = '2026-09-21';
  const t = insertTask(p, 0, { name: 'Quote MES', duration: 1, level: 1, work: 2 });
  setScheduled(p, t.id, { start: '2026-09-22T14:00', end: '2026-09-22T16:00' });
  const { events } = model.desiredEvents(model.liveEntries([p]), { calendars: { Alcon: 'cal' }, now: new Date(2026, 8, 21, 7, 0) });
  const mine = events.filter((e) => e.taskId === t.id);
  assert.deepEqual(mine.map((e) => [e.dateIso, e.start, e.end]), [['2026-09-22', 14 * 60, 16 * 60]]);
  assert.match(mine[0].description, /Pinned/);
});
