#!/usr/bin/env node
// Render a plan's Gantt chart to SVG without a browser:
//
//   node tools/gantt-svg.mjs plan.project.json > gantt.svg
//   node tools/gantt-svg.mjs --sample --zoom week > doc/sample-gantt.svg
//
// The chart code builds SVG through a tiny element API (src/util.js `svg()`),
// so a few dozen lines of stand-in DOM are enough to run it under Node. This
// is the same drawing the app's Export menu produces.

import fs from 'node:fs';

// ---- the stand-in DOM, installed before the app modules load
class Node_ {
  constructor(name) { this.nodeType = 1; this.name = name; this.attrs = new Map(); this.children = []; this.dataset = {}; this.style = { setProperty() {} }; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.get(k) ?? null; }
  append(...nodes) { for (const n of nodes) this.children.push(n); }
  addEventListener() {}
  set textContent(v) { this.children = [new Text_(String(v))]; }
  get classList() { return { add() {}, remove() {}, toggle() {} }; }
}
class Text_ { constructor(t) { this.nodeType = 3; this.text = t; } }
class SVGElement extends Node_ {}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function serialize(n) {
  if (n.nodeType === 3) return esc(n.text);
  const data = Object.entries(n.dataset).map(([k, v]) => ` data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${esc(v)}"`).join('');
  const attrs = [...n.attrs].map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  return n.children.length ? `<${n.name}${attrs}${data}>${n.children.map(serialize).join('')}</${n.name}>` : `<${n.name}${attrs}${data}/>`;
}
globalThis.SVGElement = SVGElement;
globalThis.document = {
  createElementNS: (ns, name) => new SVGElement(name),
  createElement: (name) => new Node_(name),
  createTextNode: (t) => new Text_(t),
  addEventListener() {}, getElementById: () => null, documentElement: new Node_('html'),
};
globalThis.window = globalThis;
globalThis.XMLSerializer = class { serializeToString(n) { return serialize(n); } };

// ---- arguments
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const zoom = opt('--zoom', 'day');
const file = args.find((a) => !a.startsWith('--') && a !== opt('--zoom'));

const { store, loadProject, set } = await import('../src/state/store.js');
const { parse } = await import('../src/io/json.js');
const { sampleProject } = await import('../src/model/sample.js');
const { ganttDocument } = await import('../src/io/exportImage.js');

if (args.includes('--sample') || !file) loadProject(sampleProject());
else {
  const { project, repairs } = parse(fs.readFileSync(file, 'utf8'));
  for (const r of repairs) console.error(`repaired: ${r}`);
  loadProject(project, file);
}
set({ zoom, selection: [] });
const { doc } = ganttDocument();
process.stdout.write(`<?xml version="1.0" encoding="UTF-8"?>\n${serialize(doc)}\n`);
