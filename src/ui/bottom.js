// The bottom panel: checks over the plan, and project statistics.

import { el, clear, formatMoney, formatHours } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { RULES } from '../model/validate.js';
import { formatDate } from '../model/calendar.js';
import { lateness, lateSentence } from './calendar.js';

/**
 * What the calendar says will be late, as checks. These are not the plan's
 * own arithmetic — the schedule can meet a deadline that a person's week, laid
 * out beside every other project, cannot — so they come from the calendar's
 * layout rather than from validate().
 */
function lateChecks() {
  let list = [];
  try { list = lateness(); } catch { list = []; }
  return list.map((l) => ({
    level: 'error', code: 'will-be-late', taskId: l.taskId, planId: l.planId,
    text: `${lateSentence(l)}${l.planId !== store.project.id ? ` (${l.planName})` : ''}`,
  }));
}

export function checkBadge() {
  const late = lateChecks();
  const n = store.issues.filter((i) => i.level !== 'info').length + late.length;
  if (!n) return null;
  return { text: String(n), alert: late.length > 0 || store.issues.some((i) => i.level === 'error'), title: `${n} checks need attention` };
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
  const all = [...lateChecks(), ...issues];
  if (!all.length) { root.append(el('p', { class: 'empty', text: 'No issues. The plan schedules cleanly.' })); return; }
  root.append(el('table', { class: 'sc-table compact' }, el('tbody', {}, ...all.map((i) => el('tr', {
    class: 'clickable', title: i.code === 'will-be-late' ? 'At the rate the calendar can fit it in, this task finishes after its deadline.' : RULES[i.code][1],
    onclick: async () => {
      if (i.planId && i.planId !== store.project.id) {
        const { openPlan } = await import('../state/sync.js');
        if (!(await openPlan(i.planId))) return;
      }
      if (i.taskId) { if (!['gantt', 'sheet', 'network'].includes(ui.view)) set({ view: 'gantt' }); act.revealTask(i.taskId); act.selectTask(i.taskId); }
      else if (i.resourceId) set({ resourceId: i.resourceId, view: ui.view === 'usage' ? 'usage' : 'resources' });
    },
  }, el('td', {}, el('span', { class: 'sc-pill', style: { '--tint': `var(--sc-${i.level === 'error' ? 'danger' : i.level === 'warning' ? 'warning' : 'info'})` }, text: i.level })),
    el('td', { class: 'sc-mono sc-muted', text: i.code }), el('td', { text: i.text }))))));
}
