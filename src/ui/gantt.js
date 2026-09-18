// The Gantt chart: the task grid on the left, the timeline on the right,
// scrolled together. `buildGanttSvg` draws the timeline for the screen and,
// with inline colours, for SVG / PNG / PDF export.

import { el, svg, clear } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { makeCalendar, toDay, fromDay, weekStart, monthStart, addMonths, MONTH_NAMES, WEEKDAY_NAMES, today, formatDate, formatDuration } from '../model/calendar.js';
import { formatPredecessors, formatAssignments, isSummary, taskIndex } from '../model/model.js';
import { renderGrid, ROW_H, HEAD_H, scrollRowIntoView } from './grid.js';
import { taskColumns, taskRows, gridHandlers } from './taskgrid.js';
import { showMenu } from './dialog.js';

export const ZOOMS = { day: { dw: 34, label: 'Days' }, week: { dw: 14, label: 'Weeks' }, month: { dw: 5, label: 'Months' } };
const ZOOM_ORDER = ['month', 'week', 'day'];
const GANTT_COLUMNS = ['id', 'ind', 'name', 'duration', 'start', 'finish', 'predecessors', 'resources'];

let scroll = { top: 0, left: 0 };
let pendingReveal = null;

export function zoomGantt(dir) {
  const i = ZOOM_ORDER.indexOf(store.ui.zoom);
  const next = ZOOM_ORDER[Math.max(0, Math.min(ZOOM_ORDER.length - 1, i + dir))];
  if (next !== store.ui.zoom) set({ zoom: next });
}
export function scrollToToday() { pendingReveal = { day: toDay(today()) }; set({}); }
export function scrollToTask(id) { pendingReveal = { task: id }; set({}); }

/** Days the chart spans: a little before the earliest start, a little after the latest finish. */
export function chartRange(project, sched, zoom) {
  const infos = Object.values(sched.tasks).filter((i) => !i.cyclic);
  const t = toDay(today());
  let from = Math.min(sched.start, t, ...infos.map((i) => i.start));
  let to = Math.max(sched.finish, t, ...infos.map((i) => i.finish), ...project.tasks.filter((x) => x.deadline).map((x) => toDay(x.deadline)));
  from = zoom === 'month' ? monthStart(from) : weekStart(from) - 7;
  to = Math.max(to + 21, from + 42);
  if (zoom === 'month') to = addMonths(to, 1) - 1;
  else to = weekStart(to) + 6;
  return { from, to };
}

/**
 * Draw the timeline. `rows`: [{ id }] in display order. `paint(kind)` gives
 * the attrs for each kind of mark (a class on screen, a fill for export).
 * Returns { header, body, width, height, dayX(day) }.
 */
