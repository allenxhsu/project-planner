// Starting a project: from nothing, or from a template, set up in one go.
//
// The wizard (ui/newproject.js) asks the questions; this is what the answers
// do to a plan. It is kept apart from the screens so it can be tested, and so
// "a new project from a template" means the same thing wherever it is asked.

import { createProject, phases, addPhase, removePhase, phaseOf, isSummary, addResource, assign, fieldsOf, cleanField, removeField } from './model.js';
import { computeSchedule } from './schedule.js';
import { toDay, fromDay, makeCalendar, isoValid } from './calendar.js';

/**
 * A plan made ready to be used again: the shape kept, the history dropped —
 * nobody's progress, nobody's logged hours, no deadlines or pinned dates from
 * the last time it ran, nothing on anyone's calendar yet.
 */
export function freshCopy(project, start) {
  project.start = start;
  project.statusDate = null;
  project.timesheets = [];
  project.archived = false;
  project.archivedAt = null;
  project.pinned = false;
  for (const ph of phases(project)) ph.deadline = null;
  project.currentPhaseId = null;
  for (const t of project.tasks) {
    t.percent = 0;
    delete t.doneAt;
    t.stageId = null;
    t.deadline = null;
    t.archived = false;
    if (t.calendar) t.calendar = { ...t.calendar, show: false };
    if (t.calendar?.pins) delete t.calendar.pins;
    // A date pinned to last quarter would drag the whole copy back with it.
    if (t.constraint?.date) t.constraint = { type: 'ASAP', date: null };
  }
  return project;
}

/** Working days from one date to another, by the plan's own calendar. */
export function businessDays(project, fromIso, toIso) {
  if (!isoValid(fromIso) || !isoValid(toIso)) return null;
  return makeCalendar(project.calendar).distance(toDay(fromIso), toDay(toIso));
}

/** The date a number of working days after another. */
export function afterBusinessDays(project, fromIso, n) {
  const cal = makeCalendar(project.calendar);
  return fromDay(cal.add(cal.next(toDay(fromIso)), Math.max(0, Math.round(n))));
}

/**
 * When each phase would end if the plan ran from `start` as drawn: the last
 * finish of any task in it. A phase with no tasks gets nothing — there is
 * nothing to say when it ends.
 */
export function phaseFinishes(project) {
  const sched = computeSchedule(project);
  const out = new Map();
  project.tasks.forEach((t, i) => {
    if (isSummary(project, i)) return;
    const ph = phaseOf(project, t.id);
    const info = sched.tasks[t.id];
    if (!ph || !info) return;
    out.set(ph, Math.max(out.get(ph) ?? -Infinity, info.finish));
  });
  return new Map([...out].map(([id, day]) => [id, fromDay(day)]));
}

/**
 * Apply the wizard's answers to a plan.
 *
 * @param {object} project  a fresh plan, or a template's copy (see freshCopy)
 * @param {{ name: string, workspaceId?: string|null, start: string,
 *           phases: Array<{ id?: string, name: string, deadline?: string|null,
 *                           people?: Array<{ personId?: string|null, name: string, initials?: string }> }>,
 *           fields?: Array<{ id?: string, name: string, type: string, options?: string[] }>,
 *           onCalendar?: boolean }} answers
 *
 * Phases are matched by id: kept ones are renamed and dated, new ones added,
 * ones taken out removed (their tasks go back to no phase). Then a phase's
 * deadline becomes the deadline of each of its tasks that has none, and its
 * people are assigned to each of its tasks that has nobody — the two things a
 * phase says about the work in it.
 */
export function setUpProject(project, answers) {
  const p = project;
  p.name = String(answers.name || '').trim() || 'Untitled project';
  p.workspaceId = answers.workspaceId || null;
  if (isoValid(answers.start)) p.start = answers.start;
  p.template = false;

  // Phases.
  const wanted = (answers.phases || []).filter((ph) => String(ph.name || '').trim());
  const keep = new Set(wanted.map((ph) => ph.id).filter(Boolean));
  for (const ph of [...phases(p)]) if (!keep.has(ph.id)) removePhase(p, ph.id);
  const ordered = [];
  for (const w of wanted) {
    let ph = w.id ? phases(p).find((x) => x.id === w.id) : null;
    if (!ph) ph = addPhase(p, { name: w.name });
    ph.name = String(w.name).trim();
    ph.deadline = isoValid(w.deadline) ? w.deadline : null;
    ordered.push(ph);
  }
  p.phases = ordered;

  // Custom fields: the list as given; values for a dropped field go with it.
  if (answers.fields) {
    const next = answers.fields.map(cleanField).filter(Boolean);
    const ids = new Set(next.map((f) => f.id));
    for (const f of fieldsOf(p)) if (!ids.has(f.id)) removeField(p, f.id);
    p.fields = next;
  }

  // What each phase says about its tasks.
  const resourceFor = (person) => {
    const byPerson = person.personId && p.resources.find((r) => r.personId === person.personId);
    const byName = p.resources.find((r) => r.name.trim().toLowerCase() === String(person.name).trim().toLowerCase());
    const found = byPerson || byName;
    if (found) { if (person.personId && !found.personId) found.personId = person.personId; return found; }
    return addResource(p, { name: String(person.name).trim(), initials: person.initials || '', personId: person.personId || null });
  };
  wanted.forEach((w, k) => {
    const ph = ordered[k];
    const people = (w.people || []).filter((x) => String(x?.name || '').trim()).map(resourceFor);
    p.tasks.forEach((t, i) => {
      if (isSummary(p, i) || t.archived || phaseOf(p, t.id) !== ph.id) return;
      if (ph.deadline && !t.deadline) t.deadline = ph.deadline;
      if (people.length && !t.assignments.length && !t.milestone) for (const r of people) assign(p, t.id, r.id, 1);
    });
  });

  if (answers.onCalendar) {
    p.tasks.forEach((t, i) => {
      if (isSummary(p, i) || t.milestone || t.archived) return;
      t.calendar = { ...(t.calendar || { timeBlockIds: [] }), show: true };
    });
  }
  return p;
}

/** A plan from nothing, with the answers applied. */
export const projectFromScratch = (answers) => setUpProject(createProject(answers.name, answers.start), answers);
