// Operations the Flow app writes into the `project` workspace, and how a plan
// takes them: once each, through the plan's own editing functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, insertTask, addResource, addTimesheet } from '../src/model/model.js';
import { serialize, parse } from '../src/io/json.js';
import { pendingOps, applyOps, applyToRecord, OP_TYPE, KEEP_APPLIED_MS } from '../src/model/flowops.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 28, 12, 0);

function plan() {
  const p = createProject('Website relaunch', '2026-09-28');
  const home = insertTask(p, 0, { name: 'Design', level: 1 });
  insertTask(p, 1, { name: 'Wireframes', level: 2 });
  insertTask(p, 2, { name: 'Mockups', level: 2 });
  const ana = addResource(p, { name: 'Ana Lima' });
  addResource(p, { name: 'Ben' });
  return { p, home, ana };
}

const addOp = (p, over = {}) => ({
  id: 'op_add_1', type: OP_TYPE, op: 'addTask', plan: p.id, at: NOW - 60_000, origin: 'flow1', me: 'Ana Lima',
  task: { id: 't_flow_abc', name: 'Write the launch post', work: 3, deadline: '2026-10-09' },
  ...over,
});
const sheetOp = (p, task, over = {}) => ({
  id: 'op_ts_1', type: OP_TYPE, op: 'timesheet', plan: p.id, at: NOW - 30_000, origin: 'flow1', me: 'Ana Lima',
  task, date: '2026-09-28', start: 9 * 60 + 15, hours: 1.25, note: 'Flow timer',
  ...over,
});

test('pendingOps: only flow operations for this plan that it has not applied, oldest first', () => {
  const { p } = plan();
  const other = createProject('Other');
  const a = addOp(p, { id: 'op_b', at: NOW - 1000 });
  const b = addOp(p, { id: 'op_a', at: NOW - 2000, task: { id: 't_flow_2', name: 'Two', work: null, deadline: null } });
  const records = [
    a, b,
    addOp(other, { id: 'op_other' }),
    { ...addOp(p, { id: 'op_deleted' }), deletedAt: NOW },
    { id: p.id, type: 'document', body: serialize(p) },
    addOp(p, { id: 'op_done' }),
  ];
  p.appliedOps = [{ id: 'op_done', at: NOW - DAY }];
  assert.deepEqual(pendingOps(records, p, { now: NOW }).map((o) => o.id), ['op_a', 'op_b']);
});

test('pendingOps: an operation type this Planner does not know is not pending', () => {
  const { p } = plan();
  const records = [addOp(p, { id: 'op_x', op: 'renameTask' }), addOp(p)];
  assert.deepEqual(pendingOps(records, p, { now: NOW }).map((o) => o.id), ['op_add_1']);
});

test('addTask: appended at the end, outline level 1, with exactly the id Flow made, assigned to the player', () => {
  const { p, ana } = plan();
  const before = p.tasks.map((t) => t.id);
  const { project, applied } = applyOps(p, [addOp(p)], { now: NOW });
  assert.equal(project, p, 'the plan is changed in place, so it can run inside a commit');
  assert.deepEqual(project.tasks.slice(0, before.length).map((t) => t.id), before, 'nothing before it moved');
  const t = project.tasks[project.tasks.length - 1];
  assert.equal(project.tasks.length, before.length + 1);
  assert.equal(t.id, 't_flow_abc');
  assert.equal(t.name, 'Write the launch post');
  assert.equal(t.level, 1, 'level 1 even though the row above is a level-2 subtask');
  assert.equal(t.work, 3);
  assert.equal(t.deadline, '2026-10-09');
  assert.deepEqual(t.assignments, [{ resourceId: ana.id, units: 1 }]);
  assert.deepEqual(applied, [{ id: 'op_add_1', at: NOW }]);
  assert.deepEqual(project.appliedOps, [{ id: 'op_add_1', at: NOW }]);
});

test('addTask: no work and no deadline stay empty; a task too big for one day is open long enough to hold it', () => {
  const { p } = plan();
  applyOps(p, [addOp(p, { task: { id: 't_flow_1', name: 'Call the printer', work: null, deadline: null } }),
    addOp(p, { id: 'op_add_2', task: { id: 't_flow_2', name: 'Copy edit', work: 20, deadline: null } })], { now: NOW });
  const a = p.tasks.find((t) => t.id === 't_flow_1');
  const b = p.tasks.find((t) => t.id === 't_flow_2');
  assert.equal(a.work, null);
  assert.equal(a.deadline, null);
  assert.equal(a.duration, 1);
  assert.equal(b.duration, 3, '20 hours at 8 a day is three days');
  assert.deepEqual(p.tasks.slice(-2).map((t) => t.id), ['t_flow_1', 't_flow_2'], 'in the order given');
});

