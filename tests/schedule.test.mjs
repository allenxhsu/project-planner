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
  // Looked at as of its own start, so placement does not depend on the day the
  // tests happen to run — the calendar never places work before its status date.
  p.statusDate = start;
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
  // Over-allocation is judged on the hours the plan really expects, so this
  // one says outright that an unstated task is full time.
  p.agenda = { ...p.agenda, assumedLoad: 100 };
  const load = resourceLoad(p, s);
  assert.equal(load.get(r.id).get(d(MON)).length, 2);
  const over = validate(p, s).find((i) => i.code === 'overallocated');
  assert.ok(over, 'A and B overlap at 150%');
  assert.equal(over.days.length, 2);

  // At the default assumption — half a day unless a task says otherwise —
  // the same two tasks are 75% of a day and nobody is over-allocated.
  p.agenda = { ...p.agenda, assumedLoad: 50 };
  assert.equal(validate(p, computeSchedule(p)).some((i) => i.code === 'overallocated'), false);
  const half = resourceLoad(p, computeSchedule(p));
  assert.equal(half.get(r.id).get(d(MON)).reduce((n, x) => n + x.hours, 0), 6, 'four hours plus two');
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

// ---------------------------------------------------------------------------
// Sync, document level. The engine and the merge are sync-kit's own tests;
// what belongs here is the one rule this app decides for itself.
// ---------------------------------------------------------------------------

test('a plan that arrived elsewhere replaces this one only when nothing is unsaved', async () => {
  const { decideRemote } = await import('../src/state/sync.js');
  const mine = { id: 'plan_a', type: 'document', body: '{}', updatedAt: 2, origin: 'other' };
  const other = { id: 'plan_b', type: 'document', body: '{}', updatedAt: 2, origin: 'other' };

  assert.equal(decideRemote({ dirty: false, applied: [mine], planId: 'plan_a' }).action, 'take');
  assert.equal(decideRemote({ dirty: true, applied: [mine], planId: 'plan_a' }).action, 'ask',
    'unsaved work is never discarded without asking');
  assert.equal(decideRemote({ dirty: false, applied: [other], planId: 'plan_a' }).action, 'ignore',
    'another plan changing is not this plan changing');
  assert.equal(decideRemote({ dirty: false, applied: [], planId: 'plan_a' }).action, 'ignore');
  assert.equal(decideRemote({ dirty: false, applied: [{ ...mine, deletedAt: 3 }], planId: 'plan_a' }).action, 'ignore',
    'a tombstone is not a plan to open');
  assert.equal(decideRemote({ dirty: false, applied: [mine], planId: 'plan_a' }).remote, mine);
});

test('a plan keeps its id through save and load, and the sample has a fixed one', () => {
  const p = sampleProject();
  assert.equal(p.id, 'plan_sample_website_relaunch');
  const { project } = parse(serialize(p));
  assert.equal(project.id, p.id, 'the id is what makes two devices agree this is one plan');
  const fresh = parse(JSON.stringify({ name: 'X', tasks: [{ name: 'A' }] })).project;
  assert.match(fresh.id, /^plan_/, 'a plan written before ids existed gets one');
});

// ---------------------------------------------------------------------------
// Stages (the Kanban columns the plan owns) and timesheets (time actually
// spent, as against the work the plan expects).
// ---------------------------------------------------------------------------

test('a task sits in a stage, and a finished stage means finished', async () => {
  const { stages, stageOf, setStage, addStage, removeStage, moveStage, setStageDone, DEFAULT_STAGES } = await import('../src/model/model.js');
  const p = plan();
  const a = task(p, 'A', 2), b = task(p, 'B', 2);
  assert.deepEqual(stages(p).map((s) => s.name), DEFAULT_STAGES.map((s) => s.name));
  assert.equal(stageOf(p, a).id, 'stage_todo', 'a task nobody moved is in the first column');

  setStage(p, a.id, 'stage_done');
  assert.equal(a.percent, 100, 'a stage that means finished finishes the task');
  setTaskField(p, a.id, 'percent', '40');
  assert.notEqual(stageOf(p, a).id, 'stage_done', '...and taking it off 100% moves it back out');

  setTaskField(p, b.id, 'percent', '100');
  assert.equal(stageOf(p, b).id, 'stage_done', 'completing a task puts it in the finished column');

  const review = addStage(p, 'Review');
  assert.deepEqual(stages(p).map((s) => s.name), ['To do', 'In progress', 'Review', 'Done'], 'a new column goes before the finished ones');
  assert.ok(moveStage(p, review.id, -1));
  assert.deepEqual(stages(p).map((s) => s.name), ['To do', 'Review', 'In progress', 'Done']);

  setStage(p, a.id, review.id);
  removeStage(p, review.id);
  assert.equal(stageOf(p, a).id, stages(p)[0].id, 'deleting a column sends its tasks back to the first');
  assert.throws(() => setStageDone(p, 'stage_done', false), /one column that means finished/);
});

test('timesheets record what was spent, and roll up', async () => {
  const { addTimesheet, spentOn, removeTimesheet, setTimesheetField } = await import('../src/model/model.js');
  const p = plan();
  const r = addResource(p, { name: 'Ann', rate: 100 });
  const sum = task(p, 'Phase', 0);
  const a = task(p, 'A', 2, 2), b = task(p, 'B', 2, 2);
  assign(p, a.id, r.id, 1);
  assign(p, b.id, r.id, 1);

  addTimesheet(p, { taskId: a.id, resourceId: r.id, date: MON, hours: 5 });
  addTimesheet(p, { taskId: a.id, resourceId: r.id, date: '2026-09-22', hours: 2.5 });
  addTimesheet(p, { taskId: b.id, resourceId: r.id, date: MON, hours: 20 });
  assert.equal(spentOn(p, a.id), 7.5);

  const s = computeSchedule(p);
  assert.equal(s.tasks[a.id].work, 16, 'work is what the plan expects');
  assert.equal(s.tasks[a.id].spent, 7.5);
  assert.equal(s.tasks[a.id].remaining, 8.5);
  assert.equal(s.tasks[b.id].remaining, 0, 'overrunning an estimate leaves nothing, never a negative');
  assert.equal(s.tasks[sum.id].spent, 27.5, 'a summary adds up its children');
  assert.equal(s.spent, 27.5);

  assert.throws(() => addTimesheet(p, { taskId: a.id, hours: -1 }), /never negative/);
  assert.throws(() => addTimesheet(p, { taskId: 'nope', hours: 1 }), /belongs to a task/);
  assert.throws(() => setTimesheetField(p, p.timesheets[0].id, 'date', 'yesterday'), /is a date/);

  // Deleting the task takes its lines with it; nothing is left pointing nowhere.
  removeTasks(p, [a.id]);
  assert.equal(p.timesheets.length, 1);
  removeTimesheet(p, p.timesheets[0].id);
  assert.equal(p.timesheets.length, 0);
});

