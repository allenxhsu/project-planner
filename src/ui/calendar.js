// The Calendar view: a week, with each task's blocks laid on the hours.
//
// A task appears here only when it asks to (Show in calendar, on the task's
// details), because a plan holds plenty of work nobody schedules hour by hour.
// The blocks themselves are computed, never stored — see model/agenda.js — so
// logging four hours or moving a task re-lays the week by itself.

import { el, clear } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { planBlocks, agendaOf, formatClock, parseTime, DEFAULT_AGENDA } from '../model/agenda.js';
import { weekStart, toDay, fromDay, today, formatDate, WEEKDAY_NAMES, makeCalendar } from '../model/calendar.js';
import { isSummary, phases, getTask } from '../model/model.js';
import { showMenu } from './dialog.js';

/** Which week is on screen, as a day number inside it. */
let anchor = null;
export function goToWeek(day) { anchor = day; set({}); }
export const showThisWeek = () => goToWeek(toDay(today()));
export const shiftWeek = (weeks) => goToWeek((anchor ?? toDay(today())) + weeks * 7);

const HOUR_H = 46;

/**
 * Give every block a column within its day, so blocks that share an hour sit
 * beside each other. Blocks that overlap at all form one cluster and share the
 * width; a block alone in its hour keeps the whole column.
 */
function sideBySide(dayBlocks) {
  const sorted = [...dayBlocks].sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    if (!cluster.length) return;
    const ends = [];               // when each column is free again
    const placed = cluster.map((b) => {
      let slot = ends.findIndex((e) => e <= b.start);
      if (slot < 0) { slot = ends.length; ends.push(0); }
      ends[slot] = b.end;
      return { block: b, lane: slot };
    });
    const lanes = ends.length;
    for (const p of placed) out.push({ ...p, lanes });
    cluster = [];
    clusterEnd = -1;
  };
  for (const b of sorted) {
    if (cluster.length && b.start >= clusterEnd) flush();
    cluster.push(b);
    clusterEnd = Math.max(clusterEnd, b.end);
  }
  flush();
  return out;
}

