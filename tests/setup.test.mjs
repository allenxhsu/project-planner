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
