// Small shared helpers. Nothing here knows about projects or schedules.

import { hosted, saveViaHost } from './host.js';

let seq = 0;
export function uid(prefix = 'id') {
  seq = (seq + 1) % 1679616;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36).padStart(4, '0')}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function deepClone(o) {
  return typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o));
}

function build(node, attrs, children) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.setAttribute('class', v);
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [p, val] of Object.entries(v)) { if (p.startsWith('--')) node.style.setProperty(p, val); else node.style[p] = val; }
    }
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in node && !(node instanceof SVGElement) && k !== 'list') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** `el('div', { class: 'x', onclick }, child, 'text')` */
export function el(tag, attrs = {}, ...children) {
  return build(document.createElement(tag), attrs, children);
}
const SVG_NS = 'http://www.w3.org/2000/svg';
/** `svg('rect', { x, y, width, height })` */
export function svg(tag, attrs = {}, ...children) {
  return build(document.createElementNS(SVG_NS, tag), attrs, children);
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

export function escapeXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

export function downloadBlob(blob, filename) {
  // A web view has no downloads folder; the macOS app shows a save panel instead.
  if (hosted) { saveViaHost(blob, filename); return; }
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function downloadText(text, filename, mime = 'text/plain') {
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}

export function slugify(s) {
  return String(s || 'untitled').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'untitled';
}

export function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n');

/** Parse CSV text into rows of strings (RFC 4180 quoting). */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export function formatMoney(n, symbol = '$') {
  const v = Math.round((n || 0) * 100) / 100;
  return `${symbol}${v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}
export const formatHours = (h) => `${Math.round((h || 0) * 10) / 10}h`;

// ---------------------------------------------------------------------------
// A small XML reader. DOMParser only exists in the browser; MS Project XML
// import is also exercised from Node, so it parses into plain objects instead:
//   { name, local, attrs: {}, children: [], text }
// ---------------------------------------------------------------------------

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] ?? m;
  });
}

export function parseXml(src) {
  const root = { name: '#doc', local: '#doc', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      if (stack.length < 2 || top.name !== m[2]) throw new Error(`XML is not well formed: unexpected </${m[2]}>.`);
      stack.pop();
    } else if (m[3]) {
      const node = { name: m[3], local: m[3].split(':').pop(), attrs: {}, children: [], text: '' };
      const ar = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = ar.exec(m[4]))) node.attrs[a[1]] = unescapeXml(a[2] ?? a[3]);
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] && m[6].trim()) top.text += unescapeXml(m[6]);
  }
  if (stack.length !== 1) throw new Error(`XML is not well formed: <${stack[stack.length - 1].name}> is never closed.`);
  if (!root.children.length) throw new Error('The file holds no XML element.');
  return root.children[0];
}

/** First child element by local name, and its text. */
export const child = (node, local) => node.children.find((c) => c.local === local);
export const childText = (node, local, fallback = '') => child(node, local)?.text ?? fallback;
export const children = (node, local) => node.children.filter((c) => c.local === local);