test('resource matching is case- and space-insensitive, only a work resource, and never adds one', () => {
  const { p, ana } = plan();
  const crate = addResource(p, { name: 'Crates', type: 'material' });
  applyOps(p, [addOp(p, { me: '  ana   LIMA ' })], { now: NOW });
  assert.deepEqual(p.tasks.at(-1).assignments, [{ resourceId: ana.id, units: 1 }]);
  const count = p.resources.length;
  applyOps(p, [addOp(p, { id: 'op_2', me: 'Chris', task: { id: 't_flow_2', name: 'B', work: null, deadline: null } })], { now: NOW });
  assert.deepEqual(p.tasks.at(-1).assignments, [], 'no resource by that name: unassigned');
  applyOps(p, [addOp(p, { id: 'op_3', me: undefined, task: { id: 't_flow_3', name: 'C', work: null, deadline: null } })], { now: NOW });
  assert.deepEqual(p.tasks.at(-1).assignments, [], 'no name at all: unassigned');
  applyOps(p, [addOp(p, { id: 'op_4', me: 'crates', task: { id: 't_flow_4', name: 'D', work: null, deadline: null } })], { now: NOW });
  assert.deepEqual(p.tasks.at(-1).assignments, [], 'a material resource is not a person');
  assert.equal(p.resources.length, count, 'no resource was added');
  assert.ok(p.resources.includes(crate));
});

test('timesheet: a line on the task, shaped like the lines Planner writes itself', () => {
  const { p, home, ana } = plan();
  const { applied } = applyOps(p, [sheetOp(p, home.id)], { now: NOW });
  assert.deepEqual(applied, [{ id: 'op_ts_1', at: NOW }]);
  assert.equal(p.timesheets.length, 1);
  const line = p.timesheets[0];
  assert.match(line.id, /^ts/);
  assert.deepEqual({ ...line, id: 'x' }, { id: 'x', taskId: home.id, resourceId: ana.id, date: '2026-09-28', start: 555, hours: 1.25, note: 'Flow timer' });
});

test('timesheet: the same keys as Planner\'s own line, and it survives a save and a reload', () => {
  const { p, home } = plan();
  applyOps(p, [sheetOp(p, home.id)], { now: NOW });
  const mine = addTimesheet(p, { taskId: home.id, resourceId: null, date: '2026-09-28', start: 60, hours: 1, note: 'Worked' });
  assert.deepEqual(Object.keys(p.timesheets[0]).sort(), Object.keys(mine).sort());
  const back = parse(serialize(p)).project;
  assert.deepEqual(back.timesheets[0], p.timesheets[0]);
});

test('timesheet: unassigned when the plan has no one by the player\'s name; no start is no start', () => {
  const { p, home } = plan();
  applyOps(p, [sheetOp(p, home.id, { me: 'Chris', start: null })], { now: NOW });
  assert.equal(p.timesheets[0].resourceId, null);
  assert.equal('start' in p.timesheets[0], false);
});

test('timesheet on a task that no longer exists: skipped, and remembered as applied', () => {
  const { p } = plan();
  const { applied } = applyOps(p, [sheetOp(p, 't_gone')], { now: NOW });
  assert.deepEqual(applied, [{ id: 'op_ts_1', at: NOW }]);
  assert.equal((p.timesheets || []).length, 0);
  assert.deepEqual(p.appliedOps, [{ id: 'op_ts_1', at: NOW }]);
  assert.deepEqual(pendingOps([sheetOp(p, 't_gone')], p, { now: NOW }), []);
});

test('an addTask is then a task a timesheet op can log against, in the same pass', () => {
  const { p } = plan();
  applyOps(p, [addOp(p), sheetOp(p, 't_flow_abc')], { now: NOW });
  assert.equal(p.timesheets.length, 1);
  assert.equal(p.timesheets[0].taskId, 't_flow_abc');
});

test('unknown operation types are ignored and not marked applied', () => {
  const { p } = plan();
  const before = serialize(p);
  const { applied } = applyOps(p, [addOp(p, { id: 'op_future', op: 'renameTask' })], { now: NOW });
  assert.deepEqual(applied, []);
  assert.equal(serialize(p), before, 'the plan is untouched');
});

