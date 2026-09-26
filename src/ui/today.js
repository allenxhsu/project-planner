// Today: the page to open first thing.
//
// What is on today — every task with work laid on this day, across every
// project the calendar covers — then what will not make its deadline, then
// what is already past one. Beside it, the day itself: the blocks and the
// meetings in order, so the list and the hours can be read together.
//
// Everything here comes from the calendar's own layout (ui/calendar.js), so
// "today's tasks" is exactly what the calendar has put on today, not a second
// opinion about it.

import { el, clear } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { toDay, fromDay, today, formatDate, weekday, WEEKDAY_NAMES } from '../model/calendar.js';
import { formatClock, hoursLeft, parseTime } from '../model/agenda.js';
import { isSummary, urgencyOf, URGENCIES, doneDay } from '../model/model.js';
import { currentLayout, lateSentence, personColour, planPalette } from './calendar.js';
import { taskSheet, meetingSheet } from './blockmenu.js';

let offset = 0;                        // days from today
export const todayShift = (n) => { offset = n === 0 ? 0 : offset + n; set({}); };

const hoursText = (min) => (min < 60 ? `${min}m` : `${Math.round(min / 6) / 10}h`);

async function complete(planId, taskId, done) {
  if (planId !== store.project.id) {
    const { openPlan } = await import('../state/sync.js');
    if (!(await openPlan(planId))) return;
  }
  act.setPercent(taskId, done ? 100 : 0);
}

function taskRow({ planId, planName, task, info, extra, showPlan }) {
  const due = task.deadline;
  const overdue = due && toDay(due) < toDay(today()) && info.percent < 100;
  const box = el('input', {
    class: 'sc-check today-check', type: 'checkbox', checked: info.percent === 100, title: 'Mark complete',
    onclick: (e) => e.stopPropagation(),
    onchange: (e) => { void complete(planId, task.id, e.target.checked); },
  });
  return el('li', {
    class: `today-row${info.percent === 100 ? ' is-done' : ''}`,
    onclick: () => { void taskSheet({ planId, taskId: task.id }); },
    title: 'Open the task',
  },
    box,
    el('span', { class: 'today-name' },
      urgencyOf(task) !== 'normal' ? el('span', { class: `urg-dot urg-${urgencyOf(task)}`, title: URGENCIES[urgencyOf(task)].label }) : null,
      task.name),
    due ? el('span', { class: `today-due${overdue ? ' is-overdue' : ''}`, text: `${WEEKDAY_NAMES[weekday(toDay(due))].slice(0, 2)} ${formatDate(due, 'day')}` }) : null,
    extra ? el('span', { class: 'sc-faint today-hours', text: extra }) : null,
    showPlan ? el('span', { class: 'sc-pill today-plan', text: planName }) : null);
}

