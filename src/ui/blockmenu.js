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
import { getTask, isSummary, URGENCIES, urgencyOf, pinsOf, feeds, getFeed, bufferOf, BUFFER_CHOICES, addFeed as _unused, fieldsOf, getField, fieldValue, EVENT_COLOURS, EVENT_REPEATS, TRAVEL_CHOICES } from '../model/model.js';
import { formatClock, parseTime, agendaOf, hoursLeft, expectedHours as agendaExpected } from '../model/agenda.js';
import { fromDay, toDay, formatDate, today, makeCalendar } from '../model/calendar.js';
import { showMenu, open, foot, button, confirmDialog, showText, promptText } from './dialog.js';
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

/** How much work the calendar expects of a task now: the planner's own figure. */
function expectedHours(project, t) {
  const info = store.schedule.tasks[t.id];
  return info ? Math.round(agendaExpected(project, info, t) * 100) / 100 : 0;
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
/**
 * "Stop task now": how long was worked — the time since it started, to
 * change if the start was late — and how much more it needs, which starts as
 * what was left less what was just done. Nothing more means finished.
 */
export async function stopNowDialog({ planId = store.project.id, taskId }) {
  const t = await withTask(planId, taskId);
  if (!t) return;
  const pin = pinsOf(t).find((x) => x.live);
  if (!pin) { act.hint(`“${t.name}” is not running.`); return; }
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const todayIso = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  const elapsed = pin.day === todayIso ? Math.max(1, d.getHours() * 60 + d.getMinutes() - pin.start) : pin.minutes;
  const info = store.schedule.tasks[t.id];
  const leftBefore = info ? Math.round(hoursLeft(store.project, info, t) * 60) : 0;
  const options = (list, pick) => [...new Set(list)].sort((a, b) => a - b).map((m) => el('option', { value: m, text: m === 0 ? 'Nothing — it is done' : hoursText(m), selected: m === pick }));
  const answer = await open('Stop task now', (close) => {
    const worked = el('select', { class: 'sc-select', 'data-autofocus': '' }, ...options([elapsed, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240].filter((m) => m <= Math.max(elapsed, 240)), elapsed));
    let touched = false;
    const moreFor = (w) => Math.max(0, leftBefore - w);
    const more = el('select', { class: 'sc-select', onchange: () => { touched = true; } });
    const fill = () => {
      const pick = touched ? +more.value : moreFor(+worked.value);
      more.replaceChildren(...options([0, pick, 15, 30, 45, 60, 90, 120, 180, 240, 360, 480], pick));
    };
    worked.addEventListener('change', fill);
    fill();
    return [
      el('div', { class: 'sc-faint small start-now-task', text: `▶ ${t.name} · since ${formatClock(pin.start)}` }),
      el('label', { class: 'sc-field' }, el('span', { text: 'How long did you work on this task just now?' }), worked),
      el('label', { class: 'sc-field' }, el('span', { text: 'How much more time does it need to be complete?' }), more),
      foot(el('span', { class: 'sc-spacer' }), button('Cancel', () => close(null)), button('Stop', () => close({ worked: +worked.value, more: +more.value }), 'sc-button--primary')),
    ];
  });
  if (!answer) return;
  if (act.stopTask(t.id, answer)) {
    act.hint(answer.more > 0
      ? `Logged ${hoursText(answer.worked)} on “${t.name}”; ${hoursText(answer.more)} more is on the calendar.`
      : `Logged ${hoursText(answer.worked)} on “${t.name}”, and marked it complete.`);
  }
}

const hoursText = (min) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}`);

/**
 * The right-click menu on a block — the list Motion puts there, mapped onto
 * this planner. "Schedule event" is a pin: the block becomes a fixed booking.
 */
export function blockMenu(b, x, y) {
  if (b.worked) {
    showMenu(x, y, [
      { note: `Worked ${formatClock(b.start)} – ${formatClock(b.end)}` },
      { icon: '↗', label: 'Open task', run: () => { void taskSheet({ planId: b.planId, taskId: b.taskId }); } },
      { icon: '🗑', label: 'Remove this logged time', danger: true, run: run(b, () => act.deleteTimeLine(b.sheetId)) },
    ]);
    return;
  }
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
    b.live
      ? { icon: '■', label: 'Stop task…', run: () => { void stopNowDialog({ planId: b.planId, taskId: b.taskId }); } }
      : { icon: '▶', label: 'Start task now…', disabled: done, run: run(b, (t) => { void startNowDialog(t, b); }) },
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
export function fieldInput(project, field, value) {
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
  // Where the calendar has it: the state across the top of the facts, and
  // the next time it is on — what someone opening a task wants first.
  const { currentLayout, lateSentence } = await import('./calendar.js');
  const layout = currentLayout().all;
  const lateLine = (layout.late || []).find((l) => l.taskId === t.id && l.planId === project.id);
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const todayNum = toDay(today());
  const next = (layout.blocks || []).filter((x) => x.taskId === t.id && x.planId === project.id && !x.worked
    && (x.day > todayNum || (x.day === todayNum && x.end > nowMin))).sort((a, c) => a.day - c.day || a.start - c.start)[0];
  const running = pins.some((x) => x.live);
  const state = info?.percent === 100 ? { cls: 'is-done', text: `✓ Done${t.doneAt ? ` · ${formatDate(t.doneAt.slice(0, 10), 'day')}` : ''}` }
    : t.archived ? { cls: 'is-off', text: '▣ Archived' }
    : running ? { cls: 'is-live', text: '▶ Running now' }
    : lateLine ? { cls: 'is-late', text: '⏱ Will be late', title: lateSentence(lateLine) }
    : !agendaOf(project, t).show ? { cls: 'is-off', text: 'Not on the calendar' }
    : { cls: 'is-ok', text: '✓ On track' };
  const whenLine = info?.percent === 100 || t.archived ? null
    : next ? `${next.pinned ? 'Fixed' : 'Scheduled'} ${formatDate(next.dateIso, 'day')} at ${formatClock(next.start)}`
    : agendaOf(project, t).show ? 'Not placed yet — nothing free before the horizon' : null;
  const expectedMin = info ? Math.round(expectedHours(project, t) * 60) : 0;
  // Done is what is no longer left — logged hours or progress, whichever says more.
  const leftMin = info ? Math.round(hoursLeft(project, info, t) * 60) : 0;
  const spentMin = Math.max(0, expectedMin - leftMin);
  const minText = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`);

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
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); e.stopPropagation(); save(); }
      if (k === 'l') { e.preventDefault(); e.stopPropagation(); void copy(taskLink(project.id, t.id)); }
      if (k === 'd') { e.preventDefault(); e.stopPropagation(); close(null); act.duplicateTask(t.id); }
    }), 0);
    const more = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      showMenu(r.left - 180, r.bottom + 4, [
        { icon: '⧉', label: 'Copy link', key: '⌘L', run: () => copy(taskLink(project.id, t.id)) },
        running
          ? { icon: '■', label: 'Stop task…', run: () => { close(null); void stopNowDialog({ planId: project.id, taskId: t.id }); } }
          : { icon: '▶', label: 'Start task now…', disabled: info?.percent === 100 || t.milestone, run: () => { close(null); void startNowDialog(t, b); } },
        '-',
        { icon: '⎘', label: 'Duplicate task', key: '⌘D', run: () => { close(null); act.duplicateTask(t.id); } },
        { icon: '⧉', label: 'Bulk duplicate task…', run: () => { close(null); void bulkDuplicate(t); } },
        { icon: '▢', label: 'Create project from task', run: () => { close(null); void projectFromTask(t); } },
        { icon: '✦', label: 'Save as template…', run: () => { close(null); void templateFromTask(t); } },
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
            el('button', {
              class: `sc-button sc-button--sm sheet-complete${info?.percent === 100 ? ' is-done' : ''}`,
              text: info?.percent === 100 ? '✓ Completed' : '✓ Mark complete',
              title: info?.percent === 100 ? 'Mark it not complete' : 'Mark it complete and take its time off the calendar',
              onclick: () => { done.checked = info?.percent !== 100; save(); },
            }),
            el('button', { class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', text: '⎘', title: 'Duplicate (⌘D)', onclick: () => { close(null); act.duplicateTask(t.id); } }),
            el('button', { class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', text: '⋯', title: 'More', onclick: more })),
          name,
          b ? el('div', { class: 'sheet-when' }, day, from, el('span', { text: '–' }), to) : null,
          b ? el('div', { class: 'sc-faint small', text: b.pinned
            ? 'This block is fixed here. Changing the day or hours moves it; the rest of the week re-lays around it.'
            : 'Placed by the calendar. Changing the day or hours fixes it there, the same as dragging it.' }) : null,
          late ? el('div', { class: 'sc-alert sc-alert--danger sheet-late', text: late }) : null,
          notes),
        el('aside', { class: 'task-sheet-facts' },
          el('div', { class: `sheet-state ${state.cls}`, title: state.title || '', text: state.text }),
          whenLine ? el('div', { class: `sheet-sched${next?.pinned ? ' is-fixed' : ''}`, text: whenLine }) : null,
          el('label', { class: `fact-done${info?.percent === 100 ? ' is-done' : ''}` }, done, el('span', { text: 'Task complete' }),
            info?.percent === 100 && t.doneAt ? el('span', { class: 'sc-faint small fact-done-at', text: `${formatDate(t.doneAt.slice(0, 10), 'day')}${t.doneAt.length > 10 ? `, ${formatClock(parseTime(t.doneAt.slice(11)))}` : ''}` }) : null),
          fact('Project', el('span', {}, project.name, el('button', { class: 'sc-button sc-button--ghost sc-button--sm', text: 'Open', onclick: () => { close(null); act.revealTask(t.id); act.selectTask(t.id); set({ view: 'gantt' }); } }))),
          fact('Assignee', list(who)),
          fact('Urgency', urgency),
          fact('Duration', el('span', { class: 'sc-mono', title: `${info?.duration ?? 0} day(s) open in the plan · ${info?.percent ?? 0}% complete`,
            text: `${minText(spentMin)} of ${minText(expectedMin)} done · ${minText(leftMin)} left` })),
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
/**
 * Save as template: a template plan holding this task as it is set up — its
 * hours, people, notes and fields — with no progress and no dates, for the
 * next time the same work comes round. The task itself is left alone.
 */
async function templateFromTask(t) {
  const name = await promptText('Save as template', 'A template plan is made with this task in it, ready to start again from New project.', `${t.name}`);
  if (!name) return;
  const { createProject, insertTask } = await import('../model/model.js');
  const { freshCopy } = await import('../model/setup.js');
  const from = store.project;
  const p = createProject(name.trim(), from.start);
  p.workspaceId = from.workspaceId || null;
  p.fields = structuredClone(from.fields || []);
  p.resources = from.resources.filter((r) => t.assignments.some((a) => a.resourceId === r.id)).map((r) => ({ ...r }));
  const copyOf = structuredClone(t);
  delete copyOf.id;
  delete copyOf.doneAt;
  insertTask(p, 0, { ...copyOf, level: 1, predecessors: [], archived: false });
  freshCopy(p, from.start);
  p.template = true;
  const { saveTemplatePlan } = await import('../state/sync.js');
  if (await saveTemplatePlan(p)) act.hint(`“${p.name}” is saved as a template — New project offers it.`);
}

async function bulkDuplicate(t) {
  const n = await promptText('Bulk duplicate', `How many copies of “${t.name}”? (1–50)`, '3');
  const count = Math.round(+n);
  if (!(count >= 1 && count <= 50)) { if (n) act.hint('Between 1 and 50 copies.'); return; }
  for (let i = 0; i < count; i++) act.duplicateTask(t.id);
  act.hint(`${count} cop${count === 1 ? 'y' : 'ies'} of “${t.name}” made, just below it.`);
}

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
 * The event window: an event made here, new or opened. Across the top, what
 * and when — title, start and end (which can be different days), all day,
 * repeat, travel time — on the event's own colour. Below, the details: a
 * meeting link, the place, busy or free, whose time, colour, guests, notes.
 * "Add to project" turns it into a task at the same time instead.
 */
export async function eventDialog({ day, start, end, ev = null }) {
  const project = store.project;
  const saved = await open(ev ? 'Event' : 'New event', (close) => {
    const head = el('div', { class: 'ev-head' });
    const paint = (c) => head.style.setProperty('--ev', EVENT_COLOURS[c]?.hex || EVENT_COLOURS.mint.hex);
    const title = el('input', { class: 'ev-title', type: 'text', value: ev?.title || '', placeholder: 'Event title', 'data-autofocus': '' });
    const fromDate = dateInput(ev?.day || day);
    const fromTime = timeInput(ev?.allDay ? 540 : (ev?.start ?? start));
    const toDate = dateInput(ev?.endDay || ev?.day || day);
    const toTime = timeInput(ev?.allDay ? 600 : (ev?.end ?? end) % (24 * 60));
    fromDate.addEventListener('change', () => { if (toDate.value < fromDate.value) toDate.value = fromDate.value; });
    const allDay = el('input', { type: 'checkbox', class: 'sc-check', checked: !!ev?.allDay });
    const showTimes = () => { fromTime.hidden = allDay.checked; toTime.hidden = allDay.checked; };
    allDay.addEventListener('change', showTimes);
    showTimes();
    const repeat = el('select', { class: 'sc-select ev-mini' }, ...Object.entries(EVENT_REPEATS).map(([id, label]) => el('option', { value: id, text: label, selected: (ev?.repeat || 'none') === id })));
    const travel = el('select', { class: 'sc-select ev-mini', title: 'Held either side of it, to get there and back' },
      ...TRAVEL_CHOICES.map((m) => el('option', { value: m, text: m ? `${m} min travel` : 'No travel time', selected: (ev?.travel || 0) === m })));
    const link = el('input', { class: 'sc-input', type: 'url', value: ev?.link || '', placeholder: 'Meeting link (Teams, Zoom, Meet…)' });
    const place = el('input', { class: 'sc-input', type: 'text', value: ev?.location || '', placeholder: 'Location' });
    const busy = el('select', { class: 'sc-select' },
      el('option', { value: 'busy', text: 'Busy — work goes around it', selected: ev?.busy !== false }),
      el('option', { value: 'free', text: 'Free — shown, not blocking', selected: ev?.busy === false }));
    const who = el('select', { class: 'sc-select' }, el('option', { value: '', text: 'Everyone on the plan' }),
      ...project.resources.filter((r) => r.type === 'work').map((r) => el('option', { value: r.id, text: r.name, selected: ev?.resourceId === r.id })));
    const colour = el('select', { class: 'sc-select', onchange: (e) => paint(e.target.value) },
      ...Object.entries(EVENT_COLOURS).map(([id, c]) => el('option', { value: id, text: c.label, selected: (ev?.colour || 'mint') === id })));
    const notes = el('textarea', { class: 'sc-textarea ev-notes', rows: 7, value: ev?.notes || '', placeholder: 'Notes' });
    const guests = el('textarea', { class: 'sc-textarea', rows: 4, value: (ev?.guests || []).join('\n'), placeholder: 'Add guests — a name or address a line' });
    paint(ev?.colour || 'mint');

    const read = () => ({
      title: title.value, day: fromDate.value, endDay: toDate.value, allDay: allDay.checked,
      start: parseTime(fromTime.value), end: parseTime(toTime.value) === 0 && toDate.value > fromDate.value ? 24 * 60 : parseTime(toTime.value),
      repeat: repeat.value, travel: +travel.value, link: link.value, location: place.value, busy: busy.value === 'busy',
      resourceId: who.value || null, colour: colour.value, guests: guests.value, notes: notes.value,
    });
    const save = () => close(read());
    setTimeout(() => document.querySelector('.ev-sheet')?.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); save(); }
      if (e.key === 'Enter' && e.target === title) save();
    }), 0);

    head.append(
      el('div', { class: 'ev-head-row' },
        el('span', { class: 'ev-chip', text: '▦ Event' }),
        ev?.repeat && ev.repeat !== 'none' ? el('span', { class: 'ev-series', text: 'Changes apply to every repeat' }) : null,
        el('span', { class: 'sc-spacer' }),
        el('button', { class: 'sc-button sc-button--sm', text: '＋ Add to project', title: `Make it a task in ${project.name}, at this time, instead`, onclick: () => close({ ...read(), toProject: true }) })),
      title,
      el('div', { class: 'ev-when' }, fromDate, fromTime, el('span', { class: 'ev-dash', text: '–' }), toDate, toTime),
      el('div', { class: 'ev-opts' }, el('label', { class: 'ev-allday' }, allDay, el('span', { text: 'All day' })), repeat, travel));
    return [
      el('div', { class: 'ev-sheet' },
        head,
        el('div', { class: 'ev-body' },
          el('div', { class: 'ev-details' },
            el('div', { class: 'sc-label', text: 'Event details' }),
            link, place,
            el('div', { class: 'ev-pair' }, busy, who),
            el('div', { class: 'ev-pair' }, colour, el('span', { class: 'sc-faint small', text: `In ${project.name}` })),
            notes),
          el('div', { class: 'ev-side' },
            el('div', { class: 'sc-label', text: 'Guests' }),
            guests,
            el('p', { class: 'sc-faint small', text: 'Kept with the event so you know who is coming. Nothing is sent to them.' })))),
      foot(
        ev ? button('Delete', () => close({ delete: true }), 'sc-button--danger') : el('span'),
        el('span', { class: 'sc-spacer' }),
        button('Cancel  Esc', () => close(null)),
        button(ev ? 'Save  ⌘S' : 'Create event  ⌘S', save, 'sc-button--primary')),
    ];
  }, { wide: true });
  if (!saved) return;
  if (saved.delete) { act.deleteOwnEvent(ev.id); act.hint(`“${ev.title}” is off the calendar.`); return; }
  if (!saved.title.trim()) { act.hint('An event needs a title.'); return; }
  if (!saved.allDay && (saved.start === null || saved.end === null || (saved.endDay === saved.day && saved.end <= saved.start))) { act.hint('An event ends after it starts.'); return; }
  if (saved.toProject) {
    // The same hours, as project work: a task fixed there. The event goes, or
    // the hour would be booked twice — once as busy, once as work.
    if (saved.allDay || saved.endDay !== saved.day) { act.hint('Only an event inside one day can become a task at a fixed time.'); return; }
    const t = act.newTaskFromEvent({ name: saved.title.trim(), day: saved.day, start: saved.start, minutes: saved.end - saved.start,
      notes: [saved.location, saved.link, saved.notes].filter(Boolean).join('\n\n') });
    if (t) { if (ev) act.deleteOwnEvent(ev.id); act.hint(`“${t.name}” is now a task in ${store.project.name}, fixed at ${formatClock(saved.start)}.`); }
    return;
  }
  if (act.saveOwnEvent({ ...(ev || {}), ...saved })) act.hint(`“${saved.title.trim()}” is on the calendar${saved.busy ? '; work is laid around it' : ', as free time'}.`);
}

/** Right-click on empty calendar time: make something there. */
export function slotMenu({ day, start, end }, x, y, onClose = () => {}) {
  showMenu(x, y, [
    { note: `${formatDate(day, 'day')} · ${formatClock(start)}` },
    { icon: '▦', label: 'Create event', run: () => { onClose(); void eventDialog({ day, start, end }); } },
    { icon: '☑', label: 'Create task (fixed time)', run: () => { onClose(); void import('./taskpanel.js').then((m) => m.newTaskPanel({ day, start, end, fixed: true })); } },
    { icon: '✦', label: 'Create task (auto-scheduled)', run: () => { onClose(); void import('./taskpanel.js').then((m) => m.newTaskPanel({ day, start, end, fixed: false })); } },
  ]);
}

/**
 * An event from a connected calendar, opened (one made here opens in the event window). The calendar it came from is
 * where it is edited, so its time is shown and not changed here; what the
 * planner owns about it — travel time, and whether it is project work — is.
 */
export function meetingSheet(m) {
  if (m.own) {
    const plan = m.planId === store.project.id ? store.project : null;
    const ev = plan?.events?.find((x) => x.id === m.eventId);
    if (ev) return eventDialog({ day: ev.day, start: ev.start, end: ev.end, ev });
  }
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
