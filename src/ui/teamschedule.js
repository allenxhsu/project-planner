// Team Schedule: Motion's board of who is doing what on which day.
//
// Tabs across the top are the days work is scheduled on, each with how many
// tasks; the columns under a tab are the people, and a card is a task the
// calendar has put on that day — across every project, because a person's
// day is all of them. "No Value" holds the open work nothing has scheduled.
// Scheduled means the calendar's own layout (ui/calendar.js), so this board
// and the calendar never disagree.

import { el, clear } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { isSummary, URGENCIES, urgencyOf, stageOf } from '../model/model.js';
import { expectedHours, hoursLeft, agendaOf } from '../model/agenda.js';
import { toDay, fromDay, today, formatDate, WEEKDAY_NAMES, weekday } from '../model/calendar.js';
import { currentLayout, personColour, reloadCalendarPlans } from './calendar.js';
import { taskSheet } from './blockmenu.js';

let tab = null;                 // a day number, or 'none'
const minText = (m) => (m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`);
const dayLabel = (d) => `${WEEKDAY_NAMES[weekday(d)].slice(0, 3)} ${formatDate(fromDay(d), 'day')}`;

/** The tabs of view the Projects & Tasks page has, Motion's names. */
export function projectsTasksTabs(active) {
  return el('div', { class: 'pt-tabs' },
    el('span', { class: 'pt-title', text: '≣ Projects & Tasks' }),
    ...[['alltasks', 'Task List'], ['team', 'Team Schedule'], ['projects', 'Projects']].map(([view, label]) => el('button', {
      class: `pt-tab${active === view ? ' is-on' : ''}`, text: label, onclick: () => set({ view }),
    })));
}

export function renderTeamSchedule(root) {
  clear(root);
  const pane = el('div', { class: 'ts-pane' });
  root.append(pane);
  pane.append(projectsTasksTabs('team'));
  let layout;
  try { layout = currentLayout(); } catch { layout = null; }
  if (!layout) { pane.append(el('p', { class: 'empty', text: 'Reading every plan…' })); void reloadCalendarPlans(); return; }
  const { entries, all } = layout;
  const todayDay = toDay(today());

  // Each open task, once: the first day the calendar has it on from today.
  const cards = [];
  for (const e of entries) {
    e.project.tasks.forEach((t, i) => {
      const info = e.schedule.tasks[t.id];
      if (!info || isSummary(e.project, i) || t.archived || info.milestone) return;
      const done = info.percent === 100;
      const blocks = (all.byTask?.get(t.id) || []).filter((b) => b.planId === e.project.id && !b.worked && b.day >= todayDay);
      const day = blocks.length ? Math.min(...blocks.map((b) => b.day)) : null;
      if (done && t.doneAt?.slice(0, 10) !== fromDay(todayDay)) return;   // finished earlier: off the board
      const who = t.assignments.map((a) => e.project.resources.find((r) => r.id === a.resourceId)).filter(Boolean);
      cards.push({ e, t, info, day: done ? todayDay : day, who, done });
    });
  }
  const days = [...new Set(cards.filter((c) => c.day !== null).map((c) => c.day))].sort((a, b) => a - b).slice(0, 21);
  const none = cards.filter((c) => c.day === null);
  if (tab === null || (tab !== 'none' && !days.includes(tab))) tab = days[0] ?? 'none';

  pane.append(el('div', { class: 'ts-days' },
    ...days.map((d) => el('button', { class: `ts-day${tab === d ? ' is-on' : ''}`, onclick: () => { tab = d; set({}); } },
      el('strong', { text: dayLabel(d) }), el('span', { class: 'sc-faint', text: String(cards.filter((c) => c.day === d).length) }),
      d === todayDay ? el('span', { class: 'ts-current', text: 'Current' }) : null)),
    el('button', { class: `ts-day${tab === 'none' ? ' is-on' : ''}`, title: 'Open work nothing has scheduled', onclick: () => { tab = 'none'; set({}); } },
      el('strong', { text: 'No Value' }), el('span', { class: 'sc-faint', text: String(none.length) }))));

  const shown = tab === 'none' ? none : cards.filter((c) => c.day === tab);
  const columns = new Map();
  for (const c of shown) {
    const names = c.who.length ? c.who.map((r) => r.name) : ['Unassigned'];
    for (const n of names) { if (!columns.has(n)) columns.set(n, []); columns.get(n).push(c); }
  }
  const board = el('div', { class: 'ts-board' });
  if (!columns.size) board.append(el('p', { class: 'empty', text: tab === 'none' ? 'Every open task is on the calendar.' : 'Nothing scheduled on this day.' }));
  for (const [name, list] of [...columns].sort((a, b) => (a[0] === 'Unassigned') - (b[0] === 'Unassigned') || a[0].localeCompare(b[0]))) {
    const colour = personColour(name);
    board.append(el('div', { class: 'ts-col' },
      el('div', { class: 'ts-col-head' },
        el('span', { class: 'ps-who', style: { background: name === 'Unassigned' ? 'var(--sc-text-3)' : colour.line }, text: name[0] }),
        el('strong', { text: name }), el('span', { class: 'sc-faint', text: String(list.length) }),
        el('span', { class: 'sc-spacer' }),
        el('button', { class: 'side-icon', text: '＋', title: 'A new task', onclick: () => { void import('./taskpanel.js').then((m) => m.newTaskPanel(tab !== 'none' ? { day: fromDay(tab), start: 9 * 60, end: 10 * 60, fixed: false } : {})); } })),
      ...list.sort((a, b) => URGENCIES[urgencyOf(a.t)].rank - URGENCIES[urgencyOf(b.t)].rank).map(card)));
  }
  pane.append(board);
}

function card({ e, t, info, day, who, done }) {
  const p = e.project;
  const exp = Math.round(expectedHours(p, info, t) * 60);
  const left = Math.round(hoursLeft(p, info, t) * 60);
  const lateDue = t.deadline && toDay(t.deadline) < toDay(today()) && !done;
  const flag = { now: 'var(--sc-danger)', high: '#e0703a', normal: '#d9a52b', low: 'var(--sc-text-3)' }[urgencyOf(t)];
  return el('div', { class: `ts-card${done ? ' is-done' : ''}`, onclick: () => { void taskSheet({ planId: p.id, taskId: t.id }); } },
    el('div', { class: 'ts-card-project sc-faint small' }, el('span', { text: `▢ ${p.name}` }),
      el('span', { class: `ts-health${lateDue ? ' is-late' : ''}`, title: lateDue ? 'Past its deadline' : 'On track', text: lateDue ? '!' : '✓' })),
    el('div', { class: 'ts-card-row' },
      el('span', { class: 'ts-flag', style: { color: flag }, title: `${URGENCIES[urgencyOf(t)].label} priority`, text: '⚑' }),
      el('span', { class: 'ts-status', text: `○ ${stageOf(p, t).name}` }),
      el('span', { class: 'sc-spacer' }),
      day !== null ? el('span', { class: 'ts-when', text: dayLabel(day) }) : null,
      agendaOf(p, t).show ? el('span', { class: 'ps-auto', title: 'Auto-scheduled', text: '✦' }) : null),
    el('div', { class: 'ts-card-title', text: t.name }),
    el('div', { class: 'ts-card-row sc-faint small' },
      el('span', { text: `${minText(Math.max(0, exp - left))} of ${minText(exp)}` }),
      el('span', { class: `ts-due${lateDue ? ' is-late' : ''}`, text: t.deadline ? formatDate(t.deadline, 'day') : '' }),
      el('span', { text: who[0]?.name || '' })),
    el('div', { class: 'ts-labels' }, ...(t.labels || []).map((l) => el('span', { class: 'ps-chip', text: l })),
      el('button', { class: 'ts-add-label', text: '＋ Add label', onclick: async (ev) => {
        ev.stopPropagation();
        const { promptText } = await import('./dialog.js');
        const l = await promptText('Add a label', `A label for “${t.name}”.`, '');
        if (!l?.trim()) return;
        if (p.id !== store.project.id) { const { openPlan } = await import('../state/sync.js'); if (!(await openPlan(p.id))) return; set({ view: 'team' }); }
        act.editTask(t.id, 'labels', [...(t.labels || []), l.trim()]);
      } })));
}
