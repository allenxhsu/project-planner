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
  assert.equal(reading.calendar.timeBlockId, null);
  assert.ok(!timeBlocks(p).some((b) => b.id === focus.id));
});

test('only the phase the plan is in reaches the calendar', async () => {
  const { planBlocks } = await import('../src/model/agenda.js');
  const { phases, phaseOf, inCurrentPhase } = await import('../src/model/model.js');
  const p = plan();
  const design = task(p, 'Design', 0);
  const wire = task(p, 'Wireframes', 2, 2);
  const build = task(p, 'Build', 0);
  const cms = task(p, 'CMS integration', 2, 2);
  for (const t of [wire, cms]) setTaskField(p, t.id, 'calendarShow', true);

  assert.deepEqual(phases(p).map((x) => x.name), ['Design', 'Build']);
  assert.equal(phaseOf(p, wire.id), design.id);
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
});
