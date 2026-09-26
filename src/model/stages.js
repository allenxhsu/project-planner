// A project and its stages, the way Motion runs them.
//
// A project has its own description, status, deadline, priority, labels, an
// owner and a history. Its stages (`phases` in the file) run one after
// another: each starts the day after the one before it is due and ends on its
// own deadline, and one of them is where the project is now. A stage can be
// completed — its tasks done — or cancelled — its tasks archived. When every
// task of the current stage is finished the project moves on by itself, as
// Motion's auto-advance does. A stage whose tasks are laid past its deadline
// has missed it, and says how: which tasks, and when the stage would really
// be done, so the deadline can be extended or the tasks brought in.

import { phases, getPhase, phaseOf, isSummary, logActivity, setTaskField, URGENCIES } from './model.js';
import { toDay, fromDay, isoValid, makeCalendar } from './calendar.js';

export const PROJECT_STATUSES = ['Backlog', 'Todo', 'In Progress', 'Blocked', 'Completed', 'Cancelled'];
/** The colours a stage can be drawn in, in the order new stages take them. */
export const STAGE_COLOURS = ['#6b7a8c', '#3fb67a', '#d9a52b', '#3d8bd9', '#8c6ad9', '#d9557a', '#e0703a', '#2bb3b3'];

const stamp = () => {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
};
/** The project's own history: stage changes, dates moved, comments. */
export function logProject(p, entry) {
  const list = Array.isArray(p.activity) ? p.activity : [];
  list.push({ at: stamp(), ...entry });
  p.activity = list.slice(-300);
}

// ---------------------------------------------------------------- project fields

export function setProjectField(p, field, value) {
  switch (field) {
    case 'name': { const n = String(value || '').trim(); if (!n) throw new Error('A project needs a name.'); if (n !== p.name) logProject(p, { kind: 'change', field: 'name', from: p.name, to: n }); p.name = n; break; }
    case 'description': p.description = String(value || ''); break;
    case 'status': {
      if (!PROJECT_STATUSES.includes(value)) throw new Error('Not a project status.');
      const was = p.status || 'Todo';
      p.status = value;
      if (was !== value) logProject(p, { kind: 'change', field: 'status', from: was, to: value });
      // A finished or cancelled project is put away, as Motion files it under Completed.
      if (value === 'Completed' || value === 'Cancelled') { p.archived = true; p.archivedAt = p.archivedAt || stamp(); }
      else if (p.archived && (was === 'Completed' || was === 'Cancelled')) { p.archived = false; p.archivedAt = null; }
      break;
    }
    case 'start': if (!isoValid(value)) throw new Error('A start is a date.'); if (value !== p.start) logProject(p, { kind: 'change', field: 'start date', from: p.start, to: value }); p.start = value; break;
    case 'deadline': if (value && !isoValid(value)) throw new Error('A deadline is a date.'); if ((value || null) !== (p.deadline || null)) logProject(p, { kind: 'change', field: 'deadline', from: p.deadline || 'none', to: value || 'none' }); p.deadline = value || null; break;
    case 'urgency': if (!URGENCIES[value]) throw new Error('Not a priority.'); p.urgency = value; break;
    case 'managerId': p.managerId = value && p.resources.some((r) => r.id === value) ? value : null; break;
    case 'labels': { const l = [...new Set((Array.isArray(value) ? value : String(value || '').split(',')).map((x) => String(x).trim()).filter(Boolean))]; if (l.length) p.labels = l; else delete p.labels; break; }
    case 'colour': p.colour = value === null || value === '' ? null : ((Math.round(+value) % 360) + 360) % 360; break;
    case 'autoAdvance': p.autoAdvance = !!value; break;
    default: throw new Error(`“${field}” is not part of a project.`);
  }
}

export function commentOnProject(p, text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('A comment needs some words.');
  logProject(p, { kind: 'comment', text: t.slice(0, 4000) });
}

// ---------------------------------------------------------------- stages

/** The leaf tasks of a stage, archived ones left out unless asked for. */
export function stageTasks(p, stageId, { archived = false } = {}) {
  return p.tasks.filter((t, i) => !isSummary(p, i) && phaseOf(p, t.id) === stageId && (archived || !t.archived));
}

