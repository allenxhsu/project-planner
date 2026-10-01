import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, insertTask, addResource, assign, addTimesheet, setTaskField, removeTasks, takeTasks, putTasks, stages, spawnRoutines } from '../src/model/model.js';

function wrongPlan() {
  const p = createProject('Home Organization', '2026-09-01');
  const allen = addResource(p, { name: 'Allen Xu', personId: 'person_ax' });
  const parent = insertTask(p, 0, { name: 'Clear flags & broken links', duration: 1, level: 1 });
  const child = insertTask(p, 1, { name: 'Broken links in ECEN 5013', duration: 1, level: 2 });
  const stay = insertTask(p, 2, { name: 'Clean the kitchen', duration: 1, level: 1 });
  child.predecessors = [{ id: stay.id, type: 'FS', lag: 0 }];
  assign(p, child.id, allen.id, 1);
  addTimesheet(p, { taskId: child.id, resourceId: allen.id, date: '2026-09-29', start: 600, hours: 0.5, note: 'Worked' });
  const done = stages(p).find((s) => s.done);
  child.stageId = done.id;
  return { p, parent, child, stay };
}

test('a task moves with its subtasks, its logged time and its people', () => {
  const { p, parent, child, stay } = wrongPlan();
  const q = createProject('CUB', '2026-09-01');
  const moved = takeTasks(p, [parent.id]);
  assert.deepEqual(moved.ids.sort(), [parent.id, child.id].sort(), 'the subtask goes with it');
  const landed = putTasks(q, moved);
  removeTasks(p, moved.ids);

  assert.deepEqual(landed.map((t) => [t.name, t.level]), [['Clear flags & broken links', 1], ['Broken links in ECEN 5013', 2]]);
  const c = landed[1];
  const allen = q.resources.find((r) => r.personId === 'person_ax');
  assert.ok(allen, 'the same person is on the new plan');
  assert.deepEqual(c.assignments.map((a) => a.resourceId), [allen.id]);
  assert.deepEqual(c.predecessors, [], 'a link to a task left behind is dropped');
  assert.equal(stages(q).find((s) => s.id === c.stageId)?.done, true, 'done stays done');
  assert.deepEqual(q.timesheets.map((x) => [x.taskId, x.resourceId, x.hours]), [[c.id, allen.id, 0.5]]);
  assert.match(landed[0].activity.at(-1).text, /moved here from Home Organization/);

  assert.deepEqual(p.tasks.map((t) => t.name), [stay.name], 'gone from where it was');
  assert.equal((p.timesheets || []).length, 0, 'and its logged time with it');
});

test('a routine moves with its occurrences', () => {
  const p = createProject('Home', '2026-09-01');
  const r = insertTask(p, 0, { name: 'Clear flags', duration: 1, level: 1 });
  setTaskField(p, r.id, 'repeat', { freq: 'weekly', days: [1], from: '2026-09-28' });
  spawnRoutines(p, '2026-09-30');
  const q = createProject('CUB', '2026-09-01');
  const moved = takeTasks(p, [r.id]);
  putTasks(q, moved);
  removeTasks(p, moved.ids);
  assert.equal(p.tasks.length, 0);
  const routine = q.tasks.find((t) => t.repeat);
  assert.ok(q.tasks.filter((t) => t.repeatOf === routine.id).length >= 2, 'its occurrences came too, still its own');
});