test('stages and timesheets survive the file, and a damaged one is repaired', async () => {
  const { addTimesheet, addStage, stageOf } = await import('../src/model/model.js');
  const p = sampleProject();
  const review = addStage(p, 'Review');
  p.tasks[2].stageId = review.id;
  addTimesheet(p, { taskId: p.tasks[2].id, resourceId: p.resources[0].id, date: '2026-09-22', hours: 6 });

  const { project, repairs } = parse(serialize(p));
  assert.deepEqual(repairs, []);
  assert.deepEqual(project.stages.map((s) => s.name), p.stages.map((s) => s.name));
  assert.equal(stageOf(project, project.tasks[2]).name, 'Review');
  assert.equal(project.timesheets.length, 1);
  assert.equal(computeSchedule(project).tasks[project.tasks[2].id].spent, 6);

  // A file whose stage list has no finished column, and lines pointing nowhere.
  const damaged = JSON.parse(serialize(p));
  damaged.stages = damaged.stages.map((s) => ({ ...s, done: false }));
  damaged.tasks[0].stageId = 'stage_that_never_was';
  damaged.timesheets.push({ id: 'x', taskId: 'no_such_task', hours: 3 });
  const out = parse(JSON.stringify(damaged));
  assert.ok(out.project.stages[out.project.stages.length - 1].done, 'the last column is made to mean finished');
  assert.equal(out.project.tasks[0].stageId, null, 'a stage that does not exist is dropped');
  assert.equal(out.project.timesheets.length, 1, 'a line pointing at no task is dropped');
  assert.ok(out.repairs.length >= 2);
});

// ---------------------------------------------------------------------------
// The agenda: turning "18 hours, Tuesday to Friday" into blocks on a calendar.
// ---------------------------------------------------------------------------

test('a task asking for the calendar is laid into blocks of the size it asks for', async () => {
  const { planBlocks, agendaOf, parseTime, formatTime, hoursLeft } = await import('../src/model/agenda.js');
  const p = plan();
  const r = addResource(p, { name: 'Ann' });
  const a = task(p, 'Design', 2);           // 2 days × 8h = 16 hours of work
  assign(p, a.id, r.id, 1);
  // This one is about laying blocks, so it says outright that the two days are
  // two days of work and that a day may be filled.
  p.agenda = { ...p.agenda, assumedLoad: 100, dailyCap: 8 };
  setTaskField(p, a.id, 'calendarShow', true);
  setTaskField(p, a.id, 'blockHours', 2);
  setTaskField(p, a.id, 'calendarFrom', '09:00');
  setTaskField(p, a.id, 'calendarTo', '17:00');

  const s = computeSchedule(p);
  assert.equal(hoursLeft(p, s.tasks[a.id]), 16);
  const { blocks, overflow } = planBlocks(p, s);
  assert.equal(blocks.length, 8, '16 hours in two-hour blocks');
  assert.deepEqual(overflow, []);
  assert.equal(new Set(blocks.map((b) => b.day)).size, 2, 'eight hours a day fills two days');
  assert.equal(formatTime(blocks[0].start), '09:00');
  assert.equal(formatTime(blocks[0].end), '11:00');
  assert.equal(formatTime(blocks[3].end), '17:00', 'the window is respected');
  assert.equal(blocks[0].dateIso, MON);

  // Logged hours come off what still needs a block.
  const { addTimesheet } = await import('../src/model/model.js');
  addTimesheet(p, { taskId: a.id, resourceId: r.id, date: MON, hours: 8 });
  assert.equal(planBlocks(p, computeSchedule(p)).blocks.length, 4, 'half the work is done, half the blocks remain');
});

test('two tasks for one person never overlap, and a different person is free at the same hour', async () => {
  const { planBlocks } = await import('../src/model/agenda.js');
  const p = plan();
  const ann = addResource(p, { name: 'Ann' }), bob = addResource(p, { name: 'Bob' });
  const one = task(p, 'One', 1), two = task(p, 'Two', 1), three = task(p, 'Three', 1);
  assign(p, one.id, ann.id, 1); assign(p, two.id, ann.id, 1); assign(p, three.id, bob.id, 1);
  for (const t of [one, two, three]) { setTaskField(p, t.id, 'calendarShow', true); setTaskField(p, t.id, 'blockHours', 4); }

  const { blocks } = planBlocks(p, computeSchedule(p));
  const annBlocks = blocks.filter((b) => b.lane === ann.id).sort((x, y) => x.day - y.day || x.start - y.start);
  for (let i = 1; i < annBlocks.length; i++) {
    const prev = annBlocks[i - 1], now = annBlocks[i];
    assert.ok(now.day > prev.day || now.start >= prev.end, 'one person cannot be in two places');
  }
  const bobFirst = blocks.find((b) => b.lane === bob.id);
  const annFirst = annBlocks[0];
  assert.equal(bobFirst.day, annFirst.day);
  assert.equal(bobFirst.start, annFirst.start, 'two people can work the same hour');
  // Ann has 16 hours in an 8-hour window, so her work runs into the next day.
  assert.equal(new Set(annBlocks.map((b) => b.day)).size, 2);
});

