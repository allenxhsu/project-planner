// The spreadsheet-like grid the task views and the resource sheet share.
//
// It draws rows and columns, a selection, an active cell and — when asked —
// an editor in that cell. It does not know about tasks: callers hand it rows
// with values and take back commits. Row height and header height are fixed
// so the Gantt chart can line its bars up with the rows.

import { el, clear } from '../util.js';

export const ROW_H = 26;
export const HEAD_H = 44;

/**
 * spec: {
 *   columns: [{ key, label, width, align?, edit?: 'text'|'duration'|'date'|'number'|'percent'|'select'|'textarea', options?, readonly? }],
 *   rows: [{ id, cells: { key: text|node }, class?, indent?, toggle?: 'open'|'closed'|null, summary?, title? }],
 *   selected: Set<id>, activeId, activeCol, editing: { id, col, seed? } | null,
 *   onSelect(id, event), onCell(id, col), onCommit(id, col, value, { next }), onCancel(), onToggle(id), onContext(id, event)
 * }
 */
export function renderGrid(root, spec) {
  clear(root);
  const cols = spec.columns;
  const table = el('table', { class: 'grid', style: { width: `${cols.reduce((s, c) => s + c.width, 0)}px` } });
  table.append(el('colgroup', {}, ...cols.map((c) => el('col', { style: { width: `${c.width}px` } }))));
  table.append(el('thead', {}, el('tr', {}, ...cols.map((c) => el('th', { class: c.align === 'right' ? 'num' : '', text: c.label })))));
  const body = el('tbody');
  for (const row of spec.rows) {
    const sel = spec.selected.has(row.id);
    const tr = el('tr', {
      class: `${row.class || ''}${sel ? ' is-sel' : ''}${row.id === spec.activeId ? ' is-active' : ''}${row.summary ? ' is-summary' : ''}`,
      dataset: { id: row.id }, title: row.title || null,
      onpointerdown: (e) => { if (e.button === 0 && !e.target.closest('input,select,textarea,.toggle')) spec.onSelect(row.id, e); },
      oncontextmenu: (e) => { e.preventDefault(); spec.onContext?.(row.id, e); },
    });
    for (const c of cols) {
      const isActive = row.id === spec.activeId && c.key === spec.activeCol;
      const isEditing = spec.editing && spec.editing.id === row.id && spec.editing.col === c.key && c.edit && !c.readonly;
      const td = el('td', {
        class: `${c.align === 'right' ? 'num ' : ''}${isActive ? 'is-cursor ' : ''}${c.key === 'name' ? 'name-cell' : ''}`,
        onpointerdown: (e) => { if (e.button === 0 && !e.target.closest('input,select,textarea,.toggle')) spec.onCell?.(row.id, c.key, e); },
        ondblclick: () => { if (c.edit && !c.readonly) spec.onEdit?.(row.id, c.key); },
      });
      if (isEditing) td.append(editor(c, row, spec));
      else {
        if (c.key === 'name' && row.indent !== undefined) {
          td.style.paddingLeft = `${8 + row.indent * 16}px`;
          td.append(el('span', { class: `toggle${row.toggle ? '' : ' is-leaf'}`, text: row.toggle === 'closed' ? '▸' : row.toggle === 'open' ? '▾' : '', onpointerdown: (e) => { e.stopPropagation(); if (row.toggle) spec.onToggle(row.id); } }));
        }
        const v = row.cells[c.key];
        if (v !== undefined && v !== null) td.append(v.nodeType ? v : el('span', { class: 'cell-text', text: String(v) }));
      }
      tr.append(td);
    }
    body.append(tr);
  }
  // A blank row at the end: click to add.
  if (spec.onAppend) {
    body.append(el('tr', { class: 'grid-append', onpointerdown: (e) => { if (e.button === 0) spec.onAppend(); } },
      el('td', { colSpan: cols.length, text: spec.appendLabel || '+ New task' })));
  }
  table.append(body);
  root.append(table);
}

function editor(c, row, spec) {
  const value = spec.editing.seed !== undefined ? spec.editing.seed : (row.raw?.[c.key] ?? (typeof row.cells[c.key] === 'string' ? row.cells[c.key] : ''));
  let input;
  if (c.edit === 'select') {
    input = el('select', { class: 'sc-select cell-editor' }, ...c.options.map((o) => el('option', { value: o.value, text: o.label, selected: o.value === value })));
    input.addEventListener('change', () => spec.onCommit(row.id, c.key, input.value, {}));
  } else if (c.edit === 'date') {
    input = el('input', { class: 'sc-input cell-editor', type: 'date', value: value || '' });
  } else {
    input = el('input', { class: 'sc-input cell-editor', type: 'text', value, spellcheck: false });
  }
  const done = (next) => spec.onCommit(row.id, c.key, input.value, { next });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); done(e.shiftKey ? 'up' : 'down'); }
    else if (e.key === 'Tab') { e.preventDefault(); done(e.shiftKey ? 'left' : 'right'); }
    else if (e.key === 'Escape') { e.preventDefault(); spec.onCancel(); }
  });
  input.addEventListener('blur', () => { if (input.isConnected && spec.editing) done(null); });
  setTimeout(() => {
    input.focus();
    if (input.type === 'text') input.setSelectionRange(input.value.length, input.value.length);
  }, 0);
  return input;
}

/** Keep the active row in view inside a scrolling pane. */
export function scrollRowIntoView(pane, id) {
  const tr = pane.querySelector(`tr[data-id="${CSS.escape(id)}"]`);
  if (!tr) return;
  const top = tr.offsetTop, bottom = top + ROW_H;
  if (top < pane.scrollTop + HEAD_H) pane.scrollTop = top - HEAD_H;
  else if (bottom > pane.scrollTop + pane.clientHeight) pane.scrollTop = bottom - pane.clientHeight;
}
