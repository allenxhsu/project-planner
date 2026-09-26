// What a block on the calendar can do, and what it says when you open it.
//
// Right-click is the long list of things to do to the task behind a block —
// schedule it as a fixed event, open it, change its dates, add time, push it
// later or pull it forward, say what is blocking it, take it off the calendar,
// archive or delete it. Click opens a sheet: the block's own day and hours,
// which can be changed (and so pin it), and the task's facts beside them.
// A calendar event from a connected calendar gets a sheet of its own, read-
// only where the calendar is the source of truth, with a way to turn it into
// project work.
//
// A block can belong to a plan that is not the one open. Everything here that
// edits goes through withTask(), which opens that plan first, because an edit
// is made to the plan in the store and nowhere else.

import { el } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { getTask, isSummary, URGENCIES, urgencyOf, pinsOf, feeds, getFeed, bufferOf, BUFFER_CHOICES, addFeed as _unused, fieldsOf, getField, fieldValue } from '../model/model.js';
import { formatClock, parseTime, agendaOf, hoursLeft } from '../model/agenda.js';
import { fromDay, toDay, formatDate, today, makeCalendar } from '../model/calendar.js';
import { showMenu, open, foot, button, confirmDialog, showText } from './dialog.js';
import { datePanel, quickDates } from './datepick.js';
void _unused;

/** Make `planId` the open plan if it is not, then hand back the task. */
async function withTask(planId, taskId) {
  if (planId && planId !== store.project.id) {
    const { openPlan } = await import('../state/sync.js');
    if (!(await openPlan(planId))) return null;
  }
  return getTask(store.project, taskId);
}
const run = (b, fn) => async () => { const t = await withTask(b.planId, b.taskId); if (t) fn(t); };

/** A link that opens this plan on this task, in whatever copy of the app follows it. */
export function taskLink(planId, taskId) {
  const base = `${location.origin}${location.pathname}`;
  return `${base}#plan=${encodeURIComponent(planId)}&task=${encodeURIComponent(taskId)}`;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); act.hint('Link copied.'); }
  catch { showText('Copy this link', text); }
}

/** How much work the calendar expects of a task now: its own figure when it states one. */
function expectedHours(project, t) {
  const info = store.schedule.tasks[t.id];
  if (Number.isFinite(+t.work) && t.work !== null && t.work !== undefined) return +t.work;
  if (!info) return 0;
  // The same assumption the calendar places it under, so adding an hour adds an hour.
  const load = (project.agenda?.assumedLoad ?? 50) / 100;
  return Math.round((info.work > 0 ? info.work : info.duration * (project.calendar?.hoursPerDay || 8)) * load * 100) / 100;
}

/** "Set blockers": which tasks this one waits for, as tick boxes. */
async function blockersDialog(t) {
  const { project } = store;
  const current = new Set(t.predecessors.map((l) => l.id));
  const candidates = project.tasks.filter((x, i) => x.id !== t.id && !isSummary(project, i));
  const picked = await open(`What is blocking “${t.name}”?`, (close) => {
    const boxes = new Map();
    const list = el('div', { class: 'blocker-list' }, ...candidates.map((x) => {
      const box = el('input', { class: 'sc-check', type: 'checkbox', checked: current.has(x.id) });
      boxes.set(x.id, box);
      return el('label', { class: 'row check-row blocker-row' }, box, el('span', { text: x.name }),
        el('span', { class: 'sc-faint small', text: store.schedule.tasks[x.id] ? `${store.schedule.tasks[x.id].percent}%` : '' }));
    }));
    return [
      el('p', { class: 'sc-muted small', text: 'A blocker is a predecessor: this task starts when each ticked one has finished, and its blocks wait for it.' }),
      list,
      foot(button('Cancel', () => close(null)), button('Save', () => close(new Set([...boxes].filter(([, b]) => b.checked).map(([id]) => id))), 'sc-button--primary')),
    ];
  }, { wide: true });
  if (!picked) return;
  for (const id of picked) if (!current.has(id)) act.linkTasks(id, t.id, 'FS', 0);
  for (const id of current) if (!picked.has(id)) act.unlinkTasks(id, t.id);
}

/**
 * "Start task now": how long, then a block from this minute. The block it was
 * started from gives its time back; whatever was laid here moves.
 */