export function renderToday(root) {
  clear(root);
  const { entries, history = [], all } = currentLayout();
  const day = toDay(today()) + offset;
  const iso = fromDay(day);
  const many = entries.length > 1;
  const find = (planId, taskId) => {
    const e = entries.find((x) => x.project.id === planId) || history.find((x) => x.project.id === planId);
    const task = e?.project.tasks.find((t) => t.id === taskId);
    return task ? { e, task, info: e.schedule.tasks[taskId] } : null;
  };

  // Today's tasks: what the calendar laid on this day, one row a task.
  const onDay = all.blocks.filter((b) => b.day === day);
  const byTask = new Map();
  for (const b of onDay) {
    const key = `${b.planId}|${b.taskId}`;
    const row = byTask.get(key) || { planId: b.planId, taskId: b.taskId, minutes: 0, first: b.start };
    row.minutes += b.minutes;
    row.first = Math.min(row.first, b.start);
    byTask.set(key, row);
  }
  const todays = [...byTask.values()].sort((a, b) => a.first - b.first);

  // Past deadline: not done, not archived, due before this day — anywhere.
  const past = [];
  for (const e of entries) {
    e.project.tasks.forEach((task, i) => {
      const info = e.schedule.tasks[task.id];
      if (!info || isSummary(e.project, i) || task.archived || info.percent === 100 || !task.deadline) return;
      if (toDay(task.deadline) >= day) return;
      past.push({ e, task, info });
    });
  }
  past.sort((a, b) => a.task.deadline.localeCompare(b.task.deadline));
  const late = (all.late || []).filter((l) => l.deadline >= day);

  // Completed on this day: every task, anywhere, finished that day.
  const finished = [];
  for (const e of entries) {
    e.project.tasks.forEach((task, i) => {
      const info = e.schedule.tasks[task.id];
      if (!info || isSummary(e.project, i) || doneDay(task) !== iso || info.percent !== 100) return;
      finished.push({ e, task, info });
    });
  }

  const pane = el('div', { class: 'today-pane' });
  const main = el('div', { class: 'today-main' });
  const title = offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : offset === -1 ? 'Yesterday' : WEEKDAY_NAMES[weekday(day)];
  main.append(el('div', { class: 'today-head' },
    el('div', {},
      el('div', { class: 'sc-label', text: title }),
      el('h1', { class: 'today-date', text: `${WEEKDAY_NAMES[weekday(day)].slice(0, 3)} ${formatDate(iso, 'day')}` })),
    el('span', { class: 'sc-spacer' }),
    el('button', { class: 'sc-button sc-button--sm', text: '‹', title: 'The day before', onclick: () => todayShift(-1) }),
    el('button', { class: 'sc-button sc-button--sm', text: 'Today', onclick: () => todayShift(0) }),
    el('button', { class: 'sc-button sc-button--sm', text: '›', title: 'The day after', onclick: () => todayShift(1) })));

  const section = (heading, rows, empty) => {
    main.append(el('h2', { class: 'today-section', text: heading }));
    if (!rows.length) { main.append(el('p', { class: 'sc-faint small today-empty', text: empty })); return; }
    main.append(el('ul', { class: 'today-list' }, ...rows));
  };

  section(`${title === 'Today' ? 'Today' : title}'s tasks`, todays.map((r) => {
    const hit = find(r.planId, r.taskId);
    if (!hit) return null;
    return taskRow({ planId: r.planId, planName: hit.e.project.name, task: hit.task, info: hit.info,
      extra: `${formatClock(r.first)} · ${hoursText(r.minutes)}`, showPlan: many });
  }).filter(Boolean), 'Nothing is laid on this day. Put tasks on the calendar and their hours land here.');

  section(`Completed ${title === 'Today' ? 'today' : title === 'Tomorrow' || title === 'Yesterday' ? title.toLowerCase() : `on ${title}`}`,
    finished.sort((a, b) => a.task.doneAt.localeCompare(b.task.doneAt)).map(({ e, task, info }) => taskRow({
      planId: e.project.id, planName: e.project.name, task, info, showPlan: many,
      extra: task.doneAt.length > 10 ? `done ${formatClock(parseTime(task.doneAt.slice(11)))}` : null,
    })),
    'Nothing finished yet. Tick a task and it lands here.');

  if (late.length) {
    main.append(el('h2', { class: 'today-section is-warning', text: 'Will be late' }));
    main.append(el('ul', { class: 'today-list' }, ...late.map((l) => el('li', {
      class: 'today-row today-late', onclick: () => { void taskSheet({ planId: l.planId, taskId: l.taskId }); },
    }, el('span', { class: 'today-name', text: lateSentence(l) }), many ? el('span', { class: 'sc-pill today-plan', text: l.planName }) : null))));
  }

  section('Tasks past deadline', past.map(({ e, task, info }) => taskRow({
    planId: e.project.id, planName: e.project.name, task, info,
    extra: `${Math.round(hoursLeft(e.project, info, task) * 10) / 10}h left`, showPlan: many,
  })), 'Nothing is past its deadline.');

  // The day beside it: the hours, with the blocks and the meetings on them.
  const side = el('aside', { class: 'today-day' });
  const meetings = (all.meetings || []).filter((m) => m.day === day && !m.allDay);
  const allDay = (all.meetings || []).filter((m) => m.day === day && m.allDay);
  const starts = [...onDay.map((b) => b.start), ...meetings.map((m) => m.start - m.bufferBefore)];
  const ends = [...onDay.map((b) => b.end), ...meetings.map((m) => m.end + m.bufferAfter)];
  const from = Math.max(0, Math.min(6 * 60, ...starts) - 60);
  const to = Math.min(24 * 60, Math.max(20 * 60, ...ends) + 60);
  const H = 40;
  const y = (min) => ((min - from) / 60) * H;
  const palette = planPalette(entries);
  const col = el('div', { class: 'today-col', style: { height: `${y(to)}px` } });
  for (let h = Math.ceil(from / 60); h < to / 60; h++) {
    col.append(el('div', { class: 'today-hour', style: { top: `${y(h * 60)}px` } }, el('span', { class: 'sc-mono', text: formatClock(h * 60) })));
  }
  for (const m of meetings) {
    col.append(el('div', {
      class: 'today-meeting', style: { top: `${y(m.start)}px`, height: `${Math.max(14, y(m.end) - y(m.start) - 2)}px` },
      title: `${m.title} · ${formatClock(m.start)} – ${formatClock(m.end)}`,
      onclick: () => { void meetingSheet(m); },
    }, el('span', { text: m.title }), el('span', { class: 'sc-faint', text: `${formatClock(m.start)} – ${formatClock(m.end)}` })));
  }
  for (const b of onDay) {
    const hit = find(b.planId, b.taskId);
    if (!hit) continue;
    const colour = palette.get(b.planId) || personColour(b.planName);
    col.append(el('div', {
      class: `today-block${b.late ? ' is-late' : ''}${b.pinned ? ' is-pinned' : ''}${b.live ? ' is-live' : ''}${b.worked ? ' is-worked' : ''}`,
      style: { top: `${y(b.start)}px`, height: `${Math.max(14, y(b.end) - y(b.start) - 2)}px`, background: colour.fill, borderLeftColor: colour.line },
      title: `${hit.task.name} · ${b.planName}`,
      onclick: () => { void taskSheet({ planId: b.planId, taskId: b.taskId, block: b.worked ? null : b }); },
    }, el('span', { text: `${b.worked ? '✓ ' : b.live ? '▶ ' : b.pinned ? '⌖ ' : ''}${hit.task.name}` }), el('span', { class: 'sc-faint', text: `${formatClock(b.start)} – ${formatClock(b.end)}` })));
  }
  side.append(
    el('div', { class: 'today-day-head' }, el('span', { class: 'sc-label', text: title }), el('strong', { text: formatDate(iso, 'long') })),
    ...allDay.map((m) => el('div', { class: 'today-allday', text: m.title })),
    el('div', { class: 'today-day-scroll' }, col),
    el('button', { class: 'sc-button sc-button--ghost sc-button--sm', text: 'Open in the calendar', onclick: async () => {
      const { goToWeek } = await import('./calendar.js');
      goToWeek(day); set({ view: 'calendar', calendarRange: 'day' });
    } }));

  pane.append(main, side);
  root.append(pane);
}