test('a block that cannot fit the window is reported rather than hidden', async () => {
  const { planBlocks } = await import('../src/model/agenda.js');
  const p = plan();
  const a = task(p, 'Workshop', 1);
  setTaskField(p, a.id, 'calendarShow', true);
  setTaskField(p, a.id, 'blockHours', 4);
  setTaskField(p, a.id, 'calendarFrom', '09:00');
  setTaskField(p, a.id, 'calendarTo', '11:00');     // two hours a day, four-hour blocks
  const { blocks, overflow } = planBlocks(p, computeSchedule(p));
  assert.equal(blocks.length, 0);
  assert.equal(overflow.length, 1);
  assert.equal(overflow[0].reason, 'window-too-short');
  assert.throws(() => setTaskField(p, a.id, 'calendarTo', '08:00'), /end after it starts/);
  assert.throws(() => setTaskField(p, a.id, 'blockHours', 3), /one of 0.5, 1, 1.5, 2, 4/);
});

test('breaking a task up makes it a summary of its parts', async () => {
  const { breakIntoSubtasks, isSummary } = await import('../src/model/model.js');
  const p = plan();
  const r = addResource(p, { name: 'Ann' });
  const a = task(p, 'Design the layout', 6);
  assign(p, a.id, r.id, 1);
  setTaskField(p, a.id, 'calendarShow', true);
  const parts = breakIntoSubtasks(p, a.id, 3, ['Grid', 'Type', 'Colour']);
  assert.equal(parts.length, 3);
  assert.deepEqual(p.tasks.map((t) => t.name), ['Design the layout', 'Grid', 'Type', 'Colour']);
  assert.deepEqual(p.tasks.map((t) => t.level), [1, 2, 2, 2]);
  assert.ok(isSummary(p, 0));
  assert.deepEqual(parts.map((t) => t.duration), [2, 2, 2]);
  assert.equal(parts[0].assignments.length, 1, 'the parts are the same work, so the same person');
  assert.equal(parts[0].calendar.show, true);
  const s = computeSchedule(p);
  assert.equal(s.tasks[a.id].duration, 6, 'the summary still spans the same six days');
  assert.throws(() => breakIntoSubtasks(p, a.id, 2), /already has subtasks/);
});

test('the priority list puts what is late and unblocked first', async () => {
  const { priorities } = await import('../src/model/agenda.js');
  const p = plan();
  const early = task(p, 'Late thing', 2);
  const blocked = task(p, 'Blocked thing', 2);
  const later = task(p, 'Later thing', 2);
  link(p, early.id, blocked.id);
  p.statusDate = '2026-10-05';                  // a fortnight after everything started
  later.constraint = { type: 'SNET', date: '2026-11-02' };
  const s = computeSchedule(p);
  const list = priorities(p, s, { now: toDay('2026-10-05') });

  assert.equal(list[0].taskId, early.id, 'the overdue, unblocked task is first');
  assert.ok(list[0].reasons.some((r) => /should have finished/.test(r)));
  const blockedRow = list.find((r) => r.taskId === blocked.id);
  assert.ok(blockedRow.blocked);
  assert.ok(blockedRow.reasons.some((r) => /waiting on 1 task/.test(r)));
  assert.ok(blockedRow.score < list[0].score, 'work that cannot be started ranks below work that can');
  assert.ok(list.every((r) => r.info.percent < 100), 'finished work is not on the list');
});

test('a named time block decides which hours and which days a task may use', async () => {
  const { planBlocks, agendaOf, formatTime } = await import('../src/model/agenda.js');
  const { addTimeBlock, setTimeBlockField, removeTimeBlock, timeBlocks } = await import('../src/model/model.js');
  const p = plan();                                   // starts Monday 21 Sep 2026
  p.calendar.workDays = [0, 1, 2, 3, 4, 5, 6];        // the plan itself works every day
  const study = addTimeBlock(p, { name: 'Study', from: '06:00', to: '08:00', days: [0, 1, 2, 3, 4, 5, 6] });
  const focus = addTimeBlock(p, { name: 'Deep focus', from: '08:00', to: '10:00', days: [1, 2, 3, 4, 5] });

  p.agenda = { ...p.agenda, assumedLoad: 100, dailyCap: 8 };
  const reading = task(p, 'Reading', 3);   // 24 hours, at two a morning: twelve mornings
  setTaskField(p, reading.id, 'calendarShow', true);
  setTaskField(p, reading.id, 'blockHours', 2);
  setTaskField(p, reading.id, 'timeBlock', study.id);

  const a = agendaOf(p, reading);
  assert.equal(formatTime(a.from), '06:00');
  assert.equal(formatTime(a.to), '08:00');
  assert.deepEqual(a.days, [0, 1, 2, 3, 4, 5, 6]);

  const { blocks } = planBlocks(p, computeSchedule(p));
  assert.equal(blocks.length, 12, 'twenty-four hours of work at two hours a morning');
  assert.ok(blocks.every((b) => formatTime(b.start) === '06:00'), 'every block starts when the study block does');
  assert.ok(blocks.some((b) => [0, 6].includes(((b.day + 4) % 7 + 7) % 7)), 'a block covering every day uses the weekend');

  // A weekday-only block never lands on a Saturday or a Sunday.
  setTaskField(p, reading.id, 'timeBlock', focus.id);
  const weekdayOnly = planBlocks(p, computeSchedule(p)).blocks;
  assert.ok(weekdayOnly.length > 0);
  assert.ok(weekdayOnly.every((b) => ![0, 6].includes(((b.day + 4) % 7 + 7) % 7)), 'weekdays only');
  assert.ok(weekdayOnly.every((b) => formatTime(b.start) === '08:00'));

  assert.throws(() => setTimeBlockField(p, study.id, 'to', '05:00'), /end after it starts/);
  assert.throws(() => setTimeBlockField(p, study.id, 'days', []), /at least one day/);
  // Deleting a block sends its tasks back to the plan's default hours.
  removeTimeBlock(p, focus.id);
  const { timeBlockIdsOf } = await import('../src/model/model.js');
  assert.deepEqual(timeBlockIdsOf(reading), [], 'the task is no longer in that block');
  assert.ok(!timeBlocks(p).some((b) => b.id === focus.id));
});

