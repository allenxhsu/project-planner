// Resource Sheet (edit the people and things) and Resource Usage (hours per week).

import { el, clear, formatMoney, formatHours } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { RESOURCE_TYPES } from '../model/model.js';
import { resourceLoad } from '../model/schedule.js';
import { weekStart, fromDay, formatDate, makeCalendar } from '../model/calendar.js';
import { renderGrid } from './grid.js';
import { showMenu } from './dialog.js';

export const RESOURCE_COLUMNS = [
  { key: 'id', label: '#', width: 40, align: 'right', readonly: true },
  { key: 'ind', label: '', width: 34, readonly: true },
  { key: 'name', label: 'Resource Name', width: 200, edit: 'text' },
  { key: 'initials', label: 'Initials', width: 70, edit: 'text' },
  { key: 'type', label: 'Type', width: 90, edit: 'select', options: Object.entries(RESOURCE_TYPES).map(([value, label]) => ({ value, label })) },
  { key: 'maxUnits', label: 'Max Units', width: 84, edit: 'text', align: 'right' },
  { key: 'rate', label: 'Std Rate', width: 90, edit: 'text', align: 'right' },
  { key: 'group', label: 'Group', width: 160, edit: 'text' },
  { key: 'tasks', label: 'Tasks', width: 60, readonly: true, align: 'right' },
  { key: 'work', label: 'Work', width: 80, readonly: true, align: 'right' },
  { key: 'cost', label: 'Cost', width: 100, readonly: true, align: 'right' },
];
const editableKeys = RESOURCE_COLUMNS.filter((c) => c.edit).map((c) => c.key);

function resourceTotals() {
  const { project, schedule } = store;
  const totals = new Map(project.resources.map((r) => [r.id, { tasks: 0, work: 0, cost: 0 }]));
  for (const t of project.tasks) {
    const s = schedule.tasks[t.id];
    if (s.summary) continue;
    for (const a of t.assignments) {
      const r = project.resources.find((x) => x.id === a.resourceId);
      const tot = totals.get(a.resourceId);
      if (!r || !tot) continue;
      tot.tasks++;
      if (r.type === 'work') { const h = s.duration * project.calendar.hoursPerDay * a.units; tot.work += h; tot.cost += h * r.rate; }
      else if (r.type === 'material') tot.cost += a.units * r.rate;
      else tot.cost += a.units;
    }
  }
  return totals;
}

export function renderResourceSheet(root) {
  const { project, ui, issues } = store;
  clear(root);
  const pane = el('div', { class: 'sheet-pane' });
  root.append(pane);
  const totals = resourceTotals();
  const rows = project.resources.map((r, i) => {
    const over = issues.find((x) => x.code === 'overallocated' && x.resourceId === r.id);
    const t = totals.get(r.id);
    return {
      id: r.id, class: over ? 'is-over' : '',
      cells: {
        id: i + 1, ind: over ? el('span', { class: 'ind ind-warning', text: '⚠', title: over.text }) : '', name: r.name, initials: r.initials, type: RESOURCE_TYPES[r.type],
        maxUnits: r.type === 'work' ? `${Math.round(r.maxUnits * 100)}%` : '', rate: r.type === 'cost' ? '' : `${formatMoney(r.rate, project.currency)}${r.type === 'work' ? '/h' : ''}`, group: r.group,
        tasks: t.tasks || '', work: t.work ? formatHours(t.work) : '', cost: t.cost ? formatMoney(t.cost, project.currency) : '',
      },
      raw: { name: r.name, initials: r.initials, type: r.type, maxUnits: String(Math.round(r.maxUnits * 100)), rate: String(r.rate), group: r.group },
    };
  });
  const rowOf = (id) => rows.find((r) => r.id === id);
  renderGrid(pane, {
    columns: RESOURCE_COLUMNS, rows, selected: new Set(ui.resourceId ? [ui.resourceId] : []), activeId: ui.resourceId, activeCol: ui.activeCol,
    editing: ui.editing?.kind === 'resource' ? ui.editing : null,
    onSelect: (id) => set({ resourceId: id, rightTab: 'resource' }),
    onCell: (id, col) => {
      if (ui.editing) return;
      if (ui.resourceId === id && ui.activeCol === col && editableKeys.includes(col)) set({ editing: { kind: 'resource', id, col } });
      else set({ activeCol: col });
    },
    onEdit: (id, col) => set({ resourceId: id, activeCol: col, editing: { kind: 'resource', id, col } }),
    onCommit: (id, col, value, { next }) => {
      const unchanged = String(value) === String(rowOf(id)?.raw[col] ?? '');
      if (!unchanged && !act.editResource(id, col, value)) { set({ editing: { kind: 'resource', id, col, seed: value } }); return; }
      set({ editing: null });
      const i = project.resources.findIndex((r) => r.id === id);
      if (next === 'down' && project.resources[i + 1]) set({ resourceId: project.resources[i + 1].id });
      else if (next === 'up' && project.resources[i - 1]) set({ resourceId: project.resources[i - 1].id });
      else if (next === 'right' || next === 'left') { const k = editableKeys[editableKeys.indexOf(col) + (next === 'right' ? 1 : -1)]; if (k) set({ activeCol: k }); }
    },
    onCancel: () => set({ editing: null }),
    onContext: (id, e) => {
      set({ resourceId: id });
      showMenu(e.clientX, e.clientY, [
        { label: 'Resource information…', run: () => set({ rightOpen: true, rightTab: 'resource' }) }, '-',
        { label: 'New resource', run: act.newResource }, '-',
        { label: 'Delete resource', danger: true, run: () => act.deleteResource(id) },
      ]);
    },
    onAppend: act.newResource, appendLabel: '+ New resource',
  });
}