/** 'open', 'done' or 'cancelled'. */
export const stageStatus = (ph) => (ph?.status === 'done' || ph?.status === 'cancelled' ? ph.status : 'open');

/**
 * When a stage runs: from the day after the stage before it is due (the
 * project's start for the first) to its own deadline.
 */
export function stageRange(p, stageId) {
  const list = phases(p);
  const i = list.findIndex((ph) => ph.id === stageId);
  if (i < 0) return { start: null, end: null };
  let start = p.start;
  for (let k = i - 1; k >= 0; k--) {
    if (list[k].deadline) { start = fromDay(toDay(list[k].deadline) + 1); break; }
  }
  return { start, end: list[i].deadline || null };
}

export const stageColour = (p, ph) => ph.colour || STAGE_COLOURS[Math.max(0, phases(p).indexOf(ph)) % STAGE_COLOURS.length];

/**
 * How a stage stands against its deadline.
 *
 * `finish` is when its open tasks will be done — the last day the calendar
 * has work for them (the layout's blocks, `byTask`), or their scheduled finish
 * when they are not on the calendar. A stage past its deadline, or with work
 * laid past it, has missed it; `late` names the tasks that do.
 */
export function stageHealth(p, schedule, stageId, { byTask = null, today } = {}) {
  const ph = getPhase(p, stageId);
  const status = stageStatus(ph);
  const tasks = stageTasks(p, stageId).filter((t) => (schedule.tasks[t.id]?.percent ?? 0) < 100);
  const deadline = ph?.deadline ? toDay(ph.deadline) : null;
  let finish = null;
  const late = [];
  for (const t of tasks) {
    const blocks = byTask?.get?.(t.id) || [];
    const end = blocks.length ? Math.max(...blocks.map((b) => b.day)) : (schedule.tasks[t.id]?.finish ?? null);
    if (end !== null) finish = Math.max(finish ?? end, end);
    if (deadline !== null && end !== null && end > deadline) late.push({ taskId: t.id, name: t.name, end, daysLate: end - deadline });
  }
  const past = deadline !== null && today > deadline && tasks.length > 0;
  return {
    status, open: tasks.length, done: stageTasks(p, stageId).length - tasks.length,
    finish: finish === null ? null : fromDay(finish),
    missed: status === 'open' && (past || late.length > 0),
    late,
  };
}

/** Move a stage's deadline, and the ones after it by as many working days, so their lengths hold. */
export function extendStage(p, stageId, iso, { shiftLater = true } = {}) {
  if (!isoValid(iso)) throw new Error('A deadline is a date.');
  const list = phases(p);
  const i = list.findIndex((ph) => ph.id === stageId);
  if (i < 0) throw new Error('No such stage.');
  const ph = list[i];
  const cal = makeCalendar(p.calendar);
  const was = ph.deadline;
  ph.deadline = iso;
  if (shiftLater && was) {
    const by = cal.distance(toDay(was), toDay(iso));
    if (by > 0) for (const later of list.slice(i + 1)) if (later.deadline && stageStatus(later) === 'open') later.deadline = fromDay(cal.add(toDay(later.deadline), by));
  }
  logProject(p, { kind: 'change', field: `${ph.name} deadline`, from: was || 'none', to: iso });
}

/**
 * Bring a task inside its stage: its deadline becomes the stage's, hard, and
 * it goes first — the calendar then places it before anything with a later
 * or softer claim.
 */
export function fixTaskToStage(p, taskId, stageId) {
  const ph = getPhase(p, stageId);
  if (!ph?.deadline) throw new Error('The stage has no deadline to meet.');
  setTaskField(p, taskId, 'deadline', ph.deadline);
  setTaskField(p, taskId, 'hardDeadline', true);
  setTaskField(p, taskId, 'urgency', 'high');
}

/** The next stage still to run after this one, or null. */
function nextOpen(p, stageId) {
  const list = phases(p);
  const i = list.findIndex((ph) => ph.id === stageId);
  return list.slice(i + 1).find((ph) => stageStatus(ph) === 'open') || null;
}

function moveTo(p, next, who = 'You') {
  const from = getPhase(p, p.currentPhaseId);
  p.currentPhaseId = next ? next.id : null;
  logProject(p, { kind: 'stage', from: from?.name || 'none', to: next?.name || 'none', by: who });
}

