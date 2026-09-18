// The Gantt chart as a picture: SVG, PNG, or PDF (vector, through the macOS
// app; the browser prints it). Drawn on paper colours, not the screen theme.

import { svg, downloadText, downloadBlob, slugify, escapeXml } from '../util.js';
import { store } from '../state/store.js';
import { visibleTasks } from '../state/actions.js';
import { buildGanttSvg, chartRange } from '../ui/gantt.js';
import { ROW_H, HEAD_H } from '../ui/grid.js';
import { formatDate, formatDuration } from '../model/calendar.js';
import { hosted, post } from '../host.js';

const FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif';
const PAPER = {
  'head-bg': { fill: '#f3f5f7' }, 'head-line': { stroke: '#cdd4db', 'stroke-width': 1 },
  'head-text': { fill: '#1c2733', 'font-size': 11, 'font-weight': 700 }, 'head-day': { fill: '#1c2733', 'font-size': 10 }, 'head-sub': { fill: '#8a96a3', 'font-size': 8 },
  bg: { fill: '#ffffff' }, off: { fill: '#eef1f4' }, grid: { stroke: '#dfe5ea' }, row: { stroke: '#eceff2' },
  today: { stroke: '#e0891a', 'stroke-dasharray': '4 3', 'stroke-width': 1.5 }, status: { stroke: '#3b82c4', 'stroke-dasharray': '2 3', 'stroke-width': 1.5 },
  summary: { fill: '#1c2733' }, 'summary-done': { fill: '#6aa8e6' }, milestone: { fill: '#1c2733' }, 'milestone-done': { fill: '#2a9d5c' },
  bar: { fill: '#5b9be2', stroke: '#2b6cb0' }, 'bar-critical': { fill: '#e26060', stroke: '#b23a3a' }, done: { fill: '#12324f' },
  linkdot: { fill: 'none' }, label: { fill: '#1c2733', 'font-size': 11 },
  link: { stroke: '#5a6672', 'stroke-width': 1.2 }, 'link-critical': { stroke: '#c0392b', 'stroke-width': 1.4 }, arrow: { fill: '#5a6672' }, 'arrow-critical': { fill: '#c0392b' },
  deadline: { fill: '#2a9d5c' }, 'deadline-missed': { fill: '#c0392b' },
};
const paint = (kind) => ({ ...(PAPER[kind] || {}) });

const COLS = [['#', 36, 'end'], ['Task name', 250, 'start'], ['Duration', 64, 'end'], ['Start', 84, 'start'], ['Finish', 84, 'start']];
const LEFT_W = COLS.reduce((s, c) => s + c[1], 0);
const TITLE_H = 34;