export async function startNowDialog(t, b = null) {
  const info = store.schedule.tasks[t.id];
  const left = info ? Math.round(hoursLeft(store.project, info, t) * 60) : 60;
  const choices = [[15, '15 min'], [30, '30 min'], [45, '45 min'], [60, '1 hour'], [90, '1h 30m'], [120, '2 hours'], [180, '3 hours'], [240, '4 hours']];
  const suggested = b?.minutes || (left > 0 ? Math.min(60, Math.max(15, left)) : 60);
  const minutes = await open('Start task now', (close) => {
    const pick = el('select', { class: 'sc-select', 'data-autofocus': '' },
      ...choices.map(([m, label]) => el('option', { value: m, text: label, selected: m === (choices.find(([c]) => c >= suggested)?.[0] ?? 60) })));
    return [
      el('div', { class: 'sc-faint small start-now-task', text: `☐ ${t.name}` }),
      el('label', { class: 'sc-field' }, el('span', { text: 'How long are you going to work on this task now?' }), pick),
      el('p', { class: 'sc-faint small', text: `${left ? `${hoursText(left)} left on it. ` : ''}Anything laid in that time moves somewhere else.` }),
      foot(el('span', { class: 'sc-spacer' }), button('Cancel', () => close(null)), button('Start', () => close(+pick.value), 'sc-button--primary')),
    ];
  });
  if (!minutes) return;
  if (act.startTaskNow(t.id, minutes, { pinIndex: b?.pinned ? b.pinIndex : null })) act.hint(`Started “${t.name}” — ${hoursText(minutes)} from now.`);
}
const hoursText = (min) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}`);

/**
 * The right-click menu on a block — the list Motion puts there, mapped onto
 * this planner. "Schedule event" is a pin: the block becomes a fixed booking.
 */
export function blockMenu(b, x, y) {
  const entry = store.project.id === b.planId ? store.project : null;
  const t0 = entry ? getTask(entry, b.taskId) : null;
  const nameOf = () => t0?.name || 'this task';
  const quickStart = (project) => quickDates(project, project ? [{ label: 'Project start', day: toDay(project.start) }] : []);
  const quickDue = (project) => quickDates(project, []);

  const done = t0 ? (store.schedule.tasks[t0.id]?.percent ?? 0) === 100 : false;
  showMenu(x, y, [
    done
      ? { icon: '↺', label: 'Mark not complete', run: run(b, (t) => act.setPercent(t.id, 0)) }
      : { icon: '✓', label: 'Complete task', run: run(b, (t) => act.setPercent(t.id, 100)) },
    '-',
    b.pinned
      ? { icon: '⌖', label: 'Unschedule the fixed time', run: run(b, (t) => act.unpinBlock(t.id, b.pinIndex)) }
      : { icon: '⌖', label: 'Schedule event (fix it at this time)', run: run(b, (t) => act.pinBlock(t.id, { day: b.dateIso, start: b.start, minutes: b.minutes })) },
    '-',
    { icon: '⧉', label: 'Copy link', run: () => copy(taskLink(b.planId, b.taskId)) },
    { icon: '↗', label: 'Open task', run: run(b, (t) => { act.revealTask(t.id); act.selectTask(t.id); set({ rightOpen: true, rightTab: 'task' }); }) },
    { icon: '▢', label: 'View project', run: run(b, (t) => { act.revealTask(t.id); act.selectTask(t.id); set({ view: 'gantt' }); }) },
    '-',
    { icon: '▶', label: 'Start task now…', disabled: done, run: run(b, (t) => { void startNowDialog(t, b); }) },
    { icon: '⇥', label: 'Change start date', panel: (close) => datePanel({
      value: t0?.constraint?.date || fromDay(b.day), title: 'Start date', quick: quickStart(entry),
      onPick: (iso) => { close(); void run(b, (t) => act.editTask(t.id, 'start', iso))(); },
    }) },
    { icon: '⇤', label: 'Change deadline', panel: (close) => datePanel({
      value: t0?.deadline || null, title: 'No deadline', quick: quickDue(entry),
      onPick: (iso) => { close(); void run(b, (t) => act.editTask(t.id, 'deadline', iso))(); },
    }) },
    { icon: '◷', label: 'Add time to task', submenu: [[15, '15 min'], [30, '30 min'], [45, '45 min'], [60, '1 hour'], [90, '1h 30m'], [120, '2 hours']].map(([m, label]) => ({
      label, run: run(b, (t) => act.editTask(t.id, 'work', String(Math.round((expectedHours(store.project, t) + m / 60) * 100) / 100))),
    })) },
    { icon: '☾', label: 'Do later', run: run(b, (t) => {
      // Later is tomorrow at the soonest: the task is kept off today, not
      // lowered in a ranking a deadline would override anyway.
      const cal = makeCalendar(store.project.calendar);
      act.editTask(t.id, 'start', fromDay(cal.next(toDay(today()) + 1)));
      if (urgencyOf(t) === 'now') act.editTask(t.id, 'urgency', 'normal');
    }) },
    { icon: '!', label: 'Do ASAP', run: run(b, (t) => act.editTask(t.id, 'urgency', 'now')) },
    '-',
    { icon: '⊘', label: 'Set blockers…', run: run(b, (t) => { void blockersDialog(t); }) },
    '-',
    { icon: '⊠', label: 'Unschedule (take off the calendar)', run: run(b, (t) => act.editTask(t.id, 'calendarShow', false)) },
    '-',
    { icon: '▣', label: t0?.archived ? 'Unarchive' : 'Archive', run: run(b, (t) => act.editTask(t.id, 'archived', !t.archived)) },
    { icon: '🗑', label: 'Delete task', danger: true, run: run(b, async (t) => {
      if (!(await confirmDialog('Delete this task?', `“${t.name}” and its links go. Undo brings it back.`))) return;
      act.selectTask(t.id);
      act.deleteSelection();
    }) },
  ]);
  void nameOf;
}

// ------------------------------------------------------------------ sheets

const timeInput = (min) => el('input', { class: 'sc-input sheet-time', type: 'time', step: 900, value: `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}` });
const dateInput = (iso) => el('input', { class: 'sc-input sheet-date', type: 'date', value: iso });

/**
 * An input for one custom field, of the kind the field is: a box for words,
 * numbers and links, a date, a choice or a set of ticks for options and
 * people. `get` reads it back as the value the field keeps.
 */
function fieldInput(project, field, value) {
  const people = project.resources.map((r) => ({ value: r.id, label: r.name }));
  const choices = field.type === 'select' || field.type === 'multi' ? field.options.map((o) => ({ value: o, label: o })) : people;
  if (field.type === 'select' || field.type === 'person') {
    const node = el('select', { class: 'sc-select' }, el('option', { value: '', text: '—' }),
      ...choices.map((c) => el('option', { value: c.value, text: c.label, selected: value === c.value })));
    return { node, get: () => node.value || null };
  }
  if (field.type === 'multi' || field.type === 'people') {
    const on = new Set(Array.isArray(value) ? value : []);
    const boxes = choices.map((c) => el('input', { type: 'checkbox', class: 'sc-check', value: c.value, checked: on.has(c.value) }));
    const node = el('span', { class: 'fact-ticks' }, ...(choices.length ? choices.map((c, k) => el('label', { class: 'fact-tick' }, boxes[k], el('span', { text: c.label })))
      : [el('span', { class: 'sc-faint', text: field.type === 'people' ? 'Nobody on the plan' : 'No options' })]));
    return { node, get: () => boxes.filter((b) => b.checked).map((b) => b.value) };
  }
  if (field.type === 'date') {
    const node = dateInput(value || '');
    return { node, get: () => node.value || null };
  }
  const node = el('input', { class: 'sc-input', type: field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : 'text', value: value ?? '', placeholder: field.type === 'url' ? 'https://' : '' });
  const wrap = field.type === 'url' && value
    ? el('span', { class: 'fact-url' }, node, el('a', { href: value, target: '_blank', rel: 'noopener', text: '↗', title: 'Open the link' }))
    : node;
  return { node: wrap, get: () => node.value };
}

/**
 * A task, opened — from a block on the calendar, or from anywhere else.
 *
 * On the left, what the task is: its name, and when it is a calendar block,
 * that block's day and hours, which can be changed and so pin it. On the right
 * the facts a person checks before deciding anything: done or not, which
 * project and phase, who, urgency, how long, when it may start, when it is
 * due, what it is waiting on and what is waiting on it. An archived task says
 * so across the top and offers to restore or delete it.
 */
export async function taskSheet({ planId = store.project.id, taskId, block: b = null, late = null }) {
  const t = await withTask(planId, taskId);
  if (!t) return;
  const project = store.project;
  const info = store.schedule.tasks[t.id];
  const nameOfTask = (id) => project.tasks.find((x) => x.id === id)?.name || '(gone)';
  const blockedBy = t.predecessors.map((l) => nameOfTask(l.id));
  const blocking = project.tasks.filter((x) => x.predecessors.some((l) => l.id === t.id)).map((x) => x.name);
  const who = t.assignments.map((a) => project.resources.find((r) => r.id === a.resourceId)?.name).filter(Boolean);
  const pins = pinsOf(t);

  const saved = await open(t.name, (close) => {
    const name = el('input', { class: 'sc-input sheet-title', type: 'text', value: t.name, 'data-autofocus': '' });
    const done = el('input', { class: 'sc-check', type: 'checkbox', checked: info?.percent === 100 });
    const day = b ? dateInput(b.dateIso) : null;
    const from = b ? timeInput(b.start) : null;
    const to = b ? timeInput(b.end) : null;
    const urgency = el('select', { class: 'sc-select' }, ...Object.entries(URGENCIES).map(([id, u]) => el('option', { value: id, text: u.label, selected: urgencyOf(t) === id })));
    const start = dateInput(t.constraint?.type !== 'ASAP' ? (t.constraint?.date || '') : '');
    const deadline = dateInput(t.deadline || '');
    const notes = el('textarea', { class: 'sc-textarea sheet-notes', rows: 8, value: t.notes || '', placeholder: 'Notes' });
    const custom = fieldsOf(project).map((f) => ({ field: f, ...fieldInput(project, f, t.fields?.[f.id] ?? null) }));
    const save = () => close({
      custom: custom.map((c) => ({ id: c.field.id, value: c.get() })),
      name: name.value, done: done.checked, urgency: urgency.value, start: start.value, deadline: deadline.value, notes: notes.value,
      ...(b ? { day: day.value, from: parseTime(from.value), to: parseTime(to.value) } : {}),
    });
    setTimeout(() => document.querySelector('.task-sheet')?.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    }), 0);
    const more = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      showMenu(r.left - 180, r.bottom + 4, [
        { icon: '⧉', label: 'Copy link', run: () => copy(taskLink(project.id, t.id)) },
        { icon: '▶', label: 'Start task now…', disabled: info?.percent === 100 || t.milestone, run: () => { close(null); void startNowDialog(t, b); } },
        { icon: '⎘', label: 'Duplicate task', run: () => { close(null); act.duplicateTask(t.id); } },
        { icon: '▢', label: 'Create project from task', run: () => { close(null); void projectFromTask(t); } },
        '-',
        { icon: '▣', label: t.archived ? 'Restore from the archive' : 'Archive', run: () => { close(null); act.editTask(t.id, 'archived', !t.archived); } },
        { icon: '🗑', label: 'Delete task', danger: true, run: async () => {
          close(null);
          if (!(await confirmDialog('Delete this task?', `“${t.name}” and its links go. Undo brings it back.`))) return;
          act.selectTask(t.id); act.deleteSelection();
        } },
      ]);
    };
    const fact = (label, value) => el('div', { class: 'fact' }, el('span', { class: 'fact-label', text: label }), value);
    const list = (names) => el('span', { class: names.length ? '' : 'sc-faint', text: names.length ? names.join(', ') : 'None' });

    return [
      t.archived ? el('div', { class: 'sheet-archived' },
        el('span', { text: 'This task is archived.' }),
        el('button', { class: 'sc-button sc-button--sm', text: 'Restore task', onclick: () => { close(null); act.editTask(t.id, 'archived', false); } }),
        el('button', { class: 'sc-button sc-button--sm sc-button--danger', text: 'Delete permanently', onclick: async () => {
          close(null);
          if (!(await confirmDialog('Delete this task for good?', `“${t.name}” goes from the plan. Undo still brings it back while this window is open.`))) return;
          act.selectTask(t.id); act.deleteSelection();
        } })) : null,
      el('div', { class: 'task-sheet' },
        el('div', { class: 'task-sheet-main' },
          el('div', { class: 'sheet-head' },
            el('span', { class: 'sc-pill sheet-chip', text: b?.pinned ? '⌖ Fixed time' : 'Task' }),
            el('span', { class: 'sc-spacer' }),
            el('button', { class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', text: '⋯', title: 'More', onclick: more })),
          name,
          b ? el('div', { class: 'sheet-when' }, day, from, el('span', { text: '–' }), to) : null,
          b ? el('div', { class: 'sc-faint small', text: b.pinned
            ? 'This block is fixed here. Changing the day or hours moves it; the rest of the week re-lays around it.'
            : 'Placed by the calendar. Changing the day or hours fixes it there, the same as dragging it.' }) : null,
          late ? el('div', { class: 'sc-alert sc-alert--danger sheet-late', text: late }) : null,
          notes),
        el('aside', { class: 'task-sheet-facts' },
          el('label', { class: `fact-done${info?.percent === 100 ? ' is-done' : ''}` }, done, el('span', { text: 'Task complete' }),
            info?.percent === 100 && t.doneAt ? el('span', { class: 'sc-faint small fact-done-at', text: `${formatDate(t.doneAt.slice(0, 10), 'day')}${t.doneAt.length > 10 ? `, ${formatClock(parseTime(t.doneAt.slice(11)))}` : ''}` }) : null),
          fact('Project', el('span', {}, project.name, el('button', { class: 'sc-button sc-button--ghost sc-button--sm', text: 'Open', onclick: () => { close(null); act.revealTask(t.id); act.selectTask(t.id); set({ view: 'gantt' }); } }))),
          fact('Assignee', list(who)),
          fact('Urgency', urgency),
          fact('Duration', el('span', { class: 'sc-mono', text: `${info?.duration ?? 0}d open · ${Math.round(hoursLeft(project, info, t) * 10) / 10}h left · ${info?.percent ?? 0}%` })),
          fact('Start date', start),
          fact('Deadline', deadline),
          ...custom.map((c) => fact(c.field.name, c.node)),
          fact('On the calendar', el('span', { text: agendaOf(project, t).show ? `Yes${pins.length ? `, ${pins.length} fixed` : ''}` : 'No' })),
          fact('Blocked by', list(blockedBy)),
          fact('Blocking', list(blocking)),
          el('button', { class: 'sc-button sc-button--ghost sc-button--sm', text: 'Set blockers…', onclick: () => { close(null); void blockersDialog(t); } }))),
      foot(
        b?.pinned ? button('Unpin', () => { close(null); act.unpinBlock(t.id, b.pinIndex); }) : el('span'),
        el('span', { class: 'sc-spacer' }),
        button('Cancel', () => close(null)),
        button('Save  ⌘S', save, 'sc-button--primary')),
    ];
  }, { wide: true });
  if (!saved) return;

  if (saved.name.trim() && saved.name !== t.name) act.editTask(t.id, 'name', saved.name);
  if (saved.done !== (info?.percent === 100)) act.setPercent(t.id, saved.done ? 100 : 0);
  if (saved.urgency !== urgencyOf(t)) act.editTask(t.id, 'urgency', saved.urgency);
  const hadStart = t.constraint?.type !== 'ASAP' ? (t.constraint?.date || '') : '';
  if (saved.start !== hadStart) act.editTask(t.id, 'start', saved.start);
  if ((saved.deadline || null) !== (t.deadline || null)) act.editTask(t.id, 'deadline', saved.deadline);
  if (saved.notes !== (t.notes || '')) act.editTask(t.id, 'notes', saved.notes);
  for (const c of saved.custom) {
    const was = t.fields?.[c.id] ?? null;
    const field = getField(store.project, c.id);
    const now = field ? fieldValue(store.project, field, c.value) : null;
    if (JSON.stringify(was) !== JSON.stringify(now)) act.setTaskFieldValue(t.id, c.id, now);
  }
  if (b) {
    // The day or the hours changed: that is a decision about when, so it pins.
    const moved = saved.day !== b.dateIso || saved.from !== b.start || saved.to !== b.end;
    if (moved && saved.day && saved.from !== null && saved.to !== null && saved.to > saved.from) {
      act.pinBlock(t.id, { day: saved.day, start: saved.from, minutes: saved.to - saved.from }, b.pinned ? b.pinIndex : null);
    } else if (moved) act.hint('A block ends after it starts.');
  }
}

/** A block, opened: the task's sheet with that block's day and hours in it. */
export const blockSheet = (b, { late = null } = {}) => taskSheet({ planId: b.planId, taskId: b.taskId, block: b, late });

/**
 * A task grown into a project: a new plan named after it, holding it, and the
 * original archived so the work is not counted twice.
 */
async function projectFromTask(t) {
  const yes = await confirmDialog(`Make “${t.name}” a project?`,
    'A new plan is made with this task in it, in the same workspace. The task here is archived rather than deleted, so nothing is lost.', 'Make a project');
  if (!yes) return;
  const { createProject } = await import('../model/model.js');
  const { loadProject } = await import('../state/store.js');
  const from = store.project;
  act.editTask(t.id, 'archived', true);
  const p = createProject(t.name);
  p.workspaceId = from.workspaceId || null;
  p.resources = from.resources.filter((r) => t.assignments.some((a) => a.resourceId === r.id)).map((r) => ({ ...r }));
  const copyOf = structuredClone(t);
  delete copyOf.id;
  const { insertTask } = await import('../model/model.js');
  const made = insertTask(p, 0, { ...copyOf, level: 1, predecessors: [], archived: false });
  made.calendar = { ...(t.calendar || {}), pins: [] };
  loadProject(p, null);
  set({ view: 'gantt' });
  act.hint(`“${t.name}” is a project of its own now; the task in ${from.name} is archived.`);
}

/**
 * An event from a connected calendar, opened. The calendar it came from is
 * where it is edited, so its time is shown and not changed here; what the
 * planner owns about it — travel time, and whether it is project work — is.
 */
export function meetingSheet(m) {
  const plan = m.planId === store.project.id ? store.project : null;
  const feed = plan ? getFeed(plan, m.feedId) : null;
  return open(m.title, (close) => {
    const travel = feed ? el('select', { class: 'sc-select', onchange: (e) => act.editCalendar(feed.id, 'bufferMinutes', +e.target.value) },
      ...BUFFER_CHOICES.map((n) => el('option', { value: String(n), text: n === 0 ? 'No travel time' : `${n} min each way`, selected: bufferOf(feed) === n }))) : null;
    const addToProject = () => {
      close(null);
      // Project work that happens in the meeting: a task of the meeting's
      // length, fixed at its hour, so the time counts toward the project and
      // toward the person's day.
      const minutes = Math.max(15, m.end - m.start);
      const name = m.title;
      const created = act.newTaskFromEvent({ name, day: fromDay(m.day), start: m.start, minutes, notes: [m.location, m.description].filter(Boolean).join('\n\n') });
      if (created) act.hint(`“${name}” is now a task in ${store.project.name}, fixed at ${formatClock(m.start)}.`);
    };
    return [
      el('div', { class: 'sheet' },
        el('div', { class: 'sheet-head' },
          el('span', { class: 'sc-pill sheet-chip', text: 'Event' }),
          el('span', { class: 'sc-faint small', text: m.feedName || 'Connected calendar' }),
          el('span', { class: 'sc-spacer' }),
          el('button', { class: 'sc-button sc-button--sm', text: '+ Add to project', title: `Make it a task in ${store.project.name}`, onclick: addToProject })),
        el('div', { class: 'sheet-title sheet-title-ro', text: m.title }),
        el('div', { class: 'sheet-when sc-mono' }, m.allDay
          ? `${formatDate(fromDay(m.day), 'long')} · all day`
          : `${formatDate(fromDay(m.day), 'long')} · ${formatClock(m.start)} – ${formatClock(m.end)}`),
        el('div', { class: 'sheet-grid' },
          el('div', { class: 'sc-field' }, el('span', { class: 'sc-label', text: 'Location' }), el('span', { text: m.location || '—' })),
          el('div', { class: 'sc-field' }, el('span', { class: 'sc-label', text: 'Shown as' }), el('span', { text: 'Busy — work is laid around it' })),
          el('label', { class: 'sc-field' }, el('span', { class: 'sc-label', text: 'Travel time' }),
            travel || el('span', { class: 'sc-faint', text: 'Set on the calendar’s own plan' }),
            el('span', { class: 'sc-faint field-hint', text: m.location ? 'Booked either side of every event with a location on this calendar.' : 'Only events with a location get travel time.' }))),
        m.description ? el('div', { class: 'sheet-desc', text: m.description }) : null,
        el('div', { class: 'sc-faint small', text: 'Change the time or the guests in the calendar it came from; this planner reads it and plans around it.' })),
      foot(button('Close', () => close(null), 'sc-button--primary')),
    ];
  }, { wide: true });
}