export function renderResourceUsage(root) {
  const { project, schedule, ui } = store;
  clear(root);
  const pane = el('div', { class: 'sheet-pane usage-pane' });
  root.append(pane);
  if (!project.resources.length) { pane.append(el('div', { class: 'empty-note sc-muted', text: 'No resources yet. Add them in the Resource Sheet, or type names into a task’s Resource Names cell.' })); return; }
  const cal = makeCalendar(project.calendar);
  const load = resourceLoad(project, schedule);
  const weeks = [];
  for (let d = weekStart(schedule.start); d <= schedule.finish; d += 7) weeks.push(d);
  const table = el('table', { class: 'grid usage' });
  table.append(el('thead', {}, el('tr', {}, el('th', { text: 'Resource / Task' }), el('th', { class: 'num', text: 'Work' }), ...weeks.map((w) => el('th', { class: 'num week', text: formatDate(fromDay(w), 'day') })))));
  const body = el('tbody');
  const hoursIn = (days, w, filterTask) => {
    let h = 0, over = false;
    for (let d = w; d < w + 7; d++) {
      const items = days.get(d);
      if (!items) continue;
      const units = items.reduce((s, x) => s + x.units, 0);
      for (const it of items) if (!filterTask || it.taskId === filterTask) h += it.hours;
      if (!filterTask && units > 1e-9) over = over || units > (project.resources.find((r) => days === load.get(r.id))?.maxUnits ?? 1) + 1e-9;
    }
    return { h, over };
  };
  for (const r of project.resources) {
    const days = load.get(r.id);
    let total = 0;
    for (const items of days.values()) for (const it of items) total += it.hours;
    const tr = el('tr', { class: `is-summary${ui.resourceId === r.id ? ' is-sel' : ''}`, onpointerdown: () => set({ resourceId: r.id, rightTab: 'resource' }) },
      el('td', {}, el('span', { class: 'cell-text', text: r.name })), el('td', { class: 'num', text: r.type === 'work' ? formatHours(total) : '' }));
    for (const w of weeks) {
      const { h, over } = hoursIn(days, w, null);
      tr.append(el('td', { class: `num${over ? ' is-over' : ''}`, text: h ? formatHours(h) : '' }));
    }
    body.append(tr);
    const tasks = project.tasks.filter((t) => t.assignments.some((a) => a.resourceId === r.id) && !schedule.tasks[t.id].summary);
    for (const t of tasks) {
      const s = schedule.tasks[t.id];
      const a = t.assignments.find((x) => x.resourceId === r.id);
      const th = r.type === 'work' ? s.duration * cal.hoursPerDay * a.units : 0;
      const tr2 = el('tr', { class: ui.selection.includes(t.id) ? 'is-sel' : '', onpointerdown: (e) => act.selectTask(t.id, { extend: e.metaKey || e.ctrlKey }) },
        el('td', { style: { paddingLeft: '28px' } }, el('span', { class: 'cell-text', text: `${s.index} ${t.name}${a.units !== 1 ? ` [${Math.round(a.units * 100)}%]` : ''}` })),
        el('td', { class: 'num', text: th ? formatHours(th) : '' }));
      for (const w of weeks) { const { h } = hoursIn(days, w, t.id); tr2.append(el('td', { class: 'num', text: h ? formatHours(h) : '' })); }
      body.append(tr2);
    }
  }
  table.append(body);
  pane.append(table);
}