export function buildGanttSvg(project, sched, rows, { zoom = 'day', from, to, paint, interactive = false, selected = new Set(), showLinks = true }) {
  const cal = makeCalendar(project.calendar);
  const dw = ZOOMS[zoom].dw;
  const days = to - from + 1;
  const width = days * dw;
  const height = rows.length * ROW_H + 8;
  const dayX = (d) => (d - from) * dw;
  const rowOf = new Map(rows.map((r, i) => [r.id, i]));
  const infoOf = (id) => sched.tasks[id];
  const P = paint;
  /** Paint plus a behaviour class the screen's CSS and drag code key off. */
  const PC = (cls, kind) => { const a = P(kind); return { ...a, class: [cls, a.class].filter(Boolean).join(' ') }; };

  // ---- header: two tiers
  const header = svg('svg', { class: 'gantt-head', width, height: HEAD_H, viewBox: `0 0 ${width} ${HEAD_H}` });
  header.append(svg('rect', { x: 0, y: 0, width, height: HEAD_H, ...P('head-bg') }));
  const tierTop = [], tierBot = [];
  if (zoom === 'month') {
    for (let d = monthStart(from); d <= to; d = addMonths(d, 1)) tierBot.push({ a: d, b: Math.min(to + 1, addMonths(d, 1)), label: MONTH_NAMES[new Date(d * 86400000).getUTCMonth()].slice(0, 3) });
    for (let y = new Date(from * 86400000).getUTCFullYear(); ; y++) {
      const a = Math.round(Date.UTC(y, 0, 1) / 86400000), b = Math.round(Date.UTC(y + 1, 0, 1) / 86400000);
      if (a > to) break;
      tierTop.push({ a: Math.max(a, from), b: Math.min(b, to + 1), label: String(y) });
    }
  } else {
    for (let d = monthStart(from); d <= to; d = addMonths(d, 1)) tierTop.push({ a: Math.max(d, from), b: Math.min(to + 1, addMonths(d, 1)), label: formatDate(fromDay(d), 'month') });
    if (zoom === 'day') for (let d = from; d <= to; d++) tierBot.push({ a: d, b: d + 1, label: String(new Date(d * 86400000).getUTCDate()), sub: WEEKDAY_NAMES[((d + 4) % 7 + 7) % 7][0], off: !cal.isWorking(d) });
    else for (let d = weekStart(from); d <= to; d += 7) tierBot.push({ a: Math.max(d, from), b: Math.min(to + 1, d + 7), label: formatDate(fromDay(d), 'day') });
  }
  for (const s of tierTop) {
    const x = dayX(s.a), w = (s.b - s.a) * dw;
    header.append(svg('line', { x1: x, y1: 0, x2: x, y2: HEAD_H, ...P('head-line') }));
    if (w > 30) header.append(svg('text', { x: x + 6, y: 15, ...P('head-text') }, s.label));
  }
  header.append(svg('line', { x1: 0, y1: 22, x2: width, y2: 22, ...P('head-line') }));
  for (const s of tierBot) {
    const x = dayX(s.a), w = (s.b - s.a) * dw;
    if (s.off) header.append(svg('rect', { x, y: 23, width: w, height: HEAD_H - 23, ...P('off') }));
    header.append(svg('line', { x1: x, y1: 22, x2: x, y2: HEAD_H, ...P('head-line') }));
    if (w >= 12) header.append(svg('text', { x: x + w / 2, y: zoom === 'day' ? 34 : 37, 'text-anchor': 'middle', ...P(zoom === 'day' ? 'head-day' : 'head-text') }, s.label));
    if (s.sub && w >= 24) header.append(svg('text', { x: x + w / 2, y: 42, 'text-anchor': 'middle', ...P('head-sub') }, s.sub));
  }
  header.append(svg('line', { x1: 0, y1: HEAD_H - 0.5, x2: width, y2: HEAD_H - 0.5, ...P('head-line') }));

  // ---- body
  const body = svg('svg', { class: 'gantt-body', width, height, viewBox: `0 0 ${width} ${height}` });
  body.append(svg('rect', { x: 0, y: 0, width, height, ...P('bg') }));
  // non-working days
  let runStart = null;
  for (let d = from; d <= to + 1; d++) {
    const off = d <= to && !cal.isWorking(d);
    if (off && runStart === null) runStart = d;
    if (!off && runStart !== null) { body.append(svg('rect', { x: dayX(runStart), y: 0, width: (d - runStart) * dw, height, ...P('off') })); runStart = null; }
  }
  // column lines (weeks at day/week zoom, months at month zoom)
  for (const s of (zoom === 'day' ? tierBot.filter((b) => ((b.a + 4) % 7 + 7) % 7 === 1) : tierBot)) body.append(svg('line', { x1: dayX(s.a), y1: 0, x2: dayX(s.a), y2: height, ...P('grid') }));
  // row lines
  for (let r = 0; r <= rows.length; r++) body.append(svg('line', { x1: 0, y1: r * ROW_H + 0.5, x2: width, y2: r * ROW_H + 0.5, ...P('row') }));
  // today
  const tday = toDay(today());
  if (tday >= from && tday <= to) body.append(svg('line', { x1: dayX(tday) + dw / 2, y1: 0, x2: dayX(tday) + dw / 2, y2: height, ...P('today') }));
  // status date
  if (project.statusDate) { const sd = toDay(project.statusDate); if (sd >= from && sd <= to) body.append(svg('line', { x1: dayX(sd) + dw / 2, y1: 0, x2: dayX(sd) + dw / 2, y2: height, ...P('status') })); }

  const barBox = (info) => ({ x: dayX(info.start), w: Math.max(dw, (info.finish - info.start + 1) * dw), y: rowOf.get(info.id) * ROW_H });
  const links = svg('g', { class: 'g-links' });
  const bars = svg('g', { class: 'g-bars' });
  const labels = svg('g', { class: 'g-labels' });

  for (const row of rows) {
    const task = project.tasks[taskIndex(project, row.id)];
    const info = infoOf(row.id);
    if (!info || info.cyclic) continue;
    const { x, w, y } = barBox(info);
    const g = svg('g', { class: `g-task${selected.has(row.id) ? ' is-sel' : ''}${info.critical ? ' is-critical' : ''}`, dataset: { id: row.id } });
    const tip = `${info.index} ${task.name}\n${formatDate(info.startIso)} – ${formatDate(info.finishIso)} · ${formatDuration(info.duration)}${info.summary ? '' : ` · slack ${info.slack}d`}\n${info.percent}% complete${task.assignments.length ? ` · ${formatAssignments(project, task)}` : ''}`;
    if (info.summary) {
      const yb = y + 7;
      g.append(svg('path', { d: `M${x},${yb} H${x + w} V${yb + 6} L${x + w - 5},${yb + 12} L${x + w - 5},${yb + 6} H${x + 5} L${x + 5},${yb + 12} L${x},${yb + 6} Z`, ...P('summary') }));
      if (info.percent) g.append(svg('rect', { x, y: yb + 1, width: w * info.percent / 100, height: 4, ...P('summary-done') }));
    } else if (info.milestone) {
      const cx = x + dw / 2, cy = y + ROW_H / 2;
      g.append(svg('path', { d: `M${cx},${cy - 8} L${cx + 8},${cy} L${cx},${cy + 8} L${cx - 8},${cy} Z`, ...P(info.percent === 100 ? 'milestone-done' : 'milestone') }));
      labels.append(svg('text', { x: cx + 12, y: cy + 4, ...P('label') }, `${task.name}${formatDate(info.startIso, 'day') ? `  ${formatDate(info.startIso, 'day')}` : ''}`));
    } else {
      const yb = y + 6, h = ROW_H - 12;
      g.append(svg('rect', { x, y: yb, width: w, height: h, dataset: { part: 'move' }, ...PC('g-bar', info.critical ? 'bar-critical' : 'bar') }));
      if (info.percent) g.append(svg('rect', { x: x + 1, y: yb + h / 2 - 2, width: Math.max(0, (w - 2) * info.percent / 100), height: 4, dataset: { part: 'move' }, ...PC('g-done', 'done') }));
      if (interactive) {
        g.append(svg('rect', { class: 'g-resize', x: x + w - 6, y: yb, width: 6, height: h, dataset: { part: 'resize' }, fill: 'transparent' }));
        g.append(svg('circle', { cx: x + w + 7, cy: yb + h / 2, r: 4.5, dataset: { part: 'link' }, ...PC('g-linkdot', 'linkdot') }));
      }
      const names = formatAssignments(project, task);
      if (names) labels.append(svg('text', { x: x + w + (interactive ? 16 : 6), y: yb + h / 2 + 4, ...P('label') }, names));
    }
    if (task.deadline) {
      const dx = dayX(toDay(task.deadline)) + dw / 2, cy = y + ROW_H / 2;
      g.append(svg('path', { d: `M${dx},${cy + 7} L${dx - 6},${cy - 5} H${dx + 6} Z`, ...P(info.deadlineMissed ? 'deadline-missed' : 'deadline') }, svg('title', {}, `Deadline ${formatDate(task.deadline)}`)));
    }
    g.append(svg('title', {}, tip));
    bars.append(g);
  }

  // dependency arrows
  if (showLinks) for (const row of rows) {
    const task = project.tasks[taskIndex(project, row.id)];
    const s = infoOf(row.id);
    if (!s || s.cyclic) continue;
    for (const l of task.predecessors) {
      const p = infoOf(l.id);
      if (!p || p.cyclic || !rowOf.has(l.id)) continue;
      const pb = barBox(p), sb = barBox(s);
      const fromEnd = l.type[0] === 'F', toStart = l.type[1] === 'S';
      const sx = fromEnd ? pb.x + (p.milestone ? dw / 2 + 8 : pb.w) : pb.x + (p.milestone ? dw / 2 - 8 : 0);
      const sy = pb.y + ROW_H / 2;
      const ex = toStart ? sb.x + (s.milestone ? dw / 2 - 8 : 0) : sb.x + (s.milestone ? dw / 2 + 8 : sb.w);
      const ey = sb.y + ROW_H / 2;
      const down = ey > sy ? 1 : -1;
      let d;
      if (toStart) {
        if (fromEnd && sx + 10 <= ex - 2) d = `M${sx},${sy} H${sx + 8} V${ey} H${ex - 1}`;
        else if (!fromEnd) d = `M${sx},${sy} H${Math.min(sx, ex) - 8} V${ey} H${ex - 1}`;
        else d = `M${sx},${sy} H${sx + 8} V${sy + down * (ROW_H / 2)} H${ex - 8} V${ey} H${ex - 1}`;
      } else {
        const bend = Math.max(sx, ex) + 8;
        d = fromEnd ? `M${sx},${sy} H${bend} V${ey} H${ex + 1}` : `M${sx},${sy} H${sx - 8} V${sy + down * (ROW_H / 2)} H${bend} V${ey} H${ex + 1}`;
      }
      const arrow = toStart ? `M${ex},${ey} l-6,-4 v8 Z` : `M${ex},${ey} l6,-4 v8 Z`;
      const critical = p.critical && s.critical;
      links.append(svg('g', { class: 'g-link', dataset: { from: l.id, to: row.id } },
        svg('path', { d, fill: 'none', ...P(critical ? 'link-critical' : 'link') }),
        svg('path', { d: arrow, ...P(critical ? 'arrow-critical' : 'arrow') }),
        svg('title', {}, `${p.index} → ${s.index} ${l.type}${l.lag ? ` ${l.lag > 0 ? '+' : ''}${l.lag}d` : ''}`)));
    }
  }
  body.append(links, bars, labels);
  return { header, body, width, height, dayX, dw, from, to };
}