test('only the phase the plan is in reaches the calendar', async () => {
  const { planBlocks } = await import('../src/model/agenda.js');
  const { phases, phaseOf, inCurrentPhase, addPhase } = await import('../src/model/model.js');
  const p = plan();
  const designHead = task(p, 'Design', 0);
  const wire = task(p, 'Wireframes', 2, 2);
  const buildHead = task(p, 'Build', 0);
  const cms = task(p, 'CMS integration', 2, 2);
  for (const t of [wire, cms]) setTaskField(p, t.id, 'calendarShow', true);

  // Phases are named, not read off the outline, and a heading passes its phase
  // down to everything under it.
  const design = addPhase(p, { name: 'Design' });
  const build = addPhase(p, { name: 'Build' });
  designHead.phaseId = design.id;
  buildHead.phaseId = build.id;

  assert.deepEqual(phases(p).map((x) => x.name), ['Design', 'Build']);
  assert.equal(phaseOf(p, wire.id), design.id, 'inherited from the heading above it');
  assert.equal(phaseOf(p, cms.id), build.id);
  assert.equal(planBlocks(p, computeSchedule(p)).blocks.length > 0, true);
  const everything = new Set(planBlocks(p, computeSchedule(p)).blocks.map((b) => b.taskId));
  assert.deepEqual([...everything].sort(), [wire.id, cms.id].sort(), 'with no phase set, everything is released');

  p.currentPhaseId = design.id;
  assert.ok(inCurrentPhase(p, wire.id));
  assert.ok(!inCurrentPhase(p, cms.id));
  const onlyDesign = new Set(planBlocks(p, computeSchedule(p)).blocks.map((b) => b.taskId));
  assert.deepEqual([...onlyDesign], [wire.id], 'build work stays off the calendar while the plan is in design');

  // A phase that was deleted must not empty the calendar.
  p.currentPhaseId = 'gone';
  assert.equal(new Set(planBlocks(p, computeSchedule(p)).blocks.map((b) => b.taskId)).size, 2);

  // A task in no phase at all is released whatever the plan is working on:
  // saying nothing cannot mean "not yet".
  const loose = task(p, 'Write the README', 1, 1);
  setTaskField(p, loose.id, 'calendarShow', true);
  p.currentPhaseId = design.id;
  assert.ok(inCurrentPhase(p, loose.id));
  assert.ok(new Set(planBlocks(p, computeSchedule(p)).blocks.map((b) => b.taskId)).has(loose.id));
});

test('a gap keeps blocks off each other’s heels', async () => {
  const { planBlocks, formatTime } = await import('../src/model/agenda.js');
  const p = plan();
  const r = addResource(p, { name: 'Ann' });
  const a = task(p, 'Deep work', 1);        // 8 hours
  assign(p, a.id, r.id, 1);
  setTaskField(p, a.id, 'calendarShow', true);
  setTaskField(p, a.id, 'blockHours', 2);
  p.timeBlocks = [{ id: 'tb', name: 'Day', from: '09:00', to: '17:00', days: [0, 1, 2, 3, 4, 5, 6] }];
  p.agenda = { blockHours: 2, timeBlockId: 'tb', gapMinutes: 0, assumedLoad: 100, dailyCap: 8 };

  const back = planBlocks(p, computeSchedule(p)).blocks.filter((b) => b.dateIso === MON);
  assert.deepEqual(back.map((b) => formatTime(b.start)), ['09:00', '11:00', '13:00', '15:00'], 'back to back by default');

  p.agenda = { ...p.agenda, gapMinutes: 15 };
  const all = planBlocks(p, computeSchedule(p)).blocks;
  const spaced = all.filter((b) => b.dateIso === MON);
  assert.deepEqual(spaced.map((b) => formatTime(b.start)), ['09:00', '11:15', '13:30'],
    'a quarter of an hour after each block — which costs the day its fourth');
  assert.equal(spaced[0].minutes, 120, 'the blocks themselves are the same length');
  assert.equal(formatTime(spaced[2].end), '15:30');
  assert.equal(all.length, 4, 'the work does not vanish: the fourth block moves on');
  assert.equal(all[3].dateIso, '2026-09-22', '…to the next day');
});

test('duration is how long a task is open; work is how much of it is spent', async () => {
  const { planBlocks, formatTime } = await import('../src/model/agenda.js');
  const { resourceLoad } = await import('../src/model/schedule.js');
  const p = plan();
  const ann = addResource(p, { name: 'Ann', rate: 100 });
  const design = task(p, 'Design the layout', 5);     // open for a working week
  assign(p, design.id, ann.id, 1);

  // Left alone, the old rule applies: five days of one person is forty hours.
  assert.equal(computeSchedule(p).tasks[design.id].work, 40);

  // Said plainly: five days open, twelve hours of actual work.
  setTaskField(p, design.id, 'work', '12h');
  const s = computeSchedule(p);
  assert.equal(s.tasks[design.id].duration, 5, 'the bar on the chart is unchanged');
  assert.equal(s.tasks[design.id].work, 12);
  assert.equal(s.tasks[design.id].cost, 1200, 'and it costs twelve hours, not forty');
  assert.equal(Math.round(s.tasks[design.id].unitsByResource.get(ann.id) * 100) / 100, 0.3,
    'which is a third of Ann’s day, not all of it');

  // So she is not over-allocated, where the old rule would have said she was.
  const load = resourceLoad(p, s);
  for (const [, items] of load.get(ann.id)) {
    assert.ok(items.reduce((sum, x) => sum + x.units, 0) <= 1.0001);
    assert.equal(Math.round(items[0].hours * 100) / 100, 2.4, 'two and a half hours a day, near enough');
  }
  assert.ok(!validate(p, s).some((i) => i.code === 'overallocated'));

  // On the calendar that is blocks spread across the five days, not three full ones.
  setTaskField(p, design.id, 'calendarShow', true);
  setTaskField(p, design.id, 'blockHours', 1);
  const { blocks } = planBlocks(p, computeSchedule(p));
  assert.equal(blocks.length, 12, 'twelve hours in one-hour blocks');
  const perDay = new Map();
  for (const b of blocks) perDay.set(b.dateIso, (perDay.get(b.dateIso) || 0) + 1);
  // Each day's share is worked out against the days left, so twelve hours
  // over five open days is 3, 3, 2, 2, 2 — every day it is open, none full.
  assert.equal(perDay.size, 5, 'spread over all five days it is open');
  assert.ok([...perDay.values()].every((n) => n <= 3), 'never more than three hours a day');

  // Bigger blocks, same twelve hours: four-hour blocks land one a day.
  setTaskField(p, design.id, 'blockHours', 4);
  const big = planBlocks(p, computeSchedule(p)).blocks;
  assert.equal(big.length, 3);
  assert.equal(new Set(big.map((b) => b.dateIso)).size, 3, 'one four-hour block a day');
  assert.ok(big.every((b) => b.minutes === 240));
});

