// The Priority view: what to work on now, and why.
//
// The ranking is in model/agenda.js. This shows it, keeps the reasons next to
// each row — "past its deadline", "on the critical path", "waiting on 2 tasks"
// — and separates what can be started from what cannot, because an urgent task
// whose predecessor is unfinished is not something anyone can pick up.

import { el, clear, formatHours } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { priorities, hoursLeft, agendaOf } from '../model/agenda.js';
import { formatDate } from '../model/calendar.js';
import { formatAssignments, getTask } from '../model/model.js';
import { showMenu } from './dialog.js';

function row(r, rank) {
  const { project, schedule, ui } = store;
  const t = getTask(project, r.taskId);
  const info = r.info;
  const who = formatAssignments(project, t);
  const onCalendar = agendaOf(project, t).show;
  return el('article', {
    class: `pri-row sc-card${r.blocked ? ' is-blocked' : ''}${ui.selection.includes(t.id) ? ' is-sel' : ''}`,
    onclick: () => act.selectTask(t.id),
    ondblclick: () => set({ rightOpen: true, rightTab: 'task', selection: [t.id] }),
    oncontextmenu: (e) => {
      e.preventDefault();
      act.selectTask(t.id);
      showMenu(e.clientX, e.clientY, [
        { label: 'Task information…', run: () => set({ rightOpen: true, rightTab: 'task' }) },
        { label: 'Show on the Gantt chart', run: () => { act.revealTask(t.id); set({ view: 'gantt' }); } },
        '-',
        { label: onCalendar ? 'Take off the calendar' : 'Put on the calendar', run: () => act.editTask(t.id, 'calendarShow', !onCalendar) },
        { label: 'Break into subtasks…', run: () => act.breakUpDialog(t.id) },
        '-',
        { label: 'Mark 100% complete', run: () => act.setPercent(t.id, 100) },
      ]);
    },
  },
    el('div', { class: 'pri-rank sc-mono', text: String(rank) }),
    el('div', { class: 'pri-main' },
      el('div', { class: 'pri-name' }, t.name,
        info.critical ? el('span', { class: 'sc-pill', style: { '--tint': 'var(--sc-danger)' }, text: 'Critical' }) : null,
        info.deadlineMissed ? el('span', { class: 'sc-pill', style: { '--tint': 'var(--sc-danger)' }, text: 'Past deadline' }) : null,
        onCalendar ? el('span', { class: 'sc-pill', style: { '--tint': 'var(--sc-app)' }, text: 'On calendar' }) : null),
      el('div', { class: 'pri-why sc-muted', text: r.reasons.join(' · ') || 'scheduled work' }),
      el('div', { class: 'pri-meta sc-mono sc-faint' },
        `${formatDate(info.startIso, 'day')} → ${formatDate(info.finishIso, 'day')}`,
        info.work ? ` · ${formatHours(hoursLeft(project, info))} left` : '',
        who ? ` · ${who}` : '')),
    el('div', { class: 'pri-right' },
      el('div', { class: 'pri-score sc-mono', title: 'How this was ranked', text: String(r.score) }),
      el('div', { class: 'sc-meter pri-meter' }, el('span', { style: { '--value': `${info.percent}%` } }))));
}

export function renderPriority(root) {
  const { project, schedule } = store;
  clear(root);
  const pane = el('div', { class: 'pri-pane' });
  root.append(pane);

  const list = priorities(project, schedule);
  if (!list.length) {
    pane.append(el('p', { class: 'empty', text: 'Nothing outstanding — every task in this plan is complete.' }));
    return;
  }
  const ready = list.filter((r) => !r.blocked);
  const blocked = list.filter((r) => r.blocked);

  pane.append(el('div', { class: 'projects-head' },
    el('div', { class: 'sc-display', text: 'Do this next' }),
    el('span', { class: 'sc-muted small', text: 'Ranked by what is late, what has no slack, and what is nearest — work that is waiting on something unfinished is kept separate.' })));

  const top = ready[0];
  if (top) {
    pane.append(el('div', { class: 'pri-hero sc-panel sc-panel--lit sc-brackets' },
      el('div', { class: 'sc-label', text: 'Top of the list' }),
      el('div', { class: 'sc-display pri-hero-name', text: top.name }),
      el('div', { class: 'sc-muted', text: top.reasons.join(' · ') }),
      el('div', { class: 'row', style: { marginTop: '8px' } },
        el('button', { class: 'sc-button sc-button--primary sc-button--sm', text: 'Open it', onclick: () => { act.revealTask(top.taskId); act.selectTask(top.taskId); set({ view: 'gantt', rightOpen: true, rightTab: 'task' }); } }),
        el('button', { class: 'sc-button sc-button--sm', text: agendaOf(project, getTask(project, top.taskId)).show ? 'On the calendar' : 'Put on the calendar', onclick: () => act.editTask(top.taskId, 'calendarShow', true) }))));
  }

  pane.append(el('div', { class: 'sc-section-title', text: `Ready to work on (${ready.length})` }));
  const readyList = el('div', { class: 'pri-list' });
  ready.forEach((r, i) => readyList.append(row(r, i + 1)));
  pane.append(readyList);

  if (blocked.length) {
    pane.append(el('div', { class: 'sc-section-title', text: `Waiting on something else (${blocked.length})` }));
    const blockedList = el('div', { class: 'pri-list' });
    blocked.forEach((r, i) => blockedList.append(row(r, i + 1)));
    pane.append(blockedList);
  }
}
