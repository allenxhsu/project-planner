// "Claude / MCP scheduled": a task whose start date and deadline Claude chose,
// through the MCP server or the browser. It is still laid on the calendar,
// but only inside the window Claude gave it, and nothing automatic moves
// those dates. Plain Auto-schedule is for the small, miscellaneous work; a
// task over half an hour left to it is flagged by the checks.
//
// Run with:  node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createProject, insertTask, addResource, assign, setTaskField, setPin } from '../src/model/model.js';
import { computeSchedule } from '../src/model/schedule.js';
import { planBlocksAcross } from '../src/model/agenda.js';
import { shiftProject } from '../src/model/stages.js';
import { validate } from '../src/model/validate.js';
import { serialize, parse } from '../src/io/json.js';

const MON = '2026-09-21';   // a Monday
const WED = '2026-09-23';
const FRI = '2026-09-25';

function week() {
  const p = createProject('Week', MON);
  p.statusDate = MON;
  p.timeBlocks = [{ id: 'tb', name: 'Day', from: '09:00', to: '17:00', days: [1, 2, 3, 4, 5] }];
  p.agenda = { blockHours: 2, timeBlockId: 'tb', gapMinutes: 0, assumedLoad: 100, dailyCap: 8 };
  const ann = addResource(p, { name: 'Ann' });
  return { p, ann };
}
function job(p, ann, name, { work = '2', start = null, deadline = null, urgency = null, claude = false } = {}) {
  const t = insertTask(p, p.tasks.length, { name, duration: 1, level: 1 });
  assign(p, t.id, ann.id, 1);
  setTaskField(p, t.id, 'work', work);
  setTaskField(p, t.id, 'calendarShow', true);
  if (start) setTaskField(p, t.id, 'start', start);
  if (deadline) setTaskField(p, t.id, 'deadline', deadline);
  if (urgency) setTaskField(p, t.id, 'urgency', urgency);
  if (claude) setTaskField(p, t.id, 'scheduledBy', 'claude');
  return t;
}
const lay = (p) => planBlocksAcross([{ project: p, schedule: computeSchedule(p) }], { now: new Date(2026, 8, 21, 0, 0) });
const daysOf = (blocks, id) => [...new Set(blocks.filter((b) => b.taskId === id).map((b) => b.dateIso))].sort();

// ---- the field

test('scheduledBy "claude" marks the task and keeps it on the calendar', () => {
  const { p, ann } = week();
  const t = job(p, ann, 'Wire harness');
  setTaskField(p, t.id, 'calendarShow', false);
  setTaskField(p, t.id, 'scheduledBy', 'claude');
  assert.equal(t.scheduledBy, 'claude');
  assert.equal(t.calendar.show, true);
});

test('true means claude; null, "" and false clear the mark', () => {
  const { p, ann } = week();
  const t = job(p, ann, 'Wire harness');
  setTaskField(p, t.id, 'scheduledBy', true);
  assert.equal(t.scheduledBy, 'claude');
  for (const off of [null, '', false]) {
    setTaskField(p, t.id, 'scheduledBy', 'claude');
    setTaskField(p, t.id, 'scheduledBy', off);
    assert.equal('scheduledBy' in t, false, `cleared by ${JSON.stringify(off)}`);
  }
});

test('an unknown scheduler is refused and changes nothing', () => {
  const { p, ann } = week();
  const t = job(p, ann, 'Wire harness');
  assert.throws(() => setTaskField(p, t.id, 'scheduledBy', 'bob'), /claude/i);
  assert.equal('scheduledBy' in t, false);
});

test('switching the task off the calendar makes it manual: the mark goes', () => {
  const { p, ann } = week();
  const t = job(p, ann, 'Wire harness', { claude: true });
  setTaskField(p, t.id, 'calendarShow', false);
  assert.equal('scheduledBy' in t, false);
  assert.equal(t.calendar.show, false);
});

test('the change is in the task’s history', () => {
  const { p, ann } = week();
  const t = job(p, ann, 'Wire harness');
  setTaskField(p, t.id, 'scheduledBy', 'claude');
  assert.ok((t.activity || []).some((a) => a.field === 'scheduled by' && a.to === 'Claude'));
});

// ---- the file

