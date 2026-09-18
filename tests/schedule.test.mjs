// Run with:  node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeCalendar, toDay, fromDay, parseDuration, weekday } from '../src/model/calendar.js';
import {
  createProject, insertTask, removeTasks, indentTasks, outdentTasks, moveTask, link, linkError, linkChain, unlinkAll,
  isSummary, wbsCodes, parsePredecessors, formatPredecessors, addResource, assign, parseAssignments, formatAssignments,
  setTaskField, setFinish, topoOrder, normalizeLevels,
} from '../src/model/model.js';
import { computeSchedule, resourceLoad, networkRanks } from '../src/model/schedule.js';
import { validate } from '../src/model/validate.js';
import { sampleProject } from '../src/model/sample.js';
import { serialize, parse } from '../src/io/json.js';

const MON = '2026-09-21'; // a Monday
const d = (iso) => toDay(iso);

function plan(start = MON) {
  const p = createProject('T', start);
  return p;
}
const task = (p, name, duration, level = 1) => insertTask(p, p.tasks.length, { name, duration, level });

test('calendar skips weekends and holidays', () => {
  const cal = makeCalendar({ workDays: [1, 2, 3, 4, 5], hoursPerDay: 8, holidays: ['2026-09-23'] });
  assert.equal(weekday(d(MON)), 1);
  assert.equal(fromDay(cal.next(d('2026-09-19'))), MON, 'Saturday → Monday');
  assert.equal(fromDay(cal.add(d(MON), 1)), '2026-09-22');
  assert.equal(fromDay(cal.add(d(MON), 2)), '2026-09-24', 'the holiday on Wednesday is skipped');
  assert.equal(fromDay(cal.add(d(MON), 4)), '2026-09-28', 'over the weekend');
  assert.equal(fromDay(cal.add(d('2026-09-28'), -4)), MON);
  assert.equal(cal.between(d(MON), d('2026-09-25')), 4);
  assert.equal(cal.distance(d(MON), d('2026-09-28')), 4);
  assert.equal(cal.distance(d('2026-09-28'), d(MON)), -4);
  assert.equal(cal.distance(d(MON), d(MON)), 0);
});

test('durations parse in days, weeks and hours', () => {
  assert.equal(parseDuration('5d'), 5);
  assert.equal(parseDuration('2w'), 10);
  assert.equal(parseDuration('4h'), 0.5);
  assert.equal(parseDuration('3'), 3);
  assert.equal(parseDuration(''), 0);
  assert.throws(() => parseDuration('soon'));
  assert.throws(() => parseDuration('-2d'));
});

test('finish-to-start chain, weekends and slack', () => {
  const p = plan();
  const a = task(p, 'A', 3), b = task(p, 'B', 2), c = task(p, 'C', 1);
  link(p, a.id, b.id);
  link(p, a.id, c.id);
  const s = computeSchedule(p);
  assert.equal(s.tasks[a.id].startIso, MON);
  assert.equal(s.tasks[a.id].finishIso, '2026-09-23');
  assert.equal(s.tasks[b.id].startIso, '2026-09-24');
  assert.equal(s.tasks[b.id].finishIso, '2026-09-25');
  assert.equal(s.tasks[c.id].startIso, '2026-09-24');
  assert.equal(s.finishIso, '2026-09-25');
  assert.equal(s.duration, 5);
  assert.equal(s.tasks[c.id].slack, 1, 'C could slip a day');
  assert.equal(s.tasks[c.id].critical, false);
  assert.ok(s.tasks[a.id].critical && s.tasks[b.id].critical);
  assert.equal(s.criticalCount, 2);
});

