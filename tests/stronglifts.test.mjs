// StrongLifts' CSV export becomes lifting plans: one task per training day,
// a timesheet line per workout, grouped into the plans the shelf already has.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStrongLifts, dayTasks, planNameFor, mergeLifting } from '../src/io/stronglifts.js';
import { createProject } from '../src/model/model.js';

const HEAD = 'Date (yyyy/mm/dd),Workout,Workout Name,Program Name,Body Weight (LB),Exercise,Sets×Reps,Sets×Time,Top Set (Reps×LB),e1RM (LB),Reps,Volume (LB),Workout Volume (LB),Duration (hours),Start Time (h:mm),End Time (h:mm),Notes,Set 1 (Reps),Set 1 (LB)';
const CSV = `﻿${HEAD}
2015/05/22,1,"Workout A","",228.5,"Squat",5×5,,5×135,166.4,25,3375,8375.0,1,5:42 PM,6:42 PM,"",5,135
2015/05/22,1,"Workout A","",228.5,"Bench Press",5×5,,5×135,166.4,25,3375,8375.0,1,5:42 PM,6:42 PM,"",5,135
2015/05/22,1,"Workout A","",228.5,"Barbell Row",Skipped,,,,,,,1,5:42 PM,6:42 PM,"",,
2015/05/24,2,"Workout B","",228,"Squat",5×5,,5×145,178.7,25,3625,5000.0,0.75,6:00 PM,6:45 PM,"felt heavy",5,145
2015/05/24,3,"Cardio","",228,"Walk",,10×1:00,,,,,,0.25,7:00 PM,7:15 PM,"",,
`;

test('each workout becomes a session with its lifts, hours and body weight', () => {
  const sessions = parseStrongLifts(CSV);
  assert.equal(sessions.length, 3);
  const [a, b, c] = sessions;
  assert.equal(a.date, '2015-05-22');
  assert.equal(a.name, 'Workout A');
  assert.equal(a.hours, 1);
  assert.equal(a.bodyWeight, 228.5);
  assert.equal(a.start, '5:42 PM');
  assert.deepEqual(a.lifts.map((l) => [l.exercise, l.topSet, l.skipped]), [['Squat', '5×135', false], ['Bench Press', '5×135', false], ['Barbell Row', '', true]]);
  assert.equal(b.notes, 'felt heavy');
  assert.equal(c.name, 'Cardio');
  assert.equal(c.hours, 0.25);
});

test('the BOM, a missing column and an empty file are handled', () => {
  assert.deepEqual(parseStrongLifts(''), []);
  assert.throws(() => parseStrongLifts('a,b\n1,2\n'), /StrongLifts/);
});

test('a training day is one task, each workout a timesheet line, the top sets in the name', () => {
  const tasks = dayTasks(parseStrongLifts(CSV));
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].name, 'Workout A — Squat 5×135, Bench Press 5×135');
  assert.equal(tasks[0].date, '2015-05-22');
  assert.equal(tasks[0].work, 1);
  assert.match(tasks[0].notes, /body weight 228\.5 lb; 2\/3 lifts done; skipped 1/);
  assert.deepEqual(tasks[0].sheets, [{ date: '2015-05-22', hours: 1, note: 'Workout A (StrongLifts)' }]);
  assert.equal(tasks[1].name, 'Workout B — Squat 5×145');
  assert.equal(tasks[1].work, 1, 'two workouts that day: 0.75 + 0.25');
  assert.equal(tasks[1].sheets.length, 2);
});

test('a year lands in the plan that already covers it, else a plan of its own', () => {
  const have = ['Lifting 2019–20 (StrongLifts 5×5)', 'Lifting 2023 (StrongLifts 5×5)', 'Alcon SO 1'];
  assert.equal(planNameFor(2020, have), 'Lifting 2019–20 (StrongLifts 5×5)');
  assert.equal(planNameFor(2019, have), 'Lifting 2019–20 (StrongLifts 5×5)');
  assert.equal(planNameFor(2023, have), 'Lifting 2023 (StrongLifts 5×5)');
  assert.equal(planNameFor(2024, have), 'Lifting 2024 (StrongLifts 5×5)');
});

test('merging adds the days a plan lacks and never a day it has', () => {
  const p = createProject('Lifting 2015 (StrongLifts 5×5)', '2015-05-22');
  const person = { personId: 'person_1', name: 'Allen Xu', initials: 'AX' };
  const first = mergeLifting(p, dayTasks(parseStrongLifts(CSV)), person);
  assert.equal(first.added, 2);
  assert.equal(p.tasks.length, 2);
  assert.equal(p.timesheets.length, 3);
  assert.equal(p.resources.length, 1);
  assert.equal(p.tasks[0].skill, 'Lifting');
  assert.equal(p.tasks[0].energy, 'physical');
  assert.equal(p.tasks[0].percent, 100);
  assert.equal(p.timesheets[0].resourceId, p.resources[0].id);
  const again = mergeLifting(p, dayTasks(parseStrongLifts(CSV)), person);
  assert.equal(again.added, 0);
  assert.equal(again.skipped, 2);
  assert.equal(p.tasks.length, 2, 'nothing doubled');
  assert.equal(p.resources.length, 1, 'the same person, once');
});