test('an empty untitled plan does not put a row on the shelf', async () => {
  const { SyncedDocument, MemoryStore } = await import('../sync-kit/js/index.js');
  const { createProject } = await import('../src/model/model.js');
  const { serialize } = await import('../src/io/json.js');
  // The rule sync.js applies before it writes: a plan earns its record by
  // having something in it. Opening the app should not fill anyone's shelf.
  const earnsRecord = (project, doc) => !(project.tasks.length === 0 && project.name === 'Untitled project' && !doc.record.updatedAt);

  const store = new MemoryStore();
  await store.open();
  const fresh = createProject();
  const doc = new SyncedDocument(store, { id: fresh.id, origin: 'test', format: fresh.format, name: fresh.name });
  await doc.load();
  assert.equal(earnsRecord(fresh, doc), false, 'a new window is not a plan yet');

  fresh.name = 'Zipline';
  assert.equal(earnsRecord(fresh, doc), true, 'naming it makes it one');

  const withTask = createProject();
  withTask.tasks.push({ id: 't', name: 'A', level: 1, duration: 1, predecessors: [], assignments: [] });
  assert.equal(earnsRecord(withTask, doc), true, 'so does putting a task in it');

  // Once it has a record, it keeps it even if emptied again.
  doc.edit(serialize(fresh), fresh.name);
  await doc.save();
  const emptied = createProject();
  assert.equal(earnsRecord(emptied, doc), true);
});

test('a task books everyone on it, so nobody is in two places at once', async () => {
  const { planBlocks } = await import('../src/model/agenda.js');
  const p = plan();
  const priya = addResource(p, { name: 'Priya' });
  const uma = addResource(p, { name: 'Uma' });
  // Uma is on both: the pair task, and one of her own.
  const interviews = task(p, 'Stakeholder interviews', 1);
  const review = task(p, 'Analytics review', 1);
  assign(p, interviews.id, priya.id, 1);
  assign(p, interviews.id, uma.id, 1);
  assign(p, review.id, uma.id, 1);
  for (const t of [interviews, review]) { setTaskField(p, t.id, 'calendarShow', true); setTaskField(p, t.id, 'blockHours', 2); }

  const { blocks } = planBlocks(p, computeSchedule(p));
  const umaBlocks = blocks.filter((b) => b.lanes.includes(uma.id)).sort((x, y) => x.day - y.day || x.start - y.start);
  assert.ok(umaBlocks.length >= 2);
  for (let i = 1; i < umaBlocks.length; i++) {
    const prev = umaBlocks[i - 1], now = umaBlocks[i];
    assert.ok(now.day > prev.day || now.start >= prev.end,
      `Uma is booked twice at once: ${prev.dateIso} ${prev.start} and ${now.start}`);
  }
  // Priya is only on the pair task, so her hours are exactly its blocks.
  const priyaBlocks = blocks.filter((b) => b.lanes.includes(priya.id));
  assert.ok(priyaBlocks.every((b) => b.taskId === interviews.id));

  // Someone not on either task is free at the same hour — two people can work at once.
  const dan = addResource(p, { name: 'Dan' });
  const solo = task(p, 'Visual design', 1);
  assign(p, solo.id, dan.id, 1);
  setTaskField(p, solo.id, 'calendarShow', true);
  setTaskField(p, solo.id, 'blockHours', 2);
  const after = planBlocks(p, computeSchedule(p)).blocks;
  const danFirst = after.filter((b) => b.lanes.includes(dan.id)).sort((x, y) => x.day - y.day || x.start - y.start)[0];
  const umaFirst = after.filter((b) => b.lanes.includes(uma.id)).sort((x, y) => x.day - y.day || x.start - y.start)[0];
  assert.equal(danFirst.day, umaFirst.day);
  assert.equal(danFirst.start, umaFirst.start, 'different people, same hour, which is not a clash');
});