test('link types and lag', () => {
  const p = plan();
  const a = task(p, 'A', 5), ss = task(p, 'SS', 2), ff = task(p, 'FF', 2), sf = task(p, 'SF', 1), lag = task(p, 'LAG', 1), neg = task(p, 'NEG', 1);
  link(p, a.id, ss.id, 'SS', 1);
  link(p, a.id, ff.id, 'FF', 0);
  link(p, a.id, sf.id, 'SF', 0);
  link(p, a.id, lag.id, 'FS', 2);
  link(p, a.id, neg.id, 'FS', -2);
  const s = computeSchedule(p);
  assert.equal(s.tasks[ss.id].startIso, '2026-09-22', 'SS+1: a day after A starts');
  assert.equal(s.tasks[ff.id].finishIso, '2026-09-25', 'FF: finishes with A');
  assert.equal(s.tasks[ff.id].startIso, '2026-09-24');
  assert.equal(s.tasks[sf.id].finishIso, MON, 'SF: finishes when A starts');
  assert.equal(s.tasks[lag.id].startIso, '2026-09-30', 'FS+2: two working days after A');
  assert.equal(s.tasks[neg.id].startIso, '2026-09-24', 'FS-2: overlaps the last two days of A');
});

test('summary tasks roll up their children and carry their links down', () => {
  const p = plan();
  const pre = task(p, 'Pre', 2);
  const sum = task(p, 'Phase', 0);
  const x = task(p, 'X', 3, 2), y = task(p, 'Y', 4, 2);
  const post = task(p, 'Post', 1);
  link(p, pre.id, sum.id);
  link(p, sum.id, post.id);
  assert.ok(isSummary(p, 1));
  const s = computeSchedule(p);
  assert.equal(s.tasks[x.id].startIso, '2026-09-23', 'children start after the summary’s predecessor');
  assert.equal(s.tasks[sum.id].startIso, '2026-09-23');
  assert.equal(s.tasks[sum.id].finishIso, '2026-09-28', 'summary finish = latest child (Y: 23,24,25,28)');
  assert.equal(s.tasks[sum.id].duration, 4);
  assert.equal(s.tasks[post.id].startIso, '2026-09-29', 'successor waits for the whole summary');
  assert.equal(s.tasks[x.id].slack, 1, 'X has a day of slack inside the summary');
  assert.equal(s.tasks[y.id].critical, true);
  assert.equal(s.tasks[sum.id].critical, true);
  assert.deepEqual(wbsCodes(p), ['1', '2', '2.1', '2.2', '3']);
});

test('links into or out of a subtask from its own summary, and cycles, are refused', () => {
  const p = plan();
  const sum = task(p, 'S', 0);
  const x = task(p, 'X', 1, 2), y = task(p, 'Y', 1, 2);
  const z = task(p, 'Z', 1);
  assert.ok(linkError(p, sum.id, x.id));
  assert.ok(linkError(p, x.id, sum.id));
  assert.ok(linkError(p, x.id, x.id));
  link(p, x.id, y.id);
  link(p, y.id, z.id);
  assert.match(linkError(p, z.id, x.id), /circular/);
  assert.throws(() => link(p, z.id, x.id));
  // the summary depends on its children, so a child cannot depend on something after the summary
  assert.match(linkError(p, z.id, sum.id), /circular/);
  assert.equal(topoOrder(p).cyclic.length, 0);
});

test('a cycle in a loaded file still schedules the rest', () => {
  const p = plan();
  const a = task(p, 'A', 1), b = task(p, 'B', 1), c = task(p, 'C', 1);
  a.predecessors = [{ id: b.id, type: 'FS', lag: 0 }];
  b.predecessors = [{ id: a.id, type: 'FS', lag: 0 }];
  const s = computeSchedule(p);
  assert.deepEqual(s.cyclic.sort(), [a.id, b.id].sort());
  assert.equal(s.tasks[c.id].startIso, MON);
  assert.ok(validate(p, s).some((i) => i.code === 'cycle'));
});

