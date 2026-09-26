// A project's Navigate tab and its docs and sheets, as Motion has them.
//
// Navigate lists the project's docs and sheets, with "+ New doc or sheet".
// A doc is a page of markdown written the way Heptabase writes it
// (ui/mdnotes.js); a sheet is a small table — a Name column, more if you add
// them, a row for each thing. Both are kept in the plan (model/docs.js).

import { el, clear } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { docsOf, getDoc } from '../model/docs.js';
import { markdownNotes } from './mdnotes.js';
import { showMenu, confirmDialog } from './dialog.js';
import { formatDate } from '../model/calendar.js';

const GLYPH = { doc: '▤', sheet: '▦' };
const when = (iso) => (iso ? formatDate(iso.slice(0, 10), 'day') : '');

export function openDoc(id) { set({ view: 'doc', docId: id }); }

function newMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, [
    { icon: GLYPH.doc, label: 'New doc', run: () => { const d = act.createDoc('doc'); if (d) openDoc(d.id); } },
    { icon: GLYPH.sheet, label: 'New sheet', run: () => { const d = act.createDoc('sheet'); if (d) openDoc(d.id); } },
  ]);
}

/** The Navigate tab: the project's docs and sheets. */
export function renderNavigate(pane) {
  const list = docsOf(store.project);
  const add = el('button', { class: 'nav-new', onclick: (e) => newMenu(e.currentTarget) }, el('span', { text: '＋' }), el('span', { text: 'New doc or sheet' }));
  pane.append(el('div', { class: 'nav-pane' },
    el('div', { class: 'nav-list' },
      ...list.map((d) => el('button', { class: 'nav-item', onclick: () => openDoc(d.id),
        oncontextmenu: (e) => { e.preventDefault(); docMenu(d, e.clientX, e.clientY); } },
        el('span', { class: 'nav-glyph', text: GLYPH[d.kind] }),
        el('span', { class: 'nav-title', text: d.title }),
        el('span', { class: 'sc-faint small', text: d.kind === 'sheet' ? `${d.rows.length} row${d.rows.length === 1 ? '' : 's'}` : when(d.updatedAt) }))),
      add),
    list.length ? null : el('div', { class: 'nav-empty sc-muted' },
      el('p', { text: '💡 Add a doc or a sheet with the button above.' }),
      el('p', {}, 'To see all the tasks, open ', el('strong', { text: 'Task List' }), ' above.'))));
}

function docMenu(d, x, y) {
  showMenu(x, y, [
    { label: 'Open', run: () => openDoc(d.id) },
    { label: 'Rename…', run: async () => {
      const { promptText } = await import('./dialog.js');
      const name = await promptText('Rename', '', d.title);
      if (name?.trim()) act.editDoc(d.id, { title: name });
    } },
    '-',
    { label: `Delete ${d.kind}`, danger: true, run: async () => {
      if (!(await confirmDialog(`Delete “${d.title}”?`, 'Undo brings it back.'))) return;
      act.deleteDoc(d.id);
      if (store.ui.view === 'doc') set({ view: 'list', projectTab: 'navigate' });
    } },
  ]);
}

let mounted = null;   // { id, node }: the doc on screen, not redrawn while it is being typed in

/** A doc or a sheet, on its own page. */
export function renderDoc(root) {
  const d = getDoc(store.project, store.ui.docId);
  if (mounted && d && mounted.id === d.id && root.contains(mounted.node) && mounted.node.contains(document.activeElement)) return;
  clear(root);
  const pane = el('div', { class: 'doc-pane' });
  root.append(pane);
  const back = () => set({ view: 'list', projectTab: 'navigate' });
  if (!d) {
    pane.append(el('p', { class: 'empty', text: 'That doc is not in this project.' }), el('button', { class: 'sc-button sc-button--sm', text: '← Back to the project', onclick: back }));
    mounted = null;
    return;
  }
  const crumb = el('div', { class: 'doc-crumb' },
    el('button', { class: 'tl-crumb', text: `← ${store.project.name}`, onclick: back }),
    el('span', { class: 'sc-faint', text: '/' }), el('span', { text: d.title }),
    el('span', { class: 'sc-spacer' }),
    el('button', { class: 'ord-btn', text: '⋯', title: 'More', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); docMenu(d, r.left - 120, r.bottom + 4); } }));
  const title = el('input', { class: 'doc-title', type: 'text', value: d.title, placeholder: d.kind === 'sheet' ? 'New Sheet' : 'New doc',
    onchange: (e) => act.editDoc(d.id, { title: e.target.value }), onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); } });
  const body = d.kind === 'sheet' ? sheetTable(d) : docBody(d);
  pane.append(crumb, el('div', { class: `doc-page is-${d.kind}` }, el('span', { class: 'doc-glyph', text: GLYPH[d.kind] }), title, body));
  mounted = { id: d.id, node: pane };
}

function docBody(d) {
  let timer = null;
  const notes = markdownNotes({ value: d.body, placeholder: 'Write — markdown: # heading, - list, [] to-do, / for blocks', rows: 22,
    onchange: (text) => { clearTimeout(timer); timer = setTimeout(() => act.editDoc(d.id, { body: text }), 700); } });
  notes.node.classList.add('doc-body');
  return notes.node;
}

function sheetTable(d) {
  const stop = (e) => e.stopPropagation();
  const head = el('tr', {}, el('th', { class: 'sh-num' }),
    ...d.columns.map((c) => el('th', {},
      el('input', { class: 'sh-head', type: 'text', value: c.name, onkeydown: stop, onchange: (e) => act.sheetRenameColumn(d.id, c.id, e.target.value) }),
      d.columns.length > 1 ? el('button', { class: 'ord-btn sh-x', text: '×', title: 'Remove column', onclick: () => act.sheetRemoveColumn(d.id, c.id) }) : null)),
    el('th', { class: 'sh-add' }, el('button', { class: 'ord-btn', text: '＋', title: 'Add column', onclick: () => act.sheetAddColumn(d.id) })));
  const rows = d.rows.map((r, i) => el('tr', {},
    el('td', { class: 'sh-num' }, el('span', { text: String(i + 1) }), el('button', { class: 'ord-btn sh-x', text: '×', title: 'Remove row', onclick: () => act.sheetRemoveRow(d.id, r.id) })),
    ...d.columns.map((c) => el('td', {}, el('input', { class: 'sh-cell', type: 'text', value: r.cells[c.id] || '', onkeydown: stop,
      onchange: (e) => act.sheetSetCell(d.id, r.id, c.id, e.target.value) }))),
    el('td')));
  return el('div', { class: 'sh-wrap' },
    el('table', { class: 'sh-table' }, el('thead', {}, head), el('tbody', {}, ...rows)),
    el('button', { class: 'nav-new', onclick: () => act.sheetAddRow(d.id) }, el('span', { text: '＋' }), el('span', { text: 'Add row' })));
}
