// The bottom panel: checks over the plan, and project statistics.

import { el, clear, formatMoney, formatHours } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { RULES } from '../model/validate.js';
import { formatDate } from '../model/calendar.js';

export function checkBadge() {
  const n = store.issues.filter((i) => i.level !== 'info').length;
  if (!n) return null;
  return { text: String(n), alert: store.issues.some((i) => i.level === 'error'), title: `${n} checks need attention` };
}

export function renderBottom(root) {
  const { ui, issues, project, schedule } = store;
  clear(root);
  if (ui.bottomTab === 'stats') {
    const rows = [
      ['Start', formatDate(schedule.startIso, 'long')], ['Finish', formatDate(schedule.finishIso, 'long')], ['Duration', `${schedule.duration} working days`],
      ['Work', formatHours(schedule.work)], ['Cost', formatMoney(schedule.cost, project.currency)], ['Complete', `${schedule.percent}%`],
      ['Tasks', `${project.tasks.length} (${Object.values(schedule.tasks).filter((t) => t.summary).length} summaries, ${Object.values(schedule.tasks).filter((t) => t.milestone).length} milestones)`],
      ['Critical tasks', String(schedule.criticalCount)], ['Resources', String(project.resources.length)],
      ['Working days', project.calendar.workDays.map((d) => ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][d]).join(' ')], ['Hours per day', String(project.calendar.hoursPerDay)], ['Holidays', String(project.calendar.holidays.length)],
    ];
    root.append(el('table', { class: 'sc-table compact stats' }, el('tbody', {}, ...rows.map(([k, v]) => el('tr', {}, el('td', { class: 'sc-muted', text: k }), el('td', { text: v }))))));
    return;
  }
  if (!issues.length) { root.append(el('p', { class: 'empty', text: 'No issues. The plan schedules cleanly.' })); return; }
  root.append(el('table', { class: 'sc-table compact' }, el('tbody', {}, ...issues.map((i) => el('tr', {
    class: 'clickable', title: RULES[i.code][1],
    onclick: () => {
      if (i.taskId) { if (!['gantt', 'sheet', 'network'].includes(ui.view)) set({ view: 'gantt' }); act.revealTask(i.taskId); act.selectTask(i.taskId); set({ rightTab: 'task' }); }
      else if (i.resourceId) set({ resourceId: i.resourceId, rightTab: 'resource', view: ui.view === 'usage' ? 'usage' : 'resources' });
    },
  }, el('td', {}, el('span', { class: 'sc-pill', style: { '--tint': `var(--sc-${i.level === 'error' ? 'danger' : i.level === 'warning' ? 'warning' : 'info'})` }, text: i.level })),
    el('td', { class: 'sc-mono sc-muted', text: i.code }), el('td', { text: i.text }))))));
}