test('constraints and deadlines', () => {
  const p = plan();
  const a = task(p, 'A', 2), b = task(p, 'B', 2), c = task(p, 'C', 1);
  link(p, a.id, b.id);
  b.constraint = { type: 'SNET', date: '2026-09-28' };
  c.constraint = { type: 'MSO', date: '2026-09-26' }; // a Saturday → next working day
  let s = computeSchedule(p);
  assert.equal(s.tasks[b.id].startIso, '2026-09-28');
  assert.equal(s.tasks[c.id].startIso, '2026-09-28');
  b.deadline = '2026-09-25';
  s = computeSchedule(p);
  assert.ok(s.tasks[b.id].deadlineMissed);
  assert.ok(s.tasks[b.id].slack < 0, 'a missed deadline shows as negative slack');
  const codes = validate(p, s).map((i) => i.code);
  assert.ok(codes.includes('deadline-missed') && codes.includes('negative-slack'));
  // a must-start-on earlier than its predecessor allows is honoured, and the predecessor goes negative
  b.deadline = null;
  b.constraint = { type: 'MSO', date: MON };
  s = computeSchedule(p);
  assert.equal(s.tasks[b.id].startIso, MON);
  assert.ok(s.tasks[a.id].slack < 0);
});

test('milestones take no time', () => {
  const p = plan();
  const a = task(p, 'A', 1), m = task(p, 'M', 0), b = task(p, 'B', 1);
  link(p, a.id, m.id); link(p, m.id, b.id);
  const s = computeSchedule(p);
  assert.ok(s.tasks[m.id].milestone);
  assert.equal(s.tasks[m.id].startIso, '2026-09-22');
  assert.equal(s.tasks[m.id].finishIso, '2026-09-22');
  assert.equal(s.tasks[b.id].startIso, '2026-09-23');
});

test('outline editing: indent, outdent, move, delete with subtasks', () => {
  const p = plan();
  const a = task(p, 'A', 1), b = task(p, 'B', 1), c = task(p, 'C', 1), dd = task(p, 'D', 1);
  assert.equal(indentTasks(p, [a.id]), 0, 'the first task cannot be indented');
  indentTasks(p, [b.id, c.id]);
  assert.deepEqual(p.tasks.map((t) => t.level), [1, 2, 2, 1]);
  assert.ok(isSummary(p, 0));
  assert.equal(indentTasks(p, [c.id]), 1);
  assert.deepEqual(p.tasks.map((t) => t.level), [1, 2, 3, 1]);
  outdentTasks(p, [b.id]);
  assert.deepEqual(p.tasks.map((t) => t.level), [1, 1, 2, 1], 'C stays under B');
  assert.ok(moveTask(p, dd.id, -1));
  assert.deepEqual(p.tasks.map((t) => t.name), ['A', 'D', 'B', 'C'], 'D jumps over the whole B block');
  assert.ok(!moveTask(p, a.id, -1));
  link(p, a.id, c.id);
  assert.equal(removeTasks(p, [b.id]), 2, 'a summary takes its subtasks with it');
  assert.deepEqual(p.tasks.map((t) => t.name), ['A', 'D']);
  assert.equal(p.tasks.every((t) => t.predecessors.every((l) => p.tasks.some((x) => x.id === l.id))), true);
  p.tasks[1].level = 5;
  assert.equal(normalizeLevels(p).length, 1);
  assert.equal(p.tasks[1].level, 2);
});

test('predecessor text round-trips and resource text creates resources', () => {
  const p = plan();
  const a = task(p, 'A', 1), b = task(p, 'B', 1), c = task(p, 'C', 1);
  c.predecessors = parsePredecessors(p, '1FS+2d, 2SS-1d', c.id);
  assert.deepEqual(c.predecessors, [{ id: a.id, type: 'FS', lag: 2 }, { id: b.id, type: 'SS', lag: -1 }]);
  assert.equal(formatPredecessors(p, c), '1FS+2d, 2SS-1d');
  b.predecessors = parsePredecessors(p, '1', b.id);
  assert.equal(formatPredecessors(p, b), '1');
  assert.throws(() => parsePredecessors(p, '9', c.id), /no task 9/);
  assert.throws(() => parsePredecessors(p, '3', a.id), /circular/);
  a.assignments = parseAssignments(p, 'Ana [50%], Ben');
  assert.equal(p.resources.length, 2);
  assert.equal(formatAssignments(p, a), 'Ana [50%], Ben');
  assert.equal(linkChain(p, [a.id, b.id, c.id]), 0, 'every link in the chain already exists');
  assert.equal(unlinkAll(p, [c.id]), 2);
});