test('one calendar covers every plan, and a person is the same person in each', async () => {
  const { planBlocksAcross, personKey } = await import('../src/model/agenda.js');
  const build = (name) => {
    const p = plan();
    p.name = name;
    const uma = addResource(p, { name: 'Uma Chen' });   // a different id in each plan
    const t = task(p, `${name} work`, 1);
    assign(p, t.id, uma.id, 1);
    setTaskField(p, t.id, 'calendarShow', true);
    setTaskField(p, t.id, 'blockHours', 4);
    return { p, uma, t };
  };
  const a = build('Alpha');
  const b = build('Beta');
  assert.notEqual(a.uma.id, b.uma.id, 'the same person, two ids');
  assert.equal(personKey(a.uma.name), personKey(b.uma.name), 'and one name');

  const entries = [{ project: a.p, schedule: computeSchedule(a.p) }, { project: b.p, schedule: computeSchedule(b.p) }];
  const { blocks } = planBlocksAcross(entries);
  assert.equal(new Set(blocks.map((x) => x.planId)).size, 2, 'both plans are on the calendar');
  assert.ok(blocks.every((x) => x.planName && x.people.includes(personKey('Uma Chen'))));

  // Her hours are hers: the two plans cannot both take the same morning.
  const hers = blocks.sort((x, y) => x.day - y.day || x.start - y.start);
  for (let i = 1; i < hers.length; i++) {
    const prev = hers[i - 1], now = hers[i];
    assert.ok(now.day > prev.day || now.start >= prev.end,
      `two projects booked Uma at once: ${prev.planName} and ${now.planName} on ${now.dateIso}`);
  }
  // Left to itself, each plan would have claimed the very same hour.
  const alone = planBlocksAcross([entries[0]]).blocks[0];
  const together = hers[0];
  assert.equal(alone.start, together.start, 'the first plan keeps the hour it would have had');
  assert.ok(hers.some((x) => x.planId === b.p.id && (x.day > together.day || x.start >= together.end)),
    'and the second is placed after it, not on top of it');
});

test('a person is shared between plans, not copied into each', async () => {
  const { identityOf, addResource } = await import('../src/model/model.js');
  const { personKeyOf, planBlocksAcross } = await import('../src/model/agenda.js');

  // The same human being, added to two plans from one directory entry.
  const person = { id: 'person_abc', name: 'Uma Chen' };
  const build = (name) => {
    const p = plan();
    p.name = name;
    const r = addResource(p, { personId: person.id, name: person.name, initials: 'UX' });
    const t = task(p, `${name} work`, 1);
    assign(p, t.id, r.id, 1);
    setTaskField(p, t.id, 'calendarShow', true);
    setTaskField(p, t.id, 'blockHours', 4);
    return { p, r, t };
  };
  const a = build('Alpha'), b = build('Beta');
  assert.notEqual(a.r.id, b.r.id, 'each plan still has its own row');
  assert.equal(identityOf(a.r), identityOf(b.r), 'but they are one person');
  assert.equal(identityOf(a.r), 'person:person_abc');
  assert.equal(personKeyOf(a.r), personKeyOf(b.r));

  // Which is what stops two plans booking her at once.
  const entries = [{ project: a.p, schedule: computeSchedule(a.p) }, { project: b.p, schedule: computeSchedule(b.p) }];
  const blocks = planBlocksAcross(entries).blocks.sort((x, y) => x.day - y.day || x.start - y.start);
  for (let i = 1; i < blocks.length; i++) {
    const prev = blocks[i - 1], now = blocks[i];
    assert.ok(now.day > prev.day || now.start >= prev.end, 'one person, one set of hours');
  }

  // Someone with no directory entry still has an identity: their name.
  const c = plan();
  const loose = addResource(c, { name: 'Uma Chen' });
  assert.equal(identityOf(loose), 'who:uma chen');

  // And the same person is never added to one plan twice.
  const again = addResource(a.p, { personId: person.id, name: 'Uma Chen' });
  assert.equal(again.id, a.r.id);
  assert.equal(a.p.resources.length, 1);
});

test('urgency decides who gets the earliest hours', async () => {
  const { planBlocks, priorities, formatTime } = await import('../src/model/agenda.js');
  const { URGENCIES } = await import('../src/model/model.js');
  const p = plan();
  const ann = addResource(p, { name: 'Ann' });
  // Two tasks, same person, same day: only one can have the morning.
  const dull = task(p, 'Tidy the backlog', 1);
  const vital = task(p, 'Fix the demo', 1);
  for (const t of [dull, vital]) {
    assign(p, t.id, ann.id, 1);
    setTaskField(p, t.id, 'calendarShow', true);
    setTaskField(p, t.id, 'blockHours', 4);
  }

  // Ann has eight hours a day and each task wants eight, so one of them waits
  // a day. Equal urgency: the one listed first goes first.
  const firstOf = (bs) => [...bs].sort((x, y) => x.day - y.day || x.start - y.start)[0];
  let blocks = planBlocks(p, computeSchedule(p)).blocks;
  assert.equal(formatTime(firstOf(blocks).start), '08:00', 'the working day starts when the time block does');
  assert.equal(firstOf(blocks).taskId, dull.id);

  // Marked high, the other one takes the first day instead.
  setTaskField(p, vital.id, 'urgency', 'high');
  blocks = planBlocks(p, computeSchedule(p)).blocks;
  assert.equal(firstOf(blocks).taskId, vital.id, 'the urgent task goes first, the dull one waits');
  const dullDay = firstOf(blocks.filter((b) => b.taskId === dull.id));
  const vitalDay = firstOf(blocks.filter((b) => b.taskId === vital.id));
  assert.ok(dullDay.day > vitalDay.day || dullDay.start >= vitalDay.end);

  // Low goes behind everything.
  setTaskField(p, vital.id, 'urgency', 'low');
  setTaskField(p, dull.id, 'urgency', 'high');
  blocks = planBlocks(p, computeSchedule(p)).blocks;
  assert.equal(firstOf(blocks).taskId, dull.id);

  // And it moves the task up the priority list, with the reason shown.
  setTaskField(p, vital.id, 'urgency', 'now');
  const list = priorities(p, computeSchedule(p));
  assert.equal(list[0].taskId, vital.id, '“do it now” is first');
  assert.equal(list[0].urgency, 'now');
  assert.ok(list[0].reasons.includes('do it now'));
  assert.ok(list[0].score > list[1].score + 100, 'and by a wide margin');

  // "Do it now" also puts the task on the calendar, since that is the point.
  const fresh = task(p, 'Something else', 1);
  assert.equal(fresh.calendar.show, false);
  setTaskField(p, fresh.id, 'urgency', 'now');
  assert.equal(fresh.calendar.show, true);
  assert.throws(() => setTaskField(p, fresh.id, 'urgency', 'whenever'), /Urgency is one of/);
  assert.deepEqual(Object.keys(URGENCIES), ['now', 'high', 'normal', 'low']);
});