/** Make a stage the one the project is in. */
export function setCurrentStage(p, stageId) {
  const ph = stageId ? getPhase(p, stageId) : null;
  if (stageId && !ph) throw new Error('No such stage.');
  if ((p.currentPhaseId || null) === (stageId || null)) return;
  moveTo(p, ph);
}

/** Complete a stage: every open task in it done, and the project on to the next. */
export function completeStage(p, stageId) {
  const ph = getPhase(p, stageId);
  if (!ph) throw new Error('No such stage.');
  for (const t of stageTasks(p, stageId)) if ((t.percent ?? 0) < 100) setTaskField(p, t.id, 'percent', 100);
  ph.status = 'done';
  logProject(p, { kind: 'change', field: `${ph.name}`, from: 'open', to: 'completed' });
  if (p.currentPhaseId === stageId || !p.currentPhaseId) moveTo(p, nextOpen(p, stageId));
}

/** Cancel a stage: its unfinished tasks archived, and the project on past it. */
export function cancelStage(p, stageId) {
  const ph = getPhase(p, stageId);
  if (!ph) throw new Error('No such stage.');
  for (const t of stageTasks(p, stageId)) if ((t.percent ?? 0) < 100) setTaskField(p, t.id, 'archived', true);
  ph.status = 'cancelled';
  logProject(p, { kind: 'change', field: `${ph.name}`, from: 'open', to: 'cancelled' });
  if (p.currentPhaseId === stageId) moveTo(p, nextOpen(p, stageId));
}

/** Open a completed or cancelled stage again (its tasks stay as they are). */
export function reopenStage(p, stageId) {
  const ph = getPhase(p, stageId);
  if (!ph) throw new Error('No such stage.');
  if (stageStatus(ph) === 'cancelled') for (const t of stageTasks(p, stageId, { archived: true })) if (t.archived && (t.percent ?? 0) < 100) setTaskField(p, t.id, 'archived', false);
  ph.status = 'open';
  logProject(p, { kind: 'change', field: `${ph.name}`, from: 'closed', to: 'open' });
}

/**
 * Auto-advance: when every task of the current stage is done, the project
 * moves to the next open stage — Motion's "Motion changed stage from … to …".
 * Called after edits; does nothing when the plan has switched it off.
 */
export function autoAdvance(p) {
  if (p.autoAdvance === false || !p.currentPhaseId) return false;
  const ph = getPhase(p, p.currentPhaseId);
  if (!ph) return false;
  const tasks = stageTasks(p, ph.id);
  if (!tasks.length || tasks.some((t) => (t.percent ?? 0) < 100)) return false;
  ph.status = 'done';
  moveTo(p, nextOpen(p, ph.id), 'Planner');
  return true;
}

/**
 * Add a stage where Motion's "Create new stage" puts it: after a stage (or
 * first), lasting some days. It starts the day after the stage before it
 * ends; every stage after it, and the project's deadline, move out by as
 * many days — so what was planned after it keeps its length.
 * @returns {{ stage: object, deadlineFrom: string|null, deadlineTo: string|null }}
 */
export function insertStage(p, { name, afterId = null, days = 7, colour = null }) {
  const list = phases(p);
  const clean = String(name || '').trim() || 'New stage';
  const n = Math.max(1, Math.round(+days || 1));
  const at = afterId ? list.findIndex((ph) => ph.id === afterId) + 1 : 0;
  const before = at > 0 ? list[at - 1] : null;
  const startDay = before?.deadline ? toDay(before.deadline) + 1 : toDay(p.start);
  const ph = { id: `ph_${Math.random().toString(36).slice(2, 12)}`, name: clean, deadline: fromDay(startDay + n - 1), ...(colour ? { colour } : {}) };
  for (const later of list.slice(at)) if (later.deadline) later.deadline = fromDay(toDay(later.deadline) + n);
  list.splice(at, 0, ph);
  p.phases = list;
  const deadlineFrom = p.deadline || null;
  if (p.deadline) p.deadline = fromDay(toDay(p.deadline) + n);
  logProject(p, { kind: 'change', field: 'stages', from: '', to: `added ${clean}` });
  return { stage: ph, deadlineFrom, deadlineTo: p.deadline || null };
}