test('field edits: a typed start pins the task, a typed finish stretches it', () => {
  const p = plan();
  const a = task(p, 'A', 1);
  setTaskField(p, a.id, 'start', '2026-09-23');
  assert.deepEqual(a.constraint, { type: 'SNET', date: '2026-09-23' });
  let s = computeSchedule(p);
  assert.equal(s.tasks[a.id].startIso, '2026-09-23');
  setFinish(p, a.id, s.tasks[a.id].startIso, '2026-09-29');
  assert.equal(a.duration, 5);
  setTaskField(p, a.id, 'duration', '0d');
  assert.ok(a.milestone);
});

test('percent validation rejects out-of-range values', () => {
  const p = plan();
  const a = task(p, 'A', 1);
  assert.throws(() => setTaskField(p, a.id, 'percent', '150'));
  setTaskField(p, a.id, 'percent', '40%');
  assert.equal(a.percent, 40);
});

test('work, cost and over-allocation', () => {
  const p = plan();
  const r = addResource(p, { name: 'Ann', rate: 100 });
  const a = task(p, 'A', 2), b = task(p, 'B', 2);
  assign(p, a.id, r.id, 1);
  assign(p, b.id, r.id, 0.5);
  a.fixedCost = 50;
  const s = computeSchedule(p);
  assert.equal(s.tasks[a.id].work, 16);
  assert.equal(s.tasks[a.id].cost, 1650);
  assert.equal(s.work, 24);
  assert.equal(s.cost, 1650 + 800);
  const load = resourceLoad(p, s);
  assert.equal(load.get(r.id).get(d(MON)).length, 2);
  const over = validate(p, s).find((i) => i.code === 'overallocated');
  assert.ok(over, 'A and B overlap at 150%');
  assert.equal(over.days.length, 2);
});

test('the sample plan schedules cleanly and round-trips through JSON', () => {
  const p = sampleProject();
  const s = computeSchedule(p);
  assert.equal(s.cyclic.length, 0);
  assert.equal(s.startIso, '2026-09-21');
  assert.ok(s.finish > s.start + 60);
  assert.ok(s.criticalCount > 3);
  assert.ok(s.cost > 0);
  const issues = validate(p, s);
  assert.ok(!issues.some((i) => i.level === 'error'), issues.filter((i) => i.level === 'error').map((i) => i.text).join('; '));
  const { project, repairs } = parse(serialize(p));
  assert.deepEqual(repairs, []);
  assert.deepEqual(computeSchedule(project).tasks, s.tasks);
  const ranks = networkRanks(p, s);
  assert.equal(ranks.get('t_02'), 0);
  assert.ok(ranks.get('t_24') > 5);
});

test('loading repairs a damaged file', () => {
  const { project, repairs } = parse(JSON.stringify({
    name: 'X', start: 'nope',
    tasks: [{ id: 'a', name: 'A', level: 3, duration: -1, predecessors: [{ id: 'zzz' }, { id: 'a' }] }, { name: 'B', level: 1 }],
    resources: [{ name: 'R' }],
  }));
  assert.equal(project.tasks.length, 2);
  assert.equal(project.tasks[0].level, 1);
  assert.equal(project.tasks[0].duration, 1);
  assert.equal(project.tasks[0].predecessors.length, 0);
  assert.ok(repairs.length >= 3);
  assert.throws(() => parse('{"nope":1}'));
});