/** Screen paint: classes styled in styles.css. */
const screenPaint = (kind) => ({ class: `gk-${kind}` });

// ---------------------------------------------------------------- the view

export function renderGantt(root) {
  const { project, schedule, ui } = store;
  const rows = act.visibleTasks().map((t) => ({ id: t.id }));
  const cal = makeCalendar(project.calendar);

  clear(root);
  const left = el('div', { class: 'gantt-grid', style: { width: `${ui.split}px` } });
  const splitter = el('div', { class: 'gantt-split' });
  const right = el('div', { class: 'gantt-chart' });
  root.append(left, splitter, right);

  renderGrid(left, { ...gridHandlers(), columns: taskColumns(GANTT_COLUMNS), rows: taskRows(rows.map((r) => r.id)), selected: new Set(ui.selection), activeId: act.activeId(), activeCol: ui.activeCol, editing: ui.editing?.kind === 'task' ? ui.editing : null, onAppend: () => { set({ selection: [] }); act.newTaskBelow(); } });

  const { from, to } = chartRange(project, schedule, ui.zoom);
  const built = buildGanttSvg(project, schedule, rows, { zoom: ui.zoom, from, to, paint: screenPaint, interactive: true, selected: new Set(ui.selection) });
  const headWrap = el('div', { class: 'gantt-headwrap' }, built.header);
  right.append(headWrap, built.body);
  // The grid's own header keeps the row tops aligned with the chart's.
  left.style.setProperty('--head-h', `${HEAD_H}px`);

  // scroll sync and memory
  let syncing = false;
  const sync = (src, dst) => () => { if (syncing) return; syncing = true; dst.scrollTop = src.scrollTop; scroll = { top: src.scrollTop, left: right.scrollLeft }; syncing = false; };
  left.addEventListener('scroll', sync(left, right));
  right.addEventListener('scroll', sync(right, left));
  requestAnimationFrame(() => {
    right.scrollLeft = scroll.left; right.scrollTop = scroll.top; left.scrollTop = scroll.top;
    if (pendingReveal) {
      const day = pendingReveal.day ?? (schedule.tasks[pendingReveal.task] ? schedule.tasks[pendingReveal.task].start : null);
      if (day !== null && day !== undefined) right.scrollLeft = Math.max(0, built.dayX(day) - right.clientWidth / 3);
      if (pendingReveal.task) scrollRowIntoView(left, pendingReveal.task);
      pendingReveal = null;
    } else if (act.activeId() && ui.editing) scrollRowIntoView(left, act.activeId());
  });

  // splitter
  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = ui.split;
    const move = (ev) => { left.style.width = `${Math.max(200, Math.min(root.clientWidth - 200, w0 + ev.clientX - x0))}px`; };
    const up = (ev) => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); set({ split: Math.max(200, Math.min(root.clientWidth - 200, w0 + ev.clientX - x0)) }); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });

  // zoom with ⌘/Ctrl + wheel
  right.addEventListener('wheel', (e) => { if (e.metaKey || e.ctrlKey) { e.preventDefault(); zoomGantt(e.deltaY < 0 ? 1 : -1); } }, { passive: false });

  // bar interactions
  const body = built.body;
  body.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('.g-task');
    if (!g || e.button !== 0) return;
    const id = g.dataset.id;
    const part = e.target.dataset.part;
    const pick = () => act.selectTask(id, { extend: e.metaKey || e.ctrlKey, range: e.shiftKey });
    // Selecting re-renders the chart, which would drop a drag in progress: a
    // bar is selected when the pointer comes up, not when it goes down.
    if (!part) { pick(); return; }
    const info = schedule.tasks[id];
    e.preventDefault();
    body.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const bar = g.querySelector('.g-bar');
    const done = g.querySelector('.g-done');
    const bx = +bar.getAttribute('x'), bw = +bar.getAttribute('width');
    let ghost = null, dx = 0, target = null;
    if (part === 'link') {
      ghost = svg('line', { class: 'g-rubber', x1: bx + bw, y1: +bar.getAttribute('y') + 7, x2: bx + bw, y2: +bar.getAttribute('y') + 7 });
      body.append(ghost);
    }
    const move = (ev) => {
      dx = ev.clientX - x0;
      if (part === 'move') { g.setAttribute('transform', `translate(${Math.round(dx / built.dw) * built.dw},0)`); g.classList.add('is-drag'); }
      else if (part === 'resize') { const w = Math.max(built.dw, bw + Math.round(dx / built.dw) * built.dw); bar.setAttribute('width', w); if (done) done.setAttribute('width', Math.max(0, (w - 2) * info.percent / 100)); g.classList.add('is-drag'); }
      else if (part === 'link') {
        const r = body.getBoundingClientRect();
        ghost.setAttribute('x2', ev.clientX - r.left); ghost.setAttribute('y2', ev.clientY - r.top);
        const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.g-task');
        body.querySelectorAll('.g-task.is-target').forEach((n) => n.classList.remove('is-target'));
        target = over && over.dataset.id !== id ? over.dataset.id : null;
        if (target) over.classList.add('is-target');
      }
    };
    const up = () => {
      body.removeEventListener('pointermove', move); body.removeEventListener('pointerup', up); body.removeEventListener('pointercancel', up);
      const days = Math.round(dx / built.dw);
      if (!ui.selection.includes(id) && !(e.metaKey || e.ctrlKey || e.shiftKey)) set({ selection: [id] });
      if (part === 'move' && days !== 0) {
        const nd = days > 0 ? cal.next(info.start + days) : cal.prev(info.start + days);
        act.pinStart(id, fromDay(nd));
      } else if (part === 'resize' && days !== 0) {
        act.setDuration(id, Math.max(1, cal.between(info.start, Math.max(info.start, info.finish + days))));
      } else if (part === 'link' && target) act.linkTasks(id, target);
      else { pick(); set({}); } // a plain click: select, and redraw without the ghost
    };
    body.addEventListener('pointermove', move); body.addEventListener('pointerup', up); body.addEventListener('pointercancel', up);
  });
  body.addEventListener('dblclick', (e) => {
    const g = e.target.closest('.g-task');
    if (g) { set({ rightOpen: true, rightTab: 'task', selection: [g.dataset.id] }); }
  });
  body.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const g = e.target.closest('.g-task');
    const lk = e.target.closest('.g-link');
    if (lk) {
      showMenu(e.clientX, e.clientY, [{ label: 'Remove this link', danger: true, run: () => act.unlinkTasks(lk.dataset.from, lk.dataset.to) }]);
    } else if (g) {
      if (!ui.selection.includes(g.dataset.id)) act.selectTask(g.dataset.id);
      gridHandlers().onContext(g.dataset.id, e);
    }
  });
}
