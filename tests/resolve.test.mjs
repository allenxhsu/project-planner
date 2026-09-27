import test from 'node:test';
import assert from 'node:assert/strict';
import { carryMissed, missedBlocks, missedKey } from '../src/model/missed.js';
import { createProject, insertTask, setPin, stopWork, addTimesheet, settleStoppedWork } from '../src/model/model.js';
import { toDay } from '../src/model/calendar.js';

const DAY = toDay('2026-09-27');

test('blocks the calendar drew become missed once their time (and the grace) has gone', () => {
  const saved = { day: DAY, blocks: [
    { planId: 'p', taskId: 'a', start: 600, end: 660 },
    { planId: 'p', taskId: 'b', start: 900, end: 960 },
  ] };
  const at1030 = carryMissed([], saved, { todayNum: DAY, nowMin: 11 * 60 + 30 });
  assert.deepEqual(at1030.map((m) => m.taskId), ['a']);
  // Again later: no duplicates, and b has gone by too.
  const later = carryMissed(at1030, saved, { todayNum: DAY, nowMin: 17 * 60 });
  assert.deepEqual(later.map((m) => m.taskId), ['a', 'b']);
  // A drawing from yesterday has gone by whole.
  assert.equal(carryMissed([], { ...saved, day: DAY - 1 }, { todayNum: DAY, nowMin: 0 }).length, 2);
  // Kept a month, then let go.
  assert.equal(carryMissed([{ planId: 'p', taskId: 'z', day: DAY - 40, start: 0, end: 60 }], null, { todayNum: DAY, nowMin: 0 }).length, 0);
});

test('a missed block is drawn only while the task is open and nobody logged those hours', () => {
  const p = createProject();
  const t = insertTask(p, 0, { name: 'Report', duration: 1, level: 1 });
  const m = { planId: p.id, taskId: t.id, day: DAY, start: 600, end: 660 };
  const entries = (percent) => [{ project: p, schedule: { tasks: { [t.id]: { percent } } } }];
  assert.equal(missedBlocks([m], entries(0)).length, 1);
  assert.equal(missedBlocks([m], entries(0))[0].key, missedKey(m));
  assert.equal(missedBlocks([m], entries(100)).length, 0, 'done: nothing to resolve');
  addTimesheet(p, { taskId: t.id, date: '2026-09-27', start: 630, hours: 0.5, note: 'Worked' });
  assert.equal(missedBlocks([m], entries(0)).length, 0, 'worked then: it is a record, not a "!"');
});

test('Stop logs the time worked ending when it was stopped', () => {
  const p = createProject();
  const t = insertTask(p, 0, { name: 'Grill-me', duration: 1, level: 1 });
  setPin(p, t.id, { day: '2026-09-27', start: 14 * 60 + 50, minutes: 60, live: true });
  stopWork(p, t.id, { worked: 60, more: 60, end: 14 * 60 + 52 });
  assert.deepEqual(p.timesheets.map((x) => [x.start, x.hours]), [[13 * 60 + 52, 1]]);
});

test('time logged running past its Stop is moved to end at the Stop', () => {
  const p = createProject();
  const t = insertTask(p, 0, { name: 'Grill-me', duration: 1, level: 1 });
  addTimesheet(p, { taskId: t.id, date: '2026-09-27', start: 14 * 60 + 50, hours: 1, note: 'Worked' });
  t.activity = [...(t.activity || []), { at: '2026-09-27T14:52', kind: 'stopped', text: 'worked 1h, 1h more needed' }];
  assert.deepEqual(settleStoppedWork(p), ['Grill-me']);
  assert.equal(p.timesheets[0].start, 13 * 60 + 52);
  assert.deepEqual(settleStoppedWork(p), [], 'once is enough');
});
