// StrongLifts has no API; it exports a CSV (one row per exercise per workout).
// This turns that file into lifting plans the way the shelf already holds
// them: one plan per era ("Lifting 2019–20 (StrongLifts 5×5)"), one task per
// training day, a timesheet line per workout, every task labelled with the
// Lifting skill so the Skills app can read it.

import { newTask, newResource, newTimesheet } from '../model/model.js';

export const SKILL = 'Lifting';
const PLAN_RE = /^Lifting (\d{4})(?:[–-](\d{2,4}))? \(StrongLifts 5×5\)$/;

/** A CSV with quoted fields, as the app writes it. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x !== ''));
}

const quarter = (h) => Math.round(h * 4) / 4;

/**
 * The workouts in a StrongLifts export: `{ date, workout, name, bodyWeight,
 * hours, start, notes, lifts: [{ exercise, setsReps, topSet, skipped }] }`,
 * in file order. Throws when the file is not a StrongLifts export.
 */
export function parseStrongLifts(text) {
  const rows = parseCsv(String(text || ''));
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  const col = (name) => head.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const cDate = col('Date (yyyy/mm/dd)'), cWo = col('Workout'), cName = col('Workout Name'), cBw = col('Body Weight (LB)'), cEx = col('Exercise'),
    cSets = col('Sets×Reps'), cTop = col('Top Set (Reps×LB)'), cDur = col('Duration (hours)'), cStart = col('Start Time (h:mm)'), cNotes = col('Notes');
  if (cDate < 0 || cWo < 0 || cEx < 0) throw new Error('This is not a StrongLifts export: it needs Date, Workout and Exercise columns.');
  const sessions = new Map();
  for (const r of rows.slice(1)) {
    const key = `${r[cDate]}|${r[cWo]}`;
    let s = sessions.get(key);
    if (!s) {
      s = {
        date: String(r[cDate] || '').replace(/\//g, '-'), workout: r[cWo], name: cName >= 0 ? r[cName] || 'Workout' : 'Workout',
        bodyWeight: cBw >= 0 ? Number(r[cBw]) || null : null, hours: cDur >= 0 ? Number(r[cDur]) || 0 : 0,
        start: cStart >= 0 ? r[cStart] || '' : '', notes: cNotes >= 0 ? r[cNotes] || '' : '', lifts: [],
      };
      sessions.set(key, s);
    }
    if (!s.notes && cNotes >= 0 && r[cNotes]) s.notes = r[cNotes];
    const setsReps = cSets >= 0 ? r[cSets] || '' : '';
    s.lifts.push({ exercise: r[cEx], setsReps, topSet: cTop >= 0 ? r[cTop] || '' : '', skipped: setsReps === 'Skipped' });
  }
  return [...sessions.values()];
}

/** The sessions as the plan's tasks: one per day, the workouts as its timesheet lines. */
export function dayTasks(sessions) {
  const byDay = new Map();
  for (const s of sessions) { if (!byDay.has(s.date)) byDay.set(s.date, []); byDay.get(s.date).push(s); }
  return [...byDay.entries()].map(([date, list]) => {
    const tops = [], total = list.reduce((n, s) => n + s.lifts.length, 0), skipped = list.reduce((n, s) => n + s.lifts.filter((l) => l.skipped).length, 0);
    for (const s of list) for (const l of s.lifts) if (!l.skipped && l.topSet) tops.push(`${l.exercise} ${l.topSet}`);
    const hours = list.reduce((n, s) => n + (s.hours || 0), 0) || 1;
    const first = list[0];
    return {
      name: `${first.name} — ${tops.slice(0, 5).join(', ') || 'all sets skipped'}`,
      date, work: quarter(hours), doneAt: `${date}T12:00`,
      notes: `body weight ${first.bodyWeight ?? '?'} lb; ${total - skipped}/${total} lifts done${skipped ? `; skipped ${skipped}` : ''}${first.start ? `; start ${first.start}` : ''}${list.some((s) => s.notes) ? `; ${list.map((s) => s.notes).filter(Boolean).join(' / ')}` : ''}`,
      sheets: list.map((s) => ({ date, hours: quarter(s.hours || 1), note: `${s.name} (StrongLifts)` })),
    };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

/** The plan a year's lifting belongs in: one already on the shelf that covers it, else its own. */
export function planNameFor(year, existingNames) {
  for (const name of existingNames) {
    const m = PLAN_RE.exec(name);
    if (!m) continue;
    const from = Number(m[1]);
    const to = m[2] ? (m[2].length === 2 ? Number(m[1].slice(0, 2) + m[2]) : Number(m[2])) : from;
    if (year >= from && year <= to) return name;
  }
  return `Lifting ${year} (StrongLifts 5×5)`;
}

/**
 * Adds the days a plan lacks. A day already in the plan (a task due that
 * date) is left alone, so the same export can be imported again safely.
 * `person` is { personId, name, initials }: the one resource every task and
 * line is on.
 */
export function mergeLifting(project, tasks, person) {
  if (!Array.isArray(project.timesheets)) project.timesheets = [];
  let r = project.resources.find((x) => x.personId && x.personId === person.personId) || project.resources.find((x) => x.name === person.name);
  if (!r) { r = newResource({ personId: person.personId || null, name: person.name, initials: person.initials || '' }); project.resources.push(r); }
  const have = new Set(project.tasks.map((t) => t.deadline || t.constraint?.date).filter(Boolean));
  let added = 0, skipped = 0;
  for (const T of tasks) {
    if (have.has(T.date)) { skipped++; continue; }
    const t = newTask({
      name: T.name, deadline: T.date, constraint: { type: 'SNET', date: T.date }, percent: 100, doneAt: T.doneAt, work: T.work,
      notes: T.notes, skill: SKILL, energy: 'physical', assignments: [{ resourceId: r.id, units: 1 }],
    });
    project.tasks.push(t);
    for (const s of T.sheets) project.timesheets.push(newTimesheet({ taskId: t.id, resourceId: r.id, date: s.date, hours: s.hours, note: s.note }));
    have.add(T.date);
    added++;
  }
  project.skill = SKILL;
  project.energy = 'physical';
  return { added, skipped };
}
