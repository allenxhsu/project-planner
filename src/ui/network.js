// The network (PERT) diagram: one box per task, columns by dependency depth,
// arrows for links, the critical path in red.

import { el, svg, clear } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { networkRanks } from '../model/schedule.js';
import { formatDate, formatDuration } from '../model/calendar.js';
import { taskIndex } from '../model/model.js';

const BOX_W = 196, BOX_H = 84, GAP_X = 64, GAP_Y = 18, PAD = 30;
let scale = 1;
let scroll = { left: 0, top: 0 };

export function zoomNetwork(dir) { scale = Math.max(0.3, Math.min(2, scale * (dir > 0 ? 1.2 : 1 / 1.2))); set({}); }

export function renderNetwork(root) {
  const { project, schedule, ui } = store;
  clear(root);
  const pane = el('div', { class: 'network-pane sc-hexgrid' });
  root.append(pane);
  const leaves = project.tasks.filter((t) => !schedule.tasks[t.id].summary && !schedule.tasks[t.id].cyclic);
  if (!leaves.length) { pane.append(el('div', { class: 'empty-note sc-muted', text: 'No tasks yet. Add some in the Gantt chart.' })); return; }
  const ranks = networkRanks(project, schedule);
  const cols = new Map();
  for (const t of leaves) { const r = ranks.get(t.id) || 0; if (!cols.has(r)) cols.set(r, []); cols.get(r).push(t); }
  const pos = new Map();
  let maxRows = 0;
  for (const [r, list] of cols) { list.forEach((t, i) => pos.set(t.id, { x: PAD + r * (BOX_W + GAP_X), y: PAD + i * (BOX_H + GAP_Y) })); maxRows = Math.max(maxRows, list.length); }
  const w = PAD * 2 + (Math.max(...cols.keys()) + 1) * (BOX_W + GAP_X);
  const h = PAD * 2 + maxRows * (BOX_H + GAP_Y);
  const root$ = svg('svg', { class: 'network', width: w * scale, height: h * scale, viewBox: `0 0 ${w} ${h}` });
  const edges = svg('g'), boxes = svg('g');
  for (const t of leaves) {
    const s = schedule.tasks[t.id];
    const p = pos.get(t.id);
    for (const l of collectLinks(project, t)) {
      const q = pos.get(l.id);
      if (!q) continue;
      const src = schedule.tasks[l.id];
      const x1 = q.x + BOX_W, y1 = q.y + BOX_H / 2, x2 = p.x, y2 = p.y + BOX_H / 2;
      const c = Math.max(30, (x2 - x1) / 2);
      const critical = s.critical && src.critical;
      edges.append(svg('g', { class: `n-link${critical ? ' is-critical' : ''}` },
        svg('path', { d: `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`, fill: 'none' }),
        svg('path', { d: `M${x2},${y2} l-8,-5 v10 Z`, class: 'n-arrow' }),
        svg('title', {}, `${src.index} → ${s.index} ${l.type}${l.lag ? ` ${l.lag > 0 ? '+' : ''}${l.lag}d` : ''}`)));
    }
    const g = svg('g', { class: `n-box${s.critical ? ' is-critical' : ''}${ui.selection.includes(t.id) ? ' is-sel' : ''}${s.milestone ? ' is-milestone' : ''}`, transform: `translate(${p.x},${p.y})`, dataset: { id: t.id } });
    g.append(svg('rect', { x: 0, y: 0, width: BOX_W, height: BOX_H, class: 'n-shape' }));
    g.append(svg('rect', { x: 0, y: 0, width: BOX_W, height: 24, class: 'n-head' }));
    g.append(svg('text', { x: 8, y: 16, class: 'n-title' }, trim(t.name, 26)));
    g.append(svg('text', { x: BOX_W - 8, y: 16, class: 'n-id', 'text-anchor': 'end' }, `#${s.index}`));
    g.append(svg('text', { x: 8, y: 42, class: 'n-text' }, `${formatDate(s.startIso, 'day')} – ${formatDate(s.finishIso, 'day')}`));
    g.append(svg('text', { x: 8, y: 58, class: 'n-text' }, `${s.milestone ? 'Milestone' : formatDuration(s.duration)} · slack ${s.slack}d`));
    g.append(svg('rect', { x: 8, y: 68, width: BOX_W - 16, height: 6, class: 'n-meter' }));
    if (s.percent) g.append(svg('rect', { x: 8, y: 68, width: (BOX_W - 16) * s.percent / 100, height: 6, class: 'n-meter-fill' }));
    g.append(svg('title', {}, `${t.name}\n${formatDate(s.startIso)} – ${formatDate(s.finishIso)}\n${s.percent}% complete`));
    boxes.append(g);
  }
  root$.append(edges, boxes);
  pane.append(root$);
  root$.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('.n-box');
    if (g && e.button === 0) act.selectTask(g.dataset.id, { extend: e.metaKey || e.ctrlKey, range: e.shiftKey });
  });
  root$.addEventListener('dblclick', (e) => { const g = e.target.closest('.n-box'); if (g) { set({ selection: [g.dataset.id] }); void import('./blockmenu.js').then((m) => m.taskSheet({ taskId: g.dataset.id })); } });
  pane.addEventListener('wheel', (e) => { if (e.metaKey || e.ctrlKey) { e.preventDefault(); zoomNetwork(e.deltaY < 0 ? 1 : -1); } }, { passive: false });
  pane.addEventListener('scroll', () => { scroll = { left: pane.scrollLeft, top: pane.scrollTop }; });
  requestAnimationFrame(() => { pane.scrollLeft = scroll.left; pane.scrollTop = scroll.top; });
}

/** A task's links plus those inherited from its summaries, pointing at leaves. */
function collectLinks(project, t) {
  const i = taskIndex(project, t.id);
  const out = [...t.predecessors];
  let lvl = t.level;
  for (let j = i - 1; j >= 0 && lvl > 1; j--) if (project.tasks[j].level < lvl) { lvl = project.tasks[j].level; out.push(...project.tasks[j].predecessors); }
  // a link from a summary stands for its last-finishing leaf
  const { schedule } = store;
  return out.map((l) => {
    const s = schedule.tasks[l.id];
    if (!s?.summary) return l;
    let best = null;
    const walk = (id) => { const x = schedule.tasks[id]; if (x.summary) x.children.forEach(walk); else if (!best || x.finish > schedule.tasks[best].finish) best = id; };
    walk(l.id);
    return best ? { ...l, id: best } : l;
  });
}
const trim = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
