// Fixes from the code review: each one a bug that had a way in.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createProject, insertTask, addResource, setTaskField, setPin, personResource, addStage, setStageDone, setStage, removeStage, mapStatus, stages,
} from '../src/model/model.js';
import { serialize, parse } from '../src/io/json.js';

test('a person is never matched to a material or cost resource of the same name', () => {
  const p = createProject('Kitchen', '2026-09-28');
  const crate = addResource(p, { name: 'Allen Xu', type: 'material' });
  const r = personResource(p, { name: 'allen xu' });
  assert.notEqual(r.id, crate.id);
  assert.equal(r.type, 'work');
  assert.equal(personResource(p, { name: 'Allen Xu' }).id, r.id, 'and found again, not added twice');
});

test('done means 100%: mapping a status into a done one, or removing a done column, keeps it true', () => {
  const p = createProject('Board', '2026-09-28');
  const review = addStage(p, 'Review');
  const shipped = addStage(p, 'Shipped');
  setStageDone(p, shipped.id, true);
  const t = insertTask(p, 0, { name: 'Draft', level: 1 });
  setStage(p, t.id, review.id);
  assert.ok(t.percent < 100);
  // Merging workspaces maps this plan's "Review" onto the other's done "Shipped".
  mapStatus(p, 'Review', 'Shipped');
  assert.equal(t.stageId, shipped.id);
  assert.equal(t.percent, 100, 'a task mapped into a done status is complete');

  // A done column removed: its tasks go to another done column, still complete.
  const done = stages(p).filter((s) => s.done);
  assert.ok(done.length >= 2);
  removeStage(p, shipped.id);
  const now = stages(p).find((s) => s.id === t.stageId);
  assert.ok(now?.done, 'moved to a column that means finished');
  assert.equal(t.percent, 100);
  // The last done column cannot go.
  const last = stages(p).filter((s) => s.done);
  for (const s of last.slice(1)) removeStage(p, s.id);
  assert.throws(() => removeStage(p, last[0].id), /finished/);
});

test('every calendar setting of a task survives a save', () => {
  const p = createProject('Round trip', '2026-09-28');
  p.timeBlocks = [{ id: 'tb', name: 'Day', from: '09:00', to: '17:00', days: [1, 2, 3, 4, 5] }];
  const t = insertTask(p, 0, { name: 'Everything', level: 1 });
  setTaskField(p, t.id, 'work', '3');
  setTaskField(p, t.id, 'calendarShow', true);
  setTaskField(p, t.id, 'blockHours', 2);
  setTaskField(p, t.id, 'timeBlock', ['tb']);
  setTaskField(p, t.id, 'notBefore', '2026-09-29T10:00');
  setTaskField(p, t.id, 'calendarFrom', '10:00');
  setTaskField(p, t.id, 'calendarTo', '12:00');
  setPin(p, t.id, { day: '2026-09-29', start: 600, minutes: 60 });
  const before = { ...t.calendar };
  const back = parse(serialize(p)).project.tasks[0].calendar;
  for (const key of Object.keys(before)) assert.deepEqual(back[key], before[key], `calendar.${key} is kept`);
  setTaskField(p, t.id, 'wholeBlock', true);
  assert.equal(parse(serialize(p)).project.tasks[0].calendar.whole, true, 'calendar.whole is kept');
});

test('no menu command is defined twice', () => {
  const src = fs.readFileSync(new URL('../src/ui/toolbar.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('export const COMMANDS = {'), src.indexOf('\n};', src.indexOf('export const COMMANDS = {')));
  const keys = [...block.matchAll(/'([a-z]+\.[A-Za-z]+)':/g)].map((m) => m[1]);
  const twice = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepEqual(twice, [], 'a second definition silently replaces the first');
  assert.ok(keys.includes('view.today') && keys.includes('view.goToToday'));
});

test('levels, pools and what a task trains', async () => {
  const { levelOf, poolOf, energyOf, skillOf } = await import('../src/model/skills.js');
  assert.equal(levelOf(0).level, 1);
  assert.equal(levelOf(119).level, 1);
  assert.equal(levelOf(120).level, 2, 'two hours is level 2');
  assert.equal(levelOf(360).level, 3, 'six hours is level 3');
  assert.equal(levelOf(240).pct, 50, 'halfway from 2 h to 6 h');
  assert.equal(poolOf('physical', 1), 240);
  assert.equal(poolOf('mental', 5), 360 + 60, 'the pool grows a quarter hour a level');
  assert.equal(energyOf({ energy: 'physical' }, {}), 'physical');
  assert.equal(energyOf({ energy: 'physical' }, { energy: 'mental' }), 'mental', 'the task says first');
  assert.equal(energyOf({}, {}), 'mental');
  assert.equal(skillOf({ name: 'Kitchen' }, {}, { folderName: 'Cooking', workspaceName: 'Personal' }), 'Cooking');
  assert.equal(skillOf({ name: 'Kitchen', skill: 'Housekeeping' }, {}, { folderName: 'Cooking' }), 'Housekeeping');
  assert.equal(skillOf({ name: 'Kitchen' }, { skill: 'Knife work' }, {}), 'Knife work');
  assert.equal(skillOf({ name: 'ISEN 665' }, {}, { workspaceName: 'School' }), 'School');
});