test('a duration is not an estimate of work: an unstated task takes half a day, not all of it', async () => {
  const { planBlocks, hoursLeft } = await import('../src/model/agenda.js');
  const p = plan();
  const r = addResource(p, { name: 'Ann' });
  // Five days of design, with nothing said about how many hours it takes. The
  // scheduler implies forty hours for costing; the calendar must not book
  // every one of them, or the week has room for nothing else.
  const design = task(p, 'Design', 5);
  assign(p, design.id, r.id, 1);
  setTaskField(p, design.id, 'calendarShow', true);
  setTaskField(p, design.id, 'blockHours', 2);

  const s = computeSchedule(p);
  assert.equal(s.tasks[design.id].work, 40, 'the plan still costs it at full time');
  assert.equal(hoursLeft(p, s.tasks[design.id], design), 20, 'the calendar assumes half of it by default');
  const { blocks } = planBlocks(p, s);
  assert.equal(blocks.reduce((n, b) => n + b.minutes, 0) / 60, 20);

  // Stated work is used exactly as stated, whatever the assumption is.
  setTaskField(p, design.id, 'work', 12);
  const s2 = computeSchedule(p);
  assert.equal(hoursLeft(p, s2.tasks[design.id], design), 12, 'a task that says how long it takes is believed');

  // …and the assumption is the plan's to set.
  setTaskField(p, design.id, 'work', '');
  p.agenda = { ...p.agenda, assumedLoad: 100 };
  assert.equal(hoursLeft(p, computeSchedule(p).tasks[design.id], design), 40);
});

test('no day is filled wall to wall: the calendar keeps to the day’s limit', async () => {
  const { planBlocks } = await import('../src/model/agenda.js');
  const p = plan();
  const r = addResource(p, { name: 'Ann' });
  p.timeBlocks = [{ id: 'tb', name: 'Day', from: '09:00', to: '21:00', days: [0, 1, 2, 3, 4, 5, 6] }];
  p.calendar.workDays = [0, 1, 2, 3, 4, 5, 6];
  p.agenda = { blockHours: 2, timeBlockId: 'tb', gapMinutes: 0, assumedLoad: 100, dailyCap: 4 };
  const long = task(p, 'Marathon', 3);
  assign(p, long.id, r.id, 1);
  setTaskField(p, long.id, 'calendarShow', true);
  setTaskField(p, long.id, 'blockHours', 2);

  const { blocks } = planBlocks(p, computeSchedule(p));
  const perDay = new Map();
  for (const b of blocks) perDay.set(b.dateIso, (perDay.get(b.dateIso) || 0) + b.minutes);
  assert.ok([...perDay.values()].every((m) => m <= 240), 'four hours a day, though the window holds twelve');
  assert.equal(blocks.reduce((n, b) => n + b.minutes, 0) / 60, 24, 'the work does not vanish, it runs on');
  assert.ok(perDay.size >= 6, 'twenty-four hours at four a day is six days');
});

test('the day’s limit is shared: two people on one task each spend the same day', async () => {
  const { planBlocks } = await import('../src/model/agenda.js');
  const p = plan();
  const ann = addResource(p, { name: 'Ann' });
  const bo = addResource(p, { name: 'Bo' });
  p.timeBlocks = [{ id: 'tb', name: 'Day', from: '09:00', to: '17:00', days: [0, 1, 2, 3, 4, 5, 6] }];
  p.agenda = { blockHours: 2, timeBlockId: 'tb', gapMinutes: 0, assumedLoad: 100, dailyCap: 4 };
  const together = task(p, 'Workshop', 1);
  assign(p, together.id, ann.id, 1);
  assign(p, together.id, bo.id, 1);
  setTaskField(p, together.id, 'calendarShow', true);
  setTaskField(p, together.id, 'blockHours', 2);
  const alone = task(p, 'Ann alone', 1);
  assign(p, alone.id, ann.id, 1);
  setTaskField(p, alone.id, 'calendarShow', true);
  setTaskField(p, alone.id, 'blockHours', 2);

  const { blocks } = planBlocks(p, computeSchedule(p));
  const annMinutes = new Map();
  for (const b of blocks) {
    if (!b.people.some((k) => k.includes('ann'))) continue;
    annMinutes.set(b.dateIso, (annMinutes.get(b.dateIso) || 0) + b.minutes);
  }
  assert.ok([...annMinutes.values()].every((m) => m <= 240), 'a shared block counts against both their days');
});

test('one plan, once: the same plan given twice does not book its hours twice', async () => {
  const { planBlocksAcross } = await import('../src/model/agenda.js');
  const p = plan();
  const r = addResource(p, { name: 'Ann' });
  const t1 = task(p, 'Download the USB item', 1);
  assign(p, t1.id, r.id, 1);
  setTaskField(p, t1.id, 'work', 1);
  setTaskField(p, t1.id, 'calendarShow', true);
  setTaskField(p, t1.id, 'blockHours', 1);

  const s = computeSchedule(p);
  const once = planBlocksAcross([{ project: p, schedule: s }]);
  assert.equal(once.blocks.length, 1, 'an hour of work is one hour-long block');

  // The open plan comes from the store and its own record is on the shelf. If
  // both reach the calendar, the task looks like it takes twice as long.
  const twice = planBlocksAcross([{ project: p, schedule: s }, { project: p, schedule: s }]);
  assert.equal(twice.blocks.length, 1, 'the same plan twice is still one plan');
  assert.deepEqual(twice.blocks.map((b) => [b.dateIso, b.start, b.minutes]), once.blocks.map((b) => [b.dateIso, b.start, b.minutes]));

  // A copy of the plan under its own id is a different plan, and does count.
  const copy = { ...p, id: 'plan_copy', name: 'Copy' };
  const both = planBlocksAcross([{ project: p, schedule: s }, { project: copy, schedule: computeSchedule(copy) }]);
  assert.equal(both.blocks.length, 2, 'two real plans are two bookings');
});

