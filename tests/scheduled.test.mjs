// A task's scheduled sitting: start and end, date and time (model.js).
//
// Tasks had a start date and a deadline, both days; the calendar laid them
// into clock time and Google Calendar showed the result. Now the task itself
// says when it is scheduled — `scheduled: { start, end }` — mirroring its
// event, kept in step with its first fixed block, editable on the task sheet.
//
// Run with:  node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createProject, insertTask, setPin, removePin, clearPins, pinsOf, setTaskField, scheduledOf, setScheduled } from '../src/model/model.js';
import { serialize, parse } from '../src/io/json.js';

const MON = '2026-09-21';
const TUE = '2026-09-22';
const plan = () => {
  const p = createProject('P', MON);
  const t = insertTask(p, 0, { name: 'Call Arcadia', duration: 1, level: 1 });
  return { p, t };
};

test('a task says nothing until it is scheduled', () => {
  const { t } = plan();
  assert.equal(scheduledOf(t), null);
});

test('scheduling a task fixes it there: one pin, and the start and end read back', () => {
  const { p, t } = plan();
  setScheduled(p, t.id, { start: `${MON}T09:00`, end: `${MON}T10:30` });
  assert.deepEqual(scheduledOf(t), { start: `${MON}T09:00`, end: `${MON}T10:30` });
  assert.deepEqual(pinsOf(t), [{ day: MON, start: 9 * 60, minutes: 90 }]);
  assert.equal(t.calendar.show, true, 'a scheduled task is on the calendar');
});

test('scheduling again replaces the sitting, and clearing takes it off', () => {
  const { p, t } = plan();
  setScheduled(p, t.id, { start: `${MON}T09:00`, end: `${MON}T10:00` });
  setScheduled(p, t.id, { start: `${TUE}T14:00`, end: `${TUE}T15:00` });
  assert.deepEqual(pinsOf(t), [{ day: TUE, start: 14 * 60, minutes: 60 }], 'one sitting, not two');
  setScheduled(p, t.id, null);
  assert.equal(scheduledOf(t), null);
  assert.deepEqual(pinsOf(t), []);
});

test('a sitting is one day, ends after it starts, and lasts at least five minutes', () => {
  const { p, t } = plan();
  assert.throws(() => setScheduled(p, t.id, { start: `${MON}T09:00`, end: `${TUE}T10:00` }), /one day/);
  assert.throws(() => setScheduled(p, t.id, { start: `${MON}T10:00`, end: `${MON}T09:00` }), /after/);
  assert.throws(() => setScheduled(p, t.id, { start: `${MON}T09:00`, end: `${MON}T09:02` }), /five minutes/);
  assert.throws(() => setScheduled(p, t.id, { start: 'tomorrow', end: `${MON}T09:02` }), /YYYY-MM-DD/);
  assert.equal(scheduledOf(t), null, 'nothing half-written');
  setScheduled(p, t.id, { start: `${MON}T23:00`, end: `${TUE}T00:00` });
  assert.deepEqual(pinsOf(t), [{ day: MON, start: 23 * 60, minutes: 60 }], 'midnight is the end of the day it started');
});

test('the first fixed block is what the task says it is scheduled for', () => {
  const { p, t } = plan();
  setPin(p, t.id, { day: TUE, start: 10 * 60, minutes: 60 });
  assert.deepEqual(scheduledOf(t), { start: `${TUE}T10:00`, end: `${TUE}T11:00` });
  setPin(p, t.id, { day: MON, start: 13 * 60, minutes: 30 });
  assert.deepEqual(scheduledOf(t), { start: `${MON}T13:00`, end: `${MON}T13:30` }, 'the earliest of its blocks');
  removePin(p, t.id, pinsOf(t).findIndex((q) => q.day === MON));
  assert.deepEqual(scheduledOf(t), { start: `${TUE}T10:00`, end: `${TUE}T11:00` });
  clearPins(p, t.id);
  assert.equal(scheduledOf(t), null);
});

test('setTaskField takes a sitting too, for the MCP and the task sheet', () => {
  const { p, t } = plan();
  setTaskField(p, t.id, 'scheduled', { start: `${MON}T09:00`, end: `${MON}T10:00` });
  assert.deepEqual(scheduledOf(t), { start: `${MON}T09:00`, end: `${MON}T10:00` });
  setTaskField(p, t.id, 'scheduled', null);
  assert.equal(scheduledOf(t), null);
  assert.throws(() => setTaskField(p, t.id, 'scheduled', { start: `${MON}T09:00` }), /end/);
});

test('a sitting survives a save, and a file with pins but no sitting learns one', () => {
  const { p, t } = plan();
  setScheduled(p, t.id, { start: `${MON}T09:00`, end: `${MON}T10:00` });
  const back = parse(serialize(p)).project;
  assert.deepEqual(scheduledOf(back.tasks[0]), { start: `${MON}T09:00`, end: `${MON}T10:00` });

  const raw = JSON.parse(serialize(p));
  delete (raw.project || raw).tasks[0].scheduled;
  const older = parse(JSON.stringify(raw)).project;
  assert.deepEqual(scheduledOf(older.tasks[0]), { start: `${MON}T09:00`, end: `${MON}T10:00` }, 'read off the pin');
});