export function renderCalendar(root) {
  const { project, schedule, ui } = store;
  clear(root);
  const pane = el('div', { class: 'cal-pane' });
  root.append(pane);

  const { blocks, overflow, meetings } = planBlocks(project, schedule);
  const phaseList = phases(project);
  const current = project.currentPhaseId ? getTask(project, project.currentPhaseId) : null;
  if (phaseList.length) {
    pane.append(el('div', { class: 'cal-phase' },
      el('span', { class: 'sc-label', text: 'Releasing' }),
      el('select', { class: 'sc-select', onchange: (e) => act.setCurrentPhase(e.target.value) },
        el('option', { value: '', text: 'Every phase', selected: !current }),
        ...phaseList.map((ph) => el('option', { value: ph.id, text: ph.name, selected: ph.id === project.currentPhaseId }))),
      el('span', { class: 'sc-faint small', text: current ? `Only ${current.name} tasks reach the calendar.` : 'Every phase’s tasks reach the calendar.' })));
  }
  const shown = project.tasks.filter((t, i) => !isSummary(project, i) && agendaOf(project, t).show);
  if (!shown.length) {
    pane.append(el('div', { class: 'empty-note sc-muted' },
      el('p', { text: 'Nothing is on the calendar yet.' }),
      el('p', { text: 'Open a task’s details and switch on “Show in calendar”. It will be cut into blocks of the size you choose — half an hour, one, one and a half, two or four — and laid inside the hours you say you work.' }),
      el('button', { class: 'sc-button sc-button--sm', text: 'Put every unfinished task on the calendar', onclick: () => act.showAllInCalendar() })));
    return;
  }

  const start = weekStart(anchor ?? toDay(today()));
  const days = [];
  for (let d = start; d < start + 7; d++) days.push(d);
  const cal = makeCalendar(project.calendar);
  const workDays = days.filter((d) => cal.isWorking(d));
  const columns = workDays.length ? workDays : days;

  // The hours to draw: every task's window, and every block, has to fit.
  const base = { ...DEFAULT_AGENDA, ...(project.agenda || {}) };
  let from = parseTime(base.from) ?? 540, to = parseTime(base.to) ?? 1020;
  for (const t of shown) { const a = agendaOf(project, t); from = Math.min(from, a.from); to = Math.max(to, a.to); }
  for (const b of blocks) if (columns.includes(b.day)) { from = Math.min(from, b.start); to = Math.max(to, b.end); }
  for (const m of (meetings || [])) if (columns.includes(m.day) && !m.allDay) { from = Math.min(from, m.start); to = Math.max(to, m.end); }
  const hourFrom = Math.floor(from / 60), hourTo = Math.ceil(to / 60);
  const y = (min) => ((min - hourFrom * 60) / 60) * HOUR_H;

  const todayDay = toDay(today());
  const head = el('div', { class: 'cal-head' }, el('div', { class: 'cal-gutter sc-mono', text: '' }));
  for (const d of columns) {
    head.append(el('div', { class: `cal-col-head${d === todayDay ? ' is-today' : ''}` },
      el('span', { class: 'sc-label', text: WEEKDAY_NAMES[((d + 4) % 7 + 7) % 7].slice(0, 3) }),
      el('span', { class: 'cal-date', text: formatDate(fromDay(d), 'day') })));
  }
  pane.append(head);

  const body = el('div', { class: 'cal-body' });
  const gutter = el('div', { class: 'cal-gutter' });
  for (let h = hourFrom; h < hourTo; h++) {
    gutter.append(el('div', { class: 'cal-hour sc-mono', style: { height: `${HOUR_H}px` }, text: formatClock(h * 60) }));
  }
  body.append(gutter);

  for (const d of columns) {
    const col = el('div', { class: `cal-col${d === todayDay ? ' is-today' : ''}`, style: { height: `${(hourTo - hourFrom) * HOUR_H}px` } });
    for (let h = hourFrom; h < hourTo; h++) col.append(el('div', { class: 'cal-line', style: { top: `${(h - hourFrom) * HOUR_H}px` } }));
    // Meetings from a connected calendar sit behind the work, because that is
    // what they are: hours already spoken for.
    for (const m of (meetings || []).filter((x) => x.day === d)) {
      col.append(el('div', {
        class: `cal-meeting${m.allDay ? ' is-allday' : ''}`,
        style: { top: `${y(m.start)}px`, height: `${Math.max(14, y(m.end) - y(m.start) - 1)}px` },
        title: `${m.title}\n${m.allDay ? 'All day' : `${formatClock(m.start)} – ${formatClock(m.end)}`}`,
      }, el('div', { class: 'cal-meeting-name', text: m.title })));
    }
    for (const { block: b, lane: slot, lanes } of sideBySide(blocks.filter((x) => x.day === d))) {
      const t = project.tasks.find((x) => x.id === b.taskId);
      const info = schedule.tasks[b.taskId];
      if (!t || !info) continue;
      const height = Math.max(16, y(b.end) - y(b.start) - 2);
      // Two people can work the same hour, so their blocks sit side by side
      // rather than one hiding the other.
      const width = 100 / lanes;
      col.append(el('div', {
        class: `cal-block${b.critical ? ' is-critical' : ''}${ui.selection.includes(t.id) ? ' is-sel' : ''}`,
        style: { top: `${y(b.start)}px`, height: `${height}px`, left: `calc(${slot * width}% + 3px)`, width: `calc(${width}% - 6px)`, right: 'auto' },
        title: `${t.name}\n${formatClock(b.start)} – ${formatClock(b.end)} · ${b.minutes / 60}h\n${info.percent}% complete`,
        onclick: () => act.selectTask(t.id),
        ondblclick: () => set({ rightOpen: true, rightTab: 'task', selection: [t.id] }),
        oncontextmenu: (e) => {
          e.preventDefault();
          act.selectTask(t.id);
          showMenu(e.clientX, e.clientY, [
            { label: 'Task information…', run: () => set({ rightOpen: true, rightTab: 'task' }) },
            { label: 'Show on the Gantt chart', run: () => { act.revealTask(t.id); set({ view: 'gantt' }); } },
            '-',
            { label: 'Break into subtasks…', run: () => act.breakUpDialog(t.id) },
            '-',
            { label: 'Take off the calendar', run: () => act.editTask(t.id, 'calendarShow', false) },
          ]);
        },
      },
        el('div', { class: 'cal-block-time sc-mono', text: formatClock(b.start) }),
        el('div', { class: 'cal-block-name', text: t.name })));
    }
    body.append(col);
  }
  pane.append(body);

  if (overflow.length) {
    const hours = Math.round(overflow.reduce((s, o) => s + o.minutes, 0) / 6) / 10;
    pane.append(el('div', { class: 'sc-alert sc-alert--warning cal-overflow' },
      el('strong', { text: `${hours}h could not be placed. ` }),
      el('span', { text: overflow.some((o) => o.reason === 'window-too-short')
        ? 'One task asks for blocks longer than the hours it is allowed — widen its window, or use a smaller block.'
        : 'There are more hours of work than there are working hours to put them in.' })));
  }
}
