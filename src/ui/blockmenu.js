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
import { getTask, isSummary, URGENCIES, urgencyOf, pinsOf, feeds, getFeed, bufferOf, BUFFER_CHOICES, addFeed as _unused } from '../model/model.js';
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
 * The right-click menu on a block — the list Motion puts there, mapped onto
 * this planner. "Schedule event" is a pin: the block becomes a fixed booking.
 */
export function blockMenu(b, x, y) {
  const entry = store.project.id === b.planId ? store.project : null;
  const t0 = entry ? getTask(entry, b.taskId) : null;
  const nameOf = () => t0?.name || 'this task';
  const quickStart = (project) => quickDates(project, project ? [{ label: 'Project start', day: toDay(project.start) }] : []);
  const quickDue = (project) => quickDates(project, []);

  showMenu(x, y, [
    b.pinned
      ? { icon: '⌖', label: 'Unschedule the fixed time', run: run(b, (t) => act.unpinBlock(t.id, b.pinIndex)) }
      : { icon: '⌖', label: 'Schedule event (fix it at this time)', run: run(b, (t) => act.pinBlock(t.id, { day: b.dateIso, start: b.start, minutes: b.minutes })) },
    '-',
    { icon: '⧉', label: 'Copy link', run: () => copy(taskLink(b.planId, b.taskId)) },
    { icon: '↗', label: 'Open task', run: run(b, (t) => { act.revealTask(t.id); act.selectTask(t.id); set({ rightOpen: true, rightTab: 'task' }); }) },
    { icon: '▢', label: 'View project', run: run(b, (t) => { act.revealTask(t.id); act.selectTask(t.id); set({ view: 'gantt' }); }) },
    '-',
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
 * A block, opened. Its day and hours can be changed, which pins it there — the
 * same as dragging it — and the task's own facts sit beside them.
 */
export async function blockSheet(b, { late = null } = {}) {
  const t = await withTask(b.planId, b.taskId);
  if (!t) return;
  const project = store.project;
  const info = store.schedule.tasks[t.id];
  const pins = pinsOf(t);
  const saved = await open(t.name, (close) => {
    const name = el('input', { class: 'sc-input sheet-title', type: 'text', value: t.name, 'data-autofocus': '' });
    const day = dateInput(b.dateIso);
    const from = timeInput(b.start);
    const to = timeInput(b.end);
    const urgency = el('select', { class: 'sc-select' }, ...Object.entries(URGENCIES).map(([id, u]) => el('option', { value: id, text: u.label, selected: urgencyOf(t) === id })));
    const deadline = dateInput(t.deadline || '');
    const notes = el('textarea', { class: 'sc-textarea sheet-notes', rows: 6, value: t.notes || '', placeholder: 'Notes' });
    const save = () => close({
      name: name.value, day: day.value, from: parseTime(from.value), to: parseTime(to.value),
      urgency: urgency.value, deadline: deadline.value, notes: notes.value,
    });
    const onKey = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } };
    setTimeout(() => document.querySelector('.sheet')?.addEventListener('keydown', onKey), 0);
    return [
      el('div', { class: 'sheet' },
        el('div', { class: 'sheet-head' },
          el('span', { class: 'sc-pill sheet-chip', text: b.pinned ? '⌖ Fixed time' : 'Task' }),
          el('span', { class: 'sc-faint small', text: project.name }),
          el('span', { class: 'sc-spacer' }),
          el('button', { class: 'sc-button sc-button--sm', text: 'Open task', onclick: () => { close(null); act.revealTask(t.id); act.selectTask(t.id); set({ rightOpen: true, rightTab: 'task' }); } }),
          el('button', { class: 'sc-button sc-button--sm', text: 'View project', onclick: () => { close(null); act.revealTask(t.id); act.selectTask(t.id); set({ view: 'gantt' }); } })),
        name,
        el('div', { class: 'sheet-when' }, day, from, el('span', { text: '–' }), to),
        el('div', { class: 'sc-faint small' },
          b.pinned
            ? 'This block is fixed here. Changing the day or hours moves it; the rest of the week re-lays around it.'
            : 'Placed by the calendar. Changing the day or hours fixes it there, the same as dragging it.'),
        late ? el('div', { class: 'sc-alert sc-alert--danger sheet-late', text: late }) : null,
        el('div', { class: 'sheet-grid' },
          el('label', { class: 'sc-field' }, el('span', { class: 'sc-label', text: 'Urgency' }), urgency),
          el('label', { class: 'sc-field' }, el('span', { class: 'sc-label', text: 'Deadline' }), deadline),
          el('div', { class: 'sc-field' }, el('span', { class: 'sc-label', text: 'Left to do' }),
            el('span', { class: 'sc-mono', text: `${Math.round(hoursLeft(project, info, t) * 10) / 10}h · ${info.percent}% done` })),
          el('div', { class: 'sc-field' }, el('span', { class: 'sc-label', text: 'Fixed blocks' }),
            el('span', { class: 'sc-mono', text: String(pins.length) }))),
        notes),
      foot(
        b.pinned ? button('Unpin', () => { close(null); act.unpinBlock(t.id, b.pinIndex); }) : el('span'),
        el('span', { class: 'sc-spacer' }),
        button('Cancel', () => close(null)),
        button('Save  ⌘S', save, 'sc-button--primary')),
    ];
  }, { wide: true });
  if (!saved) return;

  if (saved.name.trim() && saved.name !== t.name) act.editTask(t.id, 'name', saved.name);
  if (saved.urgency !== urgencyOf(t)) act.editTask(t.id, 'urgency', saved.urgency);
  if ((saved.deadline || null) !== (t.deadline || null)) act.editTask(t.id, 'deadline', saved.deadline);
  if (saved.notes !== (t.notes || '')) act.editTask(t.id, 'notes', saved.notes);
  // The day or the hours changed: that is a decision about when, so it pins.
  const moved = saved.day !== b.dateIso || saved.from !== b.start || saved.to !== b.end;
  if (moved && saved.day && saved.from !== null && saved.to !== null && saved.to > saved.from) {
    act.pinBlock(t.id, { day: saved.day, start: saved.from, minutes: saved.to - saved.from }, b.pinned ? b.pinIndex : null);
  } else if (moved) {
    act.hint('A block ends after it starts.');
  }
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
