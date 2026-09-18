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
