import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleProject } from '../src/model/sample.js';
import { computeSchedule } from '../src/model/schedule.js';
import { exportMspdi, importMspdi, parseIsoDuration } from '../src/io/mspdi.js';
import { exportCsv, importCsv } from '../src/io/csv.js';
import { formatPredecessors } from '../src/model/model.js';

test('MS Project XML round-trips the plan', () => {
  const p = sampleProject();
  const s = computeSchedule(p);
  const xml = exportMspdi(p, s);
  assert.ok(xml.includes('<Project xmlns="http://schemas.microsoft.com/project">'));
  assert.ok(xml.includes('<PredecessorLink>'));
  const { project: q, report } = importMspdi(xml);
  assert.equal(report.tasks, p.tasks.length);
  assert.equal(report.resources, p.resources.length);
  assert.equal(report.links, p.tasks.reduce((n, t) => n + t.predecessors.length, 0));
  assert.deepEqual(q.tasks.map((t) => t.level), p.tasks.map((t) => t.level));
  assert.deepEqual(q.calendar.workDays, [1, 2, 3, 4, 5]);
  assert.deepEqual(q.calendar.holidays, p.calendar.holidays);
  const s2 = computeSchedule(q);
  p.tasks.forEach((t, i) => {
    const a = s.tasks[t.id], b = s2.tasks[q.tasks[i].id];
    assert.equal(b.startIso, a.startIso, `${t.name} start`);
    assert.equal(b.finishIso, a.finishIso, `${t.name} finish`);
    assert.equal(formatPredecessors(q, q.tasks[i]), formatPredecessors(p, t));
  });
  assert.equal(s2.cost, s.cost);
  assert.equal(parseIsoDuration('PT40H0M0S'), 40);
  assert.equal(parseIsoDuration('P2DT4H'), 52);
});

test('CSV exports every row and imports a plain list', () => {
  const p = sampleProject();
  const csv = exportCsv(p, computeSchedule(p));
  assert.equal(csv.split('\n').length, p.tasks.length + 1);
  const { project, skipped } = importCsv('Name,Duration,Predecessors,Resources\nPlan,3d,,Ann\nDo,1w,1,"Ann [50%], Bob"\nDone,0d,2,');
  assert.equal(project.tasks.length, 3);
  assert.equal(project.tasks[1].duration, 5);
  assert.equal(project.tasks[1].assignments.length, 2);
  assert.equal(project.resources.length, 2);
  assert.ok(project.tasks[2].milestone);
  assert.equal(formatPredecessors(project, project.tasks[2]), '2');
  assert.deepEqual(skipped, []);
});

test('an archived plan says so after a round trip, and a plain one does not', async () => {
  const { createProject } = await import('../src/model/model.js');
  const { serialize, parse } = await import('../src/io/json.js');
  const p = createProject('Finished job');
  assert.equal(p.archived, false);
  assert.equal(p.template, false);

  p.archived = true;
  p.archivedAt = '2026-09-25';
  const back = parse(serialize(p)).project;
  assert.equal(back.archived, true);
  assert.equal(back.archivedAt, '2026-09-25');

  // A plan written before archiving existed is not archived by accident.
  const older = JSON.parse(serialize(createProject('Older plan')));
  delete older.archived;
  delete older.archivedAt;
  const read = parse(JSON.stringify(older)).project;
  assert.equal(read.archived, false);
  assert.equal(read.archivedAt, null);
});

test('work in hand is neither a template nor an archive', async () => {
  const { createProject } = await import('../src/model/model.js');
  const { isCurrentWork } = await import('../src/state/sync.js');
  const live = createProject('Live');
  const template = { ...createProject('Pattern'), template: true };
  const archived = { ...createProject('Done'), archived: true };
  assert.equal(isCurrentWork(live), true);
  assert.equal(isCurrentWork(template), false);
  assert.equal(isCurrentWork(archived), false);
});

test('a project with no colour of its own does not come back red', async () => {
  const { createProject } = await import('../src/model/model.js');
  const { serialize, parse } = await import('../src/io/json.js');
  const p = createProject('No colour');
  assert.equal(p.colour, null);
  // `+null` is 0 and 0 is a perfectly good hue, so this is the trap.
  assert.equal(parse(serialize(p)).project.colour, null);

  p.colour = 0;                       // red, chosen on purpose, is kept
  assert.equal(parse(serialize(p)).project.colour, 0);
  p.colour = 400;                     // and a hue is read round the circle
  assert.equal(parse(serialize(p)).project.colour, 40);
});

test('a task keeps its BOM Manager link through a round trip, and the setter tidies it', async () => {
  const { createProject, newTask, setTaskField } = await import('../src/model/model.js');
  const { serialize, parse } = await import('../src/io/json.js');
  const p = createProject('Zipline workstation');
  p.tasks.push(newTask({ id: 't_mat', name: 'Material' }), newTask({ id: 't_build', name: 'Build' }));
  setTaskField(p, 't_mat', 'bom', { name: '  Zipline SO 287137 WO 423177 ' });
  const back = parse(serialize(p)).project;
  assert.deepEqual(back.tasks.find((t) => t.id === 't_mat').bom, { name: 'Zipline SO 287137 WO 423177' });
  assert.equal(back.tasks.find((t) => t.id === 't_build').bom, null);
  setTaskField(p, 't_mat', 'bom', { name: '' });
  assert.equal(p.tasks[0].bom, null, 'an empty name unlinks');
  // A plan written before the link existed reads as unlinked, and junk is not a link.
  const raw = JSON.parse(serialize(p));
  delete raw.tasks[0].bom;
  raw.tasks[1].bom = 'nope';
  const read = parse(JSON.stringify(raw)).project;
  assert.equal(read.tasks[0].bom, null);
  assert.equal(read.tasks[1].bom, null);
});