/** The whole chart — table and timeline — as one standalone SVG element. */
export function ganttDocument() {
  const { project, schedule, ui } = store;
  const rows = visibleTasks().map((t) => ({ id: t.id }));
  const { from, to } = chartRange(project, schedule, ui.zoom);
  const built = buildGanttSvg(project, schedule, rows, { zoom: ui.zoom, from, to, paint, interactive: false });
  const width = LEFT_W + built.width;
  const height = TITLE_H + HEAD_H + built.height;
  const doc = svg('svg', { xmlns: 'http://www.w3.org/2000/svg', width, height, viewBox: `0 0 ${width} ${height}`, 'font-family': FONT, 'font-size': 12 });
  doc.append(svg('rect', { x: 0, y: 0, width, height, fill: '#fff' }));
  doc.append(svg('text', { x: 10, y: 22, 'font-size': 15, 'font-weight': 700, fill: '#1c2733' }, project.name));
  doc.append(svg('text', { x: width - 10, y: 22, 'text-anchor': 'end', 'font-size': 10, fill: '#8a96a3' }, `${formatDate(schedule.startIso)} – ${formatDate(schedule.finishIso)} · ${schedule.duration} working days · ${schedule.percent}% complete`));
  // the table
  const tbl = svg('g', { transform: `translate(0,${TITLE_H})` });
  tbl.append(svg('rect', { x: 0, y: 0, width: LEFT_W, height: HEAD_H, fill: '#f3f5f7' }));
  let x = 0;
  for (const [label, w, anchor] of COLS) {
    tbl.append(svg('text', { x: anchor === 'end' ? x + w - 6 : x + 6, y: 28, 'text-anchor': anchor, 'font-size': 11, 'font-weight': 700, fill: '#1c2733' }, label));
    tbl.append(svg('line', { x1: x, y1: 0, x2: x, y2: HEAD_H + built.height, stroke: '#dfe5ea' }));
    x += w;
  }
  rows.forEach((r, i) => {
    const t = project.tasks.find((k) => k.id === r.id);
    const s = schedule.tasks[r.id];
    const y = HEAD_H + i * ROW_H;
    tbl.append(svg('line', { x1: 0, y1: y + ROW_H + 0.5, x2: LEFT_W, y2: y + ROW_H + 0.5, stroke: '#eceff2' }));
    const cells = [String(s.index), t.name, formatDuration(s.duration), formatDate(s.startIso), formatDate(s.finishIso)];
    let cx = 0;
    COLS.forEach(([, w, anchor], c) => {
      const tx = c === 1 ? cx + 6 + (t.level - 1) * 12 : anchor === 'end' ? cx + w - 6 : cx + 6;
      let text = cells[c];
      if (c === 1) { const max = Math.floor((w - 12 - (t.level - 1) * 12) / 6.2); if (text.length > max) text = `${text.slice(0, max - 1)}…`; }
      tbl.append(svg('text', { x: tx, y: y + 17, 'text-anchor': anchor, 'font-size': 11, 'font-weight': s.summary ? 700 : 400, fill: '#1c2733' }, text));
      cx += w;
    });
  });
  tbl.append(svg('line', { x1: LEFT_W, y1: 0, x2: LEFT_W, y2: HEAD_H + built.height, stroke: '#9aa5b1' }));
  tbl.append(svg('line', { x1: 0, y1: HEAD_H - 0.5, x2: LEFT_W, y2: HEAD_H - 0.5, stroke: '#cdd4db' }));
  doc.append(tbl);
  built.header.setAttribute('x', LEFT_W); built.header.setAttribute('y', TITLE_H);
  built.body.setAttribute('x', LEFT_W); built.body.setAttribute('y', TITLE_H + HEAD_H);
  doc.append(built.header, built.body);
  return { doc, width, height };
}

const svgText = (doc) => `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(doc)}`;
const fileBase = () => slugify(store.project.name);

export function exportSvg() {
  const { doc } = ganttDocument();
  downloadText(svgText(doc), `${fileBase()}-gantt.svg`, 'image/svg+xml');
}

export function exportPng(scale = 2) {
  const { doc, width, height } = ganttDocument();
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svgText(doc)], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width * scale; canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale); ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => { if (!blob) reject(new Error('The browser could not rasterise the chart.')); else { downloadBlob(blob, `${fileBase()}-gantt.png`); resolve(); } }, 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('The chart could not be rendered as an image.')); };
    img.src = url;
  });
}

export function exportPdf() {
  const { doc, width, height } = ganttDocument();
  const text = svgText(doc);
  if (hosted) { post({ type: 'pdf', name: `${fileBase()}-gantt.pdf`, pages: [{ svg: text, w: width, h: height }] }); return; }
  const win = window.open('', '_blank');
  if (!win) throw new Error('The browser blocked the print window. Allow pop-ups for this page and try again.');
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeXml(store.project.name)} — Gantt</title><style>@page{size:${width + 40}px ${height + 40}px;margin:20px}html,body{margin:0;background:#fff}svg{display:block}</style></head><body>${text}<script>setTimeout(function(){window.print()},300)</script></body></html>`);
  win.document.close();
}