test('idempotent: applying again, or through the pending list again, changes nothing', () => {
  const { p, home } = plan();
  const ops = [addOp(p), sheetOp(p, home.id)];
  applyOps(p, ops, { now: NOW });
  const once = serialize(p);
  const again = applyOps(p, ops, { now: NOW + 1000 });
  assert.deepEqual(again.applied, []);
  assert.equal(serialize(p), once);
  assert.deepEqual(pendingOps(ops, p, { now: NOW + 1000 }), []);
  // Another device that reads the saved plan sees the same.
  const there = parse(serialize(p)).project;
  assert.deepEqual(there.appliedOps, p.appliedOps);
  assert.deepEqual(pendingOps(ops, there, { now: NOW + 2000 }), []);
});

test('an addTask whose task id is already in the plan adds nothing and is remembered', () => {
  const { p } = plan();
  insertTask(p, p.tasks.length, { id: 't_flow_abc', name: 'Already here', level: 1 });
  const n = p.tasks.length;
  const { applied } = applyOps(p, [addOp(p)], { now: NOW });
  assert.equal(p.tasks.length, n);
  assert.deepEqual(applied.map((a) => a.id), ['op_add_1']);
});

test('an operation for another plan is not applied to this one', () => {
  const { p } = plan();
  const n = p.tasks.length;
  const { applied } = applyOps(p, [addOp(p, { plan: 'plan_elsewhere' })], { now: NOW });
  assert.deepEqual(applied, []);
  assert.equal(p.tasks.length, n);
});

test('applied ids are kept for 90 days, then pruned; an operation older than that is no longer pending', () => {
  const { p } = plan();
  assert.equal(KEEP_APPLIED_MS, 90 * DAY);
  p.appliedOps = [{ id: 'op_old', at: NOW - 91 * DAY }, { id: 'op_recent', at: NOW - 89 * DAY }];
  applyOps(p, [addOp(p)], { now: NOW });
  assert.deepEqual(p.appliedOps.map((a) => a.id), ['op_recent', 'op_add_1']);
  // Once its id is pruned, the operation itself is past the window, so it never comes back.
  const old = addOp(p, { id: 'op_old', at: NOW - 92 * DAY, task: { id: 't_flow_old', name: 'Old', work: null, deadline: null } });
  assert.deepEqual(pendingOps([old], p, { now: NOW }), []);
});

test('appliedOps survive a save and a reload, and a plan without any has none', () => {
  const { p } = plan();
  assert.equal(parse(serialize(p)).project.appliedOps, undefined);
  applyOps(p, [addOp(p)], { now: NOW });
  const raw = JSON.parse(serialize(p));
  raw.appliedOps.push({ id: 42 }, null, { id: 'op_bad_at', at: 'yesterday' });
  assert.deepEqual(parse(JSON.stringify(raw)).project.appliedOps, [{ id: 'op_add_1', at: NOW }], 'malformed entries are dropped');
});

test('applyToRecord: a shelf plan is parsed, changed and written back newer; nothing to do is null', () => {
  const { p, home } = plan();
  const record = { id: p.id, type: 'document', format: 'project-planner', name: p.name, body: serialize(p), updatedAt: NOW + 5000, deletedAt: null, origin: 'mac1' };
  const ops = [addOp(p), sheetOp(p, home.id)];
  const next = applyToRecord(record, ops, { now: NOW, origin: 'web1' });
  assert.ok(next.updatedAt > record.updatedAt, 'newer than what it replaces, even with a clock behind');
  assert.equal(next.origin, 'web1');
  assert.equal(next.id, record.id);
  assert.equal(next.name, record.name);
  assert.equal(next.format, 'project-planner');
  const q = parse(next.body).project;
  assert.equal(q.tasks.at(-1).id, 't_flow_abc');
  assert.equal(q.timesheets.length, 1);
  assert.deepEqual(q.appliedOps.map((a) => a.id), ['op_add_1', 'op_ts_1']);
  assert.equal(applyToRecord(next, ops, { now: NOW, origin: 'web1' }), null, 'already applied');
  assert.equal(applyToRecord({ ...record, body: 'not json' }, ops, { now: NOW, origin: 'web1' }), null, 'unreadable');
  assert.equal(applyToRecord({ ...record, deletedAt: NOW }, ops, { now: NOW, origin: 'web1' }), null, 'deleted');
});
