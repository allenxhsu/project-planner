import test from 'node:test';
import assert from 'node:assert/strict';
import { occurrences, describeRepeat, cleanRepeat } from '../src/model/routines.js';
import { createProject, insertTask, setTaskField, spawnRoutines } from '../src/model/model.js';
import { toDay, fromDay } from '../src/model/calendar.js';
import { serialize, parse } from '../src/io/json.js';

const D = (iso) => toDay(iso);
const days = (list) => list.map((o) => [fromDay(o.day), fromDay(o.due)]);

test('weekly on a Monday: due by the Sunday after', () => {
  const r = { freq: 'weekly', days: [1], from: '2026-09-28' };
  assert.deepEqual(days(occurrences(r, D('2026-09-28'), D('2026-10-12'))),
    [['2026-09-28', '2026-10-04'], ['2026-10-05', '2026-10-11'], ['2026-10-12', '2026-10-18']]);
});

test('every 2 weeks keeps to the weeks it started in', () => {
  const r = { freq: 'biweekly', days: [5], from: '2026-10-02' };   // a Friday
  assert.deepEqual(days(occurrences(r, D('2026-09-28'), D('2026-10-31'))),
    [['2026-10-02', '2026-10-15'], ['2026-10-16', '2026-10-29'], ['2026-10-30', '2026-11-12']]);
});

test('weekdays and daily are due the day they fall; monthly clamps to the month', () => {
  assert.deepEqual(days(occurrences({ freq: 'weekdays', from: '2026-10-02' }, D('2026-10-02'), D('2026-10-06'))),
    [['2026-10-02', '2026-10-02'], ['2026-10-05', '2026-10-05'], ['2026-10-06', '2026-10-06']]);
  assert.deepEqual(occurrences({ freq: 'monthly', from: '2026-01-31' }, D('2026-02-01'), D('2026-03-31')).map((o) => fromDay(o.day)),
    ['2026-02-28', '2026-03-31']);
  assert.equal(describeRepeat({ freq: 'biweekly', days: [1, 4], from: '2026-09-28' }), 'Every 2 weeks on Mon, Thu');
  assert.equal(cleanRepeat({ freq: 'none', from: '2026-09-28' }), null);
});

function routinePlan() {
  const p = createProject('Work', '2026-09-01');
  const t = insertTask(p, 0, { name: 'Biweekly report', duration: 1, level: 1 });
  setTaskField(p, t.id, 'work', '1');
  setTaskField(p, t.id, 'repeat', { freq: 'biweekly', days: [5], from: '2026-10-02' });
  return { p, t };
}

test('a routine is off the calendar; its occurrences are made a fortnight ahead, on it', () => {
  const { p, t } = routinePlan();
  assert.equal(t.calendar.show, false, 'the pattern itself is not scheduled');
  const made = spawnRoutines(p, '2026-09-29');
  assert.deepEqual(made.map((x) => [x.id, x.constraint.date, x.deadline]), [[`${t.id}@2026-10-02`, '2026-10-02', '2026-10-15']]);
  const o = made[0];
  assert.equal(o.name, 'Biweekly report');
  assert.equal(+o.work, 1);
  assert.equal(o.calendar.show, true, 'auto-scheduled');
  assert.equal(o.repeatOf, t.id);
  assert.equal(t.repeat.made, '2026-10-02');
});

test('nothing is made twice, and a deleted occurrence is not made again', () => {
  const { p, t } = routinePlan();
  spawnRoutines(p, '2026-09-29');
  assert.equal(spawnRoutines(p, '2026-09-30').length, 0, 'same fortnight, nothing new');
  p.tasks = p.tasks.filter((x) => x.id !== `${t.id}@2026-10-02`);            // deleted by hand
  assert.equal(spawnRoutines(p, '2026-09-30').length, 0, 'not brought back');
  const later = spawnRoutines(p, '2026-10-05');                               // the next one comes into range
  assert.deepEqual(later.map((x) => x.occurrence), ['2026-10-16']);
});

test('a routine and its occurrences survive a save', () => {
  const { p, t } = routinePlan();
  spawnRoutines(p, '2026-09-29');
  const back = parse(serialize(p)).project;
  const r = back.tasks.find((x) => x.id === t.id);
  assert.deepEqual(r.repeat, { freq: 'biweekly', from: '2026-10-02', days: [5], made: '2026-10-02' });
  const o = back.tasks.find((x) => x.repeatOf === t.id);
  assert.equal(o.occurrence, '2026-10-02');
  assert.equal(spawnRoutines(back, '2026-09-29').length, 0, 'read back, still not made twice');
});

test('at a set time: each occurrence is fixed there on its day, for as long as the routine takes', () => {
  const p = createProject('Work', '2026-09-01');
  const t = insertTask(p, 0, { name: 'Clear flags', duration: 1, level: 1 });
  setTaskField(p, t.id, 'work', '0.5');
  setTaskField(p, t.id, 'repeat', { freq: 'weekly', days: [1], from: '2026-09-28', at: '09:00' });
  assert.equal(describeRepeat(t.repeat), 'Every week on Mon at 9:00 AM');
  const made = spawnRoutines(p, '2026-09-28');
  assert.deepEqual(made.map((x) => x.calendar.pins.map((pin) => [pin.day, pin.start, pin.minutes])),
    [[['2026-09-28', 540, 30]], [['2026-10-05', 540, 30]], [['2026-10-12', 540, 30]]]);
  assert.ok(made.every((x) => x.calendar.show === false), 'fixed instead of auto-scheduled');
  const back = parse(serialize(p)).project;
  assert.equal(back.tasks.find((x) => x.id === t.id).repeat.at, '09:00', 'the time is kept');
});

test('at a set time, an occurrence on a day already gone is not made', () => {
  const p = createProject('Work', '2026-09-01');
  const t = insertTask(p, 0, { name: 'Standup notes', duration: 1, level: 1 });
  setTaskField(p, t.id, 'repeat', { freq: 'weekly', days: [1], from: '2026-09-21', at: '09:00' });
  // Tuesday: Monday's has gone by at its time; the next Monday is the first.
  assert.deepEqual(spawnRoutines(p, '2026-09-29').map((x) => x.occurrence), ['2026-10-05', '2026-10-12']);
  // Without a time, this week's is still made, to be done by Sunday.
  const q = createProject('Work', '2026-09-01');
  const u = insertTask(q, 0, { name: 'Weekly review', duration: 1, level: 1 });
  setTaskField(q, u.id, 'repeat', { freq: 'weekly', days: [1], from: '2026-09-21' });
  assert.equal(spawnRoutines(q, '2026-09-29')[0].occurrence, '2026-09-28');
});