test('half an hour of work takes half an hour, not the whole block it sits in', async () => {
  const { planBlocksAcross, formatClock } = await import('../src/model/agenda.js');
  const p = plan();
  const r = addResource(p, { name: 'Ann' });
  p.timeBlocks = [{ id: 'tb', name: 'Day', from: '08:00', to: '17:00', days: [0, 1, 2, 3, 4, 5, 6] }];
  // Hour-long blocks by default, and no gap asked for.
  p.agenda = { blockHours: 1, timeBlockId: 'tb', gapMinutes: 0, assumedLoad: 100, dailyCap: 8 };

  // Four errands of half an hour each.
  for (const name of ['Light bracket', 'Gas bracket', 'Aluminium panel', 'Camera']) {
    const t = task(p, name, 1);
    assign(p, t.id, r.id, 1);
    setTaskField(p, t.id, 'work', 0.5);
    setTaskField(p, t.id, 'calendarShow', true);
  }

  const { blocks } = planBlocksAcross([{ project: p, schedule: computeSchedule(p) }]);
  const first = blocks.filter((b) => b.dateIso === MON).sort((a, b) => a.start - b.start);
  assert.equal(first.length, 4);
  assert.ok(first.every((b) => b.minutes === 30), 'each is half an hour of work');
  assert.deepEqual(first.map((b) => formatClock(b.start)), ['8 AM', '8:30 AM', '9 AM', '9:30 AM'],
    'one after another — a half-hour task does not hold the rest of the hour');

  // The gap, when asked for, is still honoured and is the only space left.
  p.agenda = { ...p.agenda, gapMinutes: 15 };
  const spaced = planBlocksAcross([{ project: p, schedule: computeSchedule(p) }]).blocks
    .filter((b) => b.dateIso === MON).sort((a, b) => a.start - b.start);
  assert.deepEqual(spaced.map((b) => formatClock(b.start)), ['8 AM', '8:45 AM', '9:30 AM', '10:15 AM']);
});

test('a task can be in several time blocks and uses whichever has room', async () => {
  const { planBlocks, formatTime, agendaOf } = await import('../src/model/agenda.js');
  const { addTimeBlock } = await import('../src/model/model.js');
  const p = plan();                                  // starts Monday 21 Sep 2026
  p.calendar.workDays = [0, 1, 2, 3, 4, 5, 6];
  const r = addResource(p, { name: 'Ann' });
  const evening = addTimeBlock(p, { name: 'Late day study', from: '18:00', to: '21:00', days: [1, 2, 3, 4, 5] });
  const weekend = addTimeBlock(p, { name: 'Weekend', from: '09:00', to: '18:00', days: [0, 6] });

  const essay = task(p, 'Essay', 3);
  assign(p, essay.id, r.id, 1);
  // Twenty hours: more than the five weekday evenings hold, so the weekend
  // has to take the rest. That is the point of being in two blocks.
  setTaskField(p, essay.id, 'work', 20);
  setTaskField(p, essay.id, 'calendarShow', true);
  setTaskField(p, essay.id, 'blockHours', 1.5);
  setTaskField(p, essay.id, 'timeBlock', [evening.id, weekend.id]);

  const a = agendaOf(p, essay);
  assert.equal(a.windows.length, 2, 'two windows, in order of the clock');
  assert.deepEqual(a.windows.map((w) => formatTime(w.from)), ['09:00', '18:00']);

  const { blocks } = planBlocks(p, computeSchedule(p));
  assert.equal(blocks.reduce((n, b) => n + b.minutes, 0) / 60, 20, 'all twenty hours are placed');
  const weekendBlocks = blocks.filter((b) => [0, 6].includes(((b.day + 4) % 7 + 7) % 7));
  const eveningBlocks = blocks.filter((b) => !weekendBlocks.includes(b));
  assert.ok(weekendBlocks.length > 0, 'the weekend block is used');
  assert.ok(eveningBlocks.length > 0, 'and so are the weekday evenings');
  assert.ok(eveningBlocks.every((b) => b.start >= 18 * 60 && b.end <= 21 * 60), 'weekday work stays in the evening window');
  assert.ok(weekendBlocks.every((b) => b.start >= 9 * 60 && b.end <= 18 * 60), 'weekend work stays in its own');

  // One block on its own still behaves exactly as it did.
  setTaskField(p, essay.id, 'timeBlock', evening.id);
  const only = planBlocks(p, computeSchedule(p)).blocks;
  assert.ok(only.every((b) => b.start >= 18 * 60 && b.end <= 21 * 60));
  assert.ok(only.every((b) => ![0, 6].includes(((b.day + 4) % 7 + 7) % 7)), 'and on weekdays only');
});

test('overdue work is placed from today on, never on days that have gone', async () => {
  const { planBlocks } = await import('../src/model/agenda.js');
  const p = plan('2026-05-11');                 // a plan that started in May
  const r = addResource(p, { name: 'Ann' });
  const late = task(p, 'Order the brackets', 1);
  assign(p, late.id, r.id, 1);
  setTaskField(p, late.id, 'work', 2);
  setTaskField(p, late.id, 'calendarShow', true);

  // Looked at as of 25 September, the May task is overdue and not done.
  p.statusDate = '2026-09-25';
  const { blocks } = planBlocks(p, computeSchedule(p));
  assert.ok(blocks.length > 0, 'it is still on the calendar');
  assert.ok(blocks.every((b) => b.dateIso >= '2026-09-25'), 'and nowhere before the day it is looked at from');
  assert.ok(blocks.every((b) => b.overdue), 'each block says it is overdue');

  // A task that starts in the future is not pulled forward.
  p.statusDate = '2026-05-01';
  const early = planBlocks(p, computeSchedule(p)).blocks;
  assert.ok(early.every((b) => b.dateIso >= '2026-05-11' && !b.overdue), 'future work keeps its own start');
});
