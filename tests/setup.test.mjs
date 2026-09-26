import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, newTask, addPhase, addField, setFieldValue, fieldValue, addResource, phaseOf } from '../src/model/model.js';
import { freshCopy, setUpProject, projectFromScratch, businessDays, afterBusinessDays, phaseFinishes } from '../src/model/setup.js';
import { serialize, parse } from '../src/io/json.js';

// A two-phase template: Design (a heading with two tasks under it), Build.
function template() {
  const p = createProject('Launch', '2026-09-28');                       // a Monday
  const design = addPhase(p, { name: 'Design' });
  const build = addPhase(p, { name: 'Build' });
  const head = newTask({ name: 'Design', level: 1, phaseId: design.id });
  const a = newTask({ name: 'Sketch', level: 2, duration: 2, percent: 60, deadline: '2025-01-10' });
  const b = newTask({ name: 'Review', level: 2, duration: 1, predecessors: [{ id: a.id, type: 'FS', lag: 0 }] });
  const c = newTask({ name: 'Code', level: 1, duration: 5, phaseId: build.id, predecessors: [{ id: b.id, type: 'FS', lag: 0 }],
    constraint: { type: 'SNET', date: '2025-01-01' } });
  p.tasks.push(head, a, b, c);
  p.template = true;
  return { p, design, build, a, b, c };
}

test('a fresh copy keeps the shape and drops the history', () => {
  const { p, a, c } = template();
  freshCopy(p, '2026-10-05');
  assert.equal(p.start, '2026-10-05');
  assert.equal(p.tasks.find((t) => t.id === a.id).percent, 0);
  assert.equal(p.tasks.find((t) => t.id === a.id).deadline, null);
  assert.deepEqual(p.tasks.find((t) => t.id === c.id).constraint, { type: 'ASAP', date: null });
  assert.equal(p.tasks.length, 4);
  assert.equal(p.phases.length, 2);
});

test('business days count working days only', () => {
  const p = createProject('x', '2026-09-28');
  assert.equal(businessDays(p, '2026-09-28', '2026-10-05'), 5);        // Mon → next Mon
  assert.equal(afterBusinessDays(p, '2026-09-25', 1), '2026-09-28');   // Fri + 1 → Mon
  assert.equal(afterBusinessDays(p, '2026-09-26', 0), '2026-09-28');   // a Saturday start begins Monday
});

test('phase finishes come from the schedule', () => {
  const { p, design, build } = template();
  const ends = phaseFinishes(p);
  // Sketch Mon–Tue, Review Wed, Code Thu → next Wed.
  assert.equal(ends.get(design.id), '2026-09-30');
  assert.equal(ends.get(build.id), '2026-10-07');
});

test('setting up: phases dated, people assigned, deadlines filled, template off', () => {
  const { p, design, build, a, b, c } = template();
  freshCopy(p, '2026-09-28');
  setUpProject(p, {
    name: 'Launch for Acme', workspaceId: 'ws_work', start: '2026-09-28', onCalendar: true,
    phases: [
      { id: design.id, name: 'Design', deadline: '2026-10-02', people: [{ personId: 'person_ana', name: 'Ana' }] },
      { id: build.id, name: 'Build it', deadline: '2026-10-16', people: [{ name: 'Ben' }, { name: 'Cy' }] },
      { name: 'Launch', deadline: '2026-10-23' },
    ],
  });
  assert.equal(p.name, 'Launch for Acme');
  assert.equal(p.template, false);
  assert.equal(p.workspaceId, 'ws_work');
  assert.deepEqual(p.phases.map((ph) => ph.name), ['Design', 'Build it', 'Launch']);
  const task = (id) => p.tasks.find((t) => t.id === id);
  // Inherited from the heading: both design tasks get the design deadline and Ana.
  assert.equal(task(a.id).deadline, '2026-10-02');
  assert.equal(task(b.id).deadline, '2026-10-02');
  const ana = p.resources.find((r) => r.name === 'Ana');
  assert.equal(ana.personId, 'person_ana');
  assert.deepEqual(task(a.id).assignments, [{ resourceId: ana.id, units: 1 }]);
  assert.equal(task(c.id).deadline, '2026-10-16');
  assert.equal(task(c.id).assignments.length, 2);
  // The heading itself is not work: no deadline, nobody, not on the calendar.
  assert.equal(p.tasks[0].deadline, null);
  assert.equal(p.tasks[0].calendar.show, false);
  assert.equal(task(c.id).calendar.show, true);
});