test('the mark survives a save and a reload; anything else is dropped on read', () => {
  const { p, ann } = week();
  const t = job(p, ann, 'Wire harness', { claude: true });
  const back = parse(serialize(p)).project.tasks.find((x) => x.id === t.id);
  assert.equal(back.scheduledBy, 'claude');

  const raw = JSON.parse(serialize(p));
  raw.tasks.find((x) => x.id === t.id).scheduledBy = 'bob';
  const odd = parse(JSON.stringify(raw)).project.tasks.find((x) => x.id === t.id);
  assert.equal('scheduledBy' in odd, false);
});

// ---- the calendar

test('a Claude-scheduled task is laid on the calendar from its start date', () => {
  const { p, ann } = week();
  const t = job(p, ann, 'Wire harness', { start: WED, deadline: FRI, claude: true });
  const days = daysOf(lay(p).blocks, t.id);
  assert.deepEqual(days, [WED]);
});

test('"Do it now" does not pull a Claude-scheduled task before its start date', () => {
  const { p, ann } = week();
  const mine = job(p, ann, 'Planned by Claude', { start: WED, urgency: 'now', claude: true });
  const plain = job(p, ann, 'Plain', { start: WED, urgency: 'now' });
  const blocks = lay(p).blocks;
  assert.deepEqual(daysOf(blocks, mine.id), [WED]);
  // The contrast: without the mark, "now" means today.
  assert.deepEqual(daysOf(blocks, plain.id), [MON]);
});

// ---- nothing automatic moves its dates

test('moving the whole project leaves a Claude-scheduled task’s dates where Claude put them', () => {
  const { p, ann } = week();
  const mine = job(p, ann, 'Planned by Claude', { start: WED, deadline: FRI, claude: true });
  const plain = job(p, ann, 'Plain', { start: WED, deadline: FRI });
  shiftProject(p, 7);
  assert.equal(mine.constraint.date, WED);
  assert.equal(mine.deadline, FRI);
  assert.equal(plain.constraint.date, '2026-09-30');
  assert.equal(plain.deadline, '2026-10-02');
});

// ---- the half-hour rule

const unplanned = (p) => validate(p, computeSchedule(p)).filter((i) => i.code === 'unplanned-long');

test('work over 30 minutes left to plain Auto-schedule is flagged', () => {
  const { p, ann } = week();
  const t = job(p, ann, 'Wire harness', { work: '0.75' });
  const hits = unplanned(p);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].taskId, t.id);
  assert.equal(hits[0].level, 'warning');
});

test('30 minutes or less, Claude-scheduled, fixed in time, off the calendar or done: not flagged', () => {
  const { p, ann } = week();
  job(p, ann, 'Quick email', { work: '0.5' });
  job(p, ann, 'Planned by Claude', { work: '3', start: WED, claude: true });
  const pinned = job(p, ann, 'Fixed', { work: '2' });
  setPin(p, pinned.id, { day: WED, start: 540, minutes: 120 });
  const off = job(p, ann, 'Off the calendar', { work: '2' });
  setTaskField(p, off.id, 'calendarShow', false);
  const done = job(p, ann, 'Done', { work: '2' });
  setTaskField(p, done.id, 'percent', 100);
  assert.deepEqual(unplanned(p), []);
});

// ---- the MCP server's tools

test('the MCP add_task and edit_task tools take claude_scheduled', async () => {
  const { TOOLS } = await import('../mcp/tools.mjs');
  for (const name of ['add_task', 'edit_task']) {
    const tool = TOOLS.find((x) => x.name === name);
    assert.equal(tool.inputSchema.properties.claude_scheduled?.type, 'boolean', name);
  }
});

test('the MCP tools set and clear the mark through the model', async () => {
  const { runTool } = await import('../mcp/tools.mjs');
  const { p } = week();
  // A stand-in for the sync client: the edit runs on this plan, nothing is pushed.
  const client = { edit: async (_plan, fn) => {
    const result = fn(p, computeSchedule(p));
    return { project: p, schedule: computeSchedule(p), pushed: false, result };
  } };
  await runTool(client, 'add_task', { name: 'Bracket drawing', work: '3h', start: WED, deadline: FRI, claude_scheduled: true });
  const t = p.tasks.at(-1);
  assert.equal(t.scheduledBy, 'claude');
  assert.equal(t.calendar.show, true);
  await runTool(client, 'edit_task', { task: 'Bracket drawing', claude_scheduled: false });
  assert.equal('scheduledBy' in t, false);
  await runTool(client, 'edit_task', { task: 'Bracket drawing', claude_scheduled: true });
  assert.equal(t.scheduledBy, 'claude');
});