test('setting up keeps what a task already says, and removes phases taken out', () => {
  const { p, design, build, c } = template();
  const ben = addResource(p, { name: 'Ben' });
  p.tasks.find((t) => t.id === c.id).assignments = [{ resourceId: ben.id, units: 1 }];
  p.tasks.find((t) => t.id === c.id).deadline = '2026-10-09';
  setUpProject(p, { name: 'X', start: '2026-09-28', phases: [{ id: build.id, name: 'Build', deadline: '2026-10-30', people: [{ name: 'Ben' }, { name: 'Dee' }] }] });
  const code = p.tasks.find((t) => t.id === c.id);
  assert.equal(code.deadline, '2026-10-09');
  assert.deepEqual(code.assignments, [{ resourceId: ben.id, units: 1 }]);
  assert.equal(p.phases.length, 1);
  assert.equal(phaseOf(p, p.tasks[1].id), null);                        // design is gone
  assert.equal(p.resources.filter((r) => r.name === 'Ben').length, 1); // not added twice
  assert.ok(!p.phases.some((ph) => ph.id === design.id));
});

test('from scratch: an empty plan with its phases and fields', () => {
  const p = projectFromScratch({ name: 'Garden', start: '2026-10-01', phases: [{ name: 'Dig' }, { name: '  ' }, { name: 'Plant', deadline: 'not a date' }],
    fields: [{ name: 'Budget', type: 'number' }, { name: 'Bed', type: 'select', options: ['North', 'South', 'North', ''] }, { name: '' }] });
  assert.equal(p.name, 'Garden');
  assert.equal(p.start, '2026-10-01');
  assert.deepEqual(p.phases.map((ph) => [ph.name, ph.deadline]), [['Dig', null], ['Plant', null]]);
  assert.deepEqual(p.fields.map((f) => [f.name, f.type, f.options]), [['Budget', 'number', []], ['Bed', 'select', ['North', 'South']]]);
});

test('custom field values fit their field and survive a save', () => {
  const p = createProject('F', '2026-09-28');
  const t = newTask({ name: 'One' });
  p.tasks.push(t);
  const ana = addResource(p, { name: 'Ana' });
  const budget = addField(p, { name: 'Budget', type: 'number' });
  const bed = addField(p, { name: 'Bed', type: 'multi', options: ['North', 'South'] });
  const owner = addField(p, { name: 'Owner', type: 'person' });
  const link = addField(p, { name: 'Brief', type: 'url' });
  assert.equal(fieldValue(p, budget, 'lots'), null);
  assert.equal(fieldValue(p, owner, 'r_nobody'), null);
  setFieldValue(p, t.id, budget.id, '1200');
  setFieldValue(p, t.id, bed.id, ['South', 'West', 'South']);
  setFieldValue(p, t.id, owner.id, ana.id);
  setFieldValue(p, t.id, link.id, 'example.com/brief');
  assert.deepEqual(t.fields, { [budget.id]: 1200, [bed.id]: ['South'], [owner.id]: ana.id, [link.id]: 'https://example.com/brief' });

  const back = parse(serialize(p)).project;
  assert.deepEqual(back.fields, p.fields);
  assert.deepEqual(back.tasks[0].fields, t.fields);

  // A field that is gone takes its values with it, on reading too.
  const raw = JSON.parse(serialize(p));
  raw.fields = raw.fields.filter((f) => f.id !== owner.id);
  assert.equal(owner.id in parse(JSON.stringify(raw)).project.tasks[0].fields, false);

  setFieldValue(p, t.id, budget.id, '');
  assert.equal(budget.id in t.fields, false);
});

test('phase deadlines are kept in the file', () => {
  const p = createProject('P', '2026-09-28');
  addPhase(p, { name: 'Design', deadline: '2026-10-02' });
  addPhase(p, { name: 'Build', deadline: 'soon' });
  assert.deepEqual(parse(serialize(p)).project.phases.map((ph) => ph.deadline), ['2026-10-02', null]);
});

test('finishing a task records the day, and undoing it forgets it', async () => {
  const { setTaskField } = await import('../src/model/model.js');
  const p = createProject('D', '2026-09-28');
  const t = newTask({ name: 'One' });
  p.tasks.push(t);
  setTaskField(p, t.id, 'percent', 100);
  assert.match(t.doneAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  const day = t.doneAt;
  setTaskField(p, t.id, 'percent', 100);
  assert.equal(t.doneAt, day);
  assert.equal(parse(serialize(p)).project.tasks[0].doneAt, day);
  setTaskField(p, t.id, 'percent', 50);
  assert.equal('doneAt' in t, false);
});

test('a task keeps a log of what happened to it, with comments, through a save', async () => {
  const { setTaskField, insertTask, addComment, setPin, removePin } = await import('../src/model/model.js');
  const p = createProject('Log', '2026-09-28');
  const t = insertTask(p, 0, { name: 'Draft' });
  setTaskField(p, t.id, 'name', 'Draft the brief');
  setTaskField(p, t.id, 'deadline', '2026-10-02');
  setTaskField(p, t.id, 'deadline', '2026-10-02');            // no change, no line
  setTaskField(p, t.id, 'notes', 'Longer now');
  setPin(p, t.id, { day: '2026-09-29', start: 600, minutes: 60 });
  removePin(p, t.id, 0);
  addComment(p, t.id, 'Ask Ana for the numbers');
  const log = t.activity.map((x) => [x.kind, x.field || '', x.from || '', x.to || x.text || '']);
  assert.deepEqual(log, [
    ['created', '', '', ''],
    ['change', 'name', 'Draft', 'Draft the brief'],
    ['change', 'deadline', 'none', '2026-10-02'],
    ['change', 'description', '', ''],
    ['fixed', '', '', '2026-09-29 10:00 AM, 1h'],
    ['unfixed', '', '', ''],
    ['comment', '', '', 'Ask Ana for the numbers'],
  ]);
  assert.deepEqual(parse(serialize(p)).project.tasks[0].activity, t.activity);
  // A copy starts its own history.
  const copy = insertTask(p, 1, { ...structuredClone(t), id: undefined });
  assert.deepEqual(copy.activity.map((x) => x.kind), ['created']);
});

test('Motion statuses replace the old default columns, and priority and inactive tasks cross to Microsoft Project', async () => {
  const { exportMspdi: writeMspdi, importMspdi: readMspdi } = await import('../src/io/mspdi.js');
  const { computeSchedule } = await import('../src/model/schedule.js');
  // An older plan, saved with the three columns every plan used to start with.
  const old = createProject('Old', '2026-09-28');
  old.stages = [{ id: 'stage_todo', name: 'To do', done: false }, { id: 'stage_doing', name: 'In progress', done: false }, { id: 'stage_done', name: 'Done', done: true }];
  const back = parse(serialize(old)).project;
  assert.deepEqual(back.stages.map((s) => s.name), ['Backlog', 'Todo', 'In Progress', 'Blocked', 'Completed', 'Cancelled']);
  // A plan that chose its own columns keeps them.
  old.stages = [{ id: 'a', name: 'Ideas', done: false }, { id: 'b', name: 'Shipped', done: true }];
  assert.deepEqual(parse(serialize(old)).project.stages.map((s) => s.name), ['Ideas', 'Shipped']);

  const p = createProject('MSP', '2026-09-28');
  const a = newTask({ name: 'Urgent', urgency: 'now', work: 3 });
  const b = newTask({ name: 'Dropped', urgency: 'low', archived: true });
  p.tasks.push(a, b);
  const xml = writeMspdi(p, computeSchedule(p));
  const round = readMspdi(xml).project;
  assert.deepEqual(round.tasks.map((t) => [t.name, t.urgency, !!t.archived]), [['Urgent', 'now', false], ['Dropped', 'low', true]]);
  assert.equal(round.tasks[0].work, 3);
});

test('a Motion export becomes plans: workspaces, projects, tasks, worked time', async () => {
  const { motionToPlans, htmlToText } = await import('../src/io/motion.js');
  const ws = { id: 'w1', name: 'School' };
  const projects = [
    { id: 'p1', name: 'Course', status: { name: 'Todo' }, workspace: ws, createdTime: '2026-09-01T10:00:00Z' },
    { id: 'p2', name: 'Old course', status: { name: 'Completed' }, workspace: ws, createdTime: '2025-01-01T10:00:00Z', updatedTime: '2025-06-01T10:00:00Z' },
  ];
  const tasks = [
    { id: 't1', name: 'Essay', project: { id: 'p1' }, workspace: ws, duration: 120, minimumDuration: 60, priorityLevel: 'HIGH', deadlineType: 'HARD',
      startDate: '2026-09-28T00:00:00.000Z', dueDate: '2026-10-03T06:59:59.999Z', isAutoScheduled: true, description: '<p>Draft</p><ul><li>outline</li></ul>',
      labels: [{ label: { name: 'Writing' } }], assignee: { name: 'Allen X', email: 'a@example.com' }, chunks: [], comments: [], createdTime: '2026-09-20T10:00:00Z' },
    { id: 't2', name: 'Quiz', project: { id: 'p1' }, workspace: ws, duration: 30, minimumDuration: null, priorityLevel: 'ASAP', deadlineType: 'SOFT',
      startDate: '2026-09-20T00:00:00.000Z', dueDate: null, completedTime: '2026-09-21T17:00:00Z', archivedTime: '2026-09-25T00:00:00Z', isAutoScheduled: false,
      chunks: [{ completedTime: '2026-09-21T17:00:00Z', scheduledStart: '2026-09-21T16:30:00Z', duration: 30 }], labels: [], comments: [], createdTime: '2026-09-19T10:00:00Z' },
    { id: 't3', name: 'Loose', workspace: ws, duration: 60, priorityLevel: 'MEDIUM', chunks: [], labels: [], comments: [], createdTime: '2026-09-19T10:00:00Z' },
  ];
  const { plans, workspaces, counts } = motionToPlans({ projects, tasks });
  assert.deepEqual(workspaces, ['School']);
  assert.deepEqual(plans.map((p) => [p.name, p.archived, p.workspaceName]), [['Course', false, 'School'], ['Old course', true, 'School'], ['School — tasks without a project', false, 'School']]);
  assert.deepEqual(counts, { projects: 2, tasks: 3, open: 2, completed: 1, archived: 1, worked: 1 });
  const course = plans[0];
  const essay = course.tasks.find((t) => t.name === 'Essay');
  assert.deepEqual([essay.work, essay.urgency, essay.hardDeadline, essay.labels, essay.calendar.show, essay.calendar.blockHours, essay.constraint], [2, 'high', true, ['Writing'], true, 1, { type: 'SNET', date: '2026-09-28' }]);
  assert.equal(essay.notes, 'Draft\n\n- outline');
  const quiz = course.tasks.find((t) => t.name === 'Quiz');
  assert.deepEqual([quiz.percent, quiz.archived, quiz.urgency, quiz.calendar.whole, quiz.deadline], [100, true, 'now', true, null]);
  assert.equal(course.timesheets.length, 1);
  assert.equal(course.timesheets[0].hours, 0.5);
  assert.equal(course.resources[0].name, 'Allen X');
  // Survives a save.
  const back = parse(serialize(course)).project;
  assert.equal(back.timesheets[0].start, course.timesheets[0].start);
  assert.equal(back.tasks.find((t) => t.name === 'Essay').hardDeadline, true);
  assert.equal(htmlToText('<p>a &amp; b</p><p>c</p>'), 'a & b\nc');
});

test('stages run one after another, advance by themselves, and can be extended, fixed, completed or cancelled', async () => {
  const { addPhase, insertTask, setTaskField } = await import('../src/model/model.js');
  const S = await import('../src/model/stages.js');
  const { computeSchedule } = await import('../src/model/schedule.js');
  const p = createProject('Study', '2026-09-28');           // a Monday
  const a = addPhase(p, { name: 'Module 1', deadline: '2026-10-02' });
  const b = addPhase(p, { name: 'Module 2', deadline: '2026-10-09' });
  const c = addPhase(p, { name: 'Module 3', deadline: '2026-10-16' });
  const t1 = insertTask(p, 0, { name: 'Read 1', phaseId: a.id });
  const t2 = insertTask(p, 1, { name: 'Read 2', phaseId: b.id });
  const t3 = insertTask(p, 2, { name: 'Read 3', phaseId: c.id });
  p.currentPhaseId = a.id;
  assert.deepEqual(S.stageRange(p, b.id), { start: '2026-10-03', end: '2026-10-09' });
  assert.deepEqual(S.stageRange(p, a.id), { start: '2026-09-28', end: '2026-10-02' });

  // Finishing the stage's only task moves the project on.
  setTaskField(p, t1.id, 'percent', 100);
  assert.equal(S.autoAdvance(p), true);
  assert.equal(p.currentPhaseId, b.id);
  assert.equal(S.stageStatus(a), 'done');
  assert.equal(p.activity.at(-1).kind, 'stage');

  // Late: work laid past the deadline.
  const sched = computeSchedule(p);
  const { toDay } = await import('../src/model/calendar.js');
  const byTask = new Map([[t2.id, [{ day: toDay('2026-10-14') }]]]);   // after its 9 Oct deadline
  const h = S.stageHealth(p, sched, b.id, { byTask, today: toDay('2026-10-01') });
  assert.equal(h.missed, true);
  assert.deepEqual(h.late.map((l) => l.name), ['Read 2']);

  // Extending moves the stages after it by as many working days.
  S.extendStage(p, b.id, '2026-10-16');
  assert.equal(b.deadline, '2026-10-16');
  assert.equal(c.deadline, '2026-10-23');

  // Fixing brings a task inside: its deadline the stage's, hard, high.
  S.fixTaskToStage(p, t2.id, b.id);
  assert.deepEqual([t2.deadline, t2.hardDeadline, t2.urgency], ['2026-10-16', true, 'high']);

  // Cancel archives what is left; complete finishes it and moves on.
  S.cancelStage(p, b.id);
  assert.equal(t2.archived, true);
  assert.equal(p.currentPhaseId, c.id);
  S.reopenStage(p, b.id);
  assert.equal(t2.archived, false);
  S.completeStage(p, c.id);
  assert.equal(t3.percent, 100);
  assert.equal(p.currentPhaseId, null);

  // The project's own fields survive a save.
  S.setProjectField(p, 'description', 'All seven modules');
  S.setProjectField(p, 'deadline', '2026-11-01');
  S.setProjectField(p, 'status', 'In Progress');
  S.commentOnProject(p, 'On track');
  const back = parse(serialize(p)).project;
  assert.deepEqual([back.description, back.deadline, back.status, back.phases.map((x) => x.status || 'open')], ['All seven modules', '2026-11-01', 'In Progress', ['done', 'open', 'done']]);
  assert.equal(back.activity.at(-1).text, 'On track');
  S.setProjectField(p, 'status', 'Completed');
  assert.equal(p.archived, true);
});

test('a new stage goes where it is put and moves what follows by its length', async () => {
  const { addPhase } = await import('../src/model/model.js');
  const S = await import('../src/model/stages.js');
  const p = createProject('P', '2026-09-26');
  const a = addPhase(p, { name: 'sage 1', deadline: '2026-10-10' });
  const b = addPhase(p, { name: 'stage 2', deadline: '2026-10-17' });
  p.deadline = '2026-10-17';
  const r = S.insertStage(p, { name: 'stage 3', afterId: a.id, days: 7 });
  assert.deepEqual(p.phases.map((x) => [x.name, x.deadline]), [['sage 1', '2026-10-10'], ['stage 3', '2026-10-17'], ['stage 2', '2026-10-24']]);
  assert.deepEqual([r.deadlineFrom, r.deadlineTo], ['2026-10-17', '2026-10-24']);
  S.insertStage(p, { name: 'first', days: 3 });
  assert.equal(p.phases[0].deadline, '2026-09-28');
  assert.equal(p.phases[1].deadline, '2026-10-13');
});

test('moving a project on the Gantt moves its start, deadline, stages and open tasks together', async () => {
  const { createProject, insertTask } = await import('../src/model/model.js');
  const { shiftProject, setProjectDates, insertStage } = await import('../src/model/stages.js');
  const { toDay, fromDay } = await import('../src/model/calendar.js');
  const p = createProject('Move me', '2026-10-05');
  p.deadline = '2026-10-30';
  const open = insertTask(p, 0, { name: 'Open', duration: 2, level: 1 });
  open.deadline = '2026-10-20';
  open.constraint = { type: 'SNET', date: '2026-10-07' };
  const done = insertTask(p, 1, { name: 'Done', duration: 1, level: 1 });
  done.percent = 100; done.deadline = '2026-10-06';
  insertStage(p, { name: 'Build', days: 5 });
  const stageWas = p.phases[0].deadline;
  const deadlineWas = p.deadline;
  shiftProject(p, 7);
  assert.equal(p.start, '2026-10-12');
  assert.equal(p.deadline, fromDay(toDay(deadlineWas) + 7));
  assert.equal(open.deadline, '2026-10-27');
  assert.equal(open.constraint.date, '2026-10-14');
  assert.equal(done.deadline, '2026-10-06', 'finished work keeps its dates');
  assert.notEqual(p.phases[0].deadline, stageWas);
  setProjectDates(p, { deadline: '2026-11-20' });
  assert.equal(p.deadline, '2026-11-20');
  assert.throws(() => setProjectDates(p, { start: '2026-12-01' }), /before it starts/);
});

test('merging two resources of one person joins their work and drops the second', async () => {
  const { createProject, insertTask, addResource, assign, mergeResources } = await import('../src/model/model.js');
  const p = createProject('Merge', '2026-10-05');
  const a = addResource(p, { name: 'Allen X' });
  const b = addResource(p, { name: 'Allen Xu' });
  const t1 = insertTask(p, 0, { name: 'Both', duration: 1, level: 1 });
  const t2 = insertTask(p, 1, { name: 'Only B', duration: 1, level: 1 });
  assign(p, t1.id, a.id, 1); assign(p, t1.id, b.id, 0.5); assign(p, t2.id, b.id, 1);
  p.timesheets.push({ id: 'ts1', taskId: t2.id, resourceId: b.id, date: '2026-10-05', hours: 2 });
  mergeResources(p, a.id, b.id);
  assert.deepEqual(p.resources.map((r) => r.name), ['Allen X']);
  assert.deepEqual(t1.assignments, [{ resourceId: a.id, units: 1 }]);
  assert.equal(t2.assignments[0].resourceId, a.id);
  assert.equal(p.timesheets[0].resourceId, a.id);
});
