// A list whose order is the user's: each row can be dragged by its grip to
// above or below another, or moved with the buttons that show on hover —
// to the top, up one, down one, to the bottom — as Motion's Sort Groups has.
// It says the new order and leaves redrawing to the caller.

import { el } from '../util.js';

let dragging = null;   // { list, key }

/**
 * @param {{ key: string, node: Node }[]} items  top to bottom
 * @param {(keys: string[]) => void} onOrder    the whole new order
 * @param {{ buttons?: boolean, cls?: string }} [options]
 */
export function orderable(items, onOrder, { buttons = true, cls = '' } = {}) {
  const list = el('div', { class: `ord-list ${cls}` });
  const keys = items.map((it) => it.key);
  const moveTo = (key, at) => {
    const rest = keys.filter((k) => k !== key);
    rest.splice(Math.max(0, Math.min(rest.length, at)), 0, key);
    if (rest.join('\u0000') !== keys.join('\u0000')) onOrder(rest);
  };
  const clearMarks = () => { for (const n of list.querySelectorAll('.is-drop-before, .is-drop-after')) n.classList.remove('is-drop-before', 'is-drop-after'); };
  const side = (e, row) => { const r = row.getBoundingClientRect(); return e.clientY < r.top + r.height / 2 ? 'before' : 'after'; };
  const button = (text, title, disabled, run) => el('button', {
    class: 'ord-btn', text, title, disabled,
    onclick: (e) => { e.stopPropagation(); run(); },
  });

  items.forEach((it, i) => {
    const row = el('div', { class: 'ord-row', draggable: true },
      el('span', { class: 'ord-grip', title: 'Drag to reorder', text: '⠿' }),
      el('div', { class: 'ord-body' }, it.node),
      buttons ? el('span', { class: 'ord-btns' },
        button('⤒', 'Move to top', i === 0, () => moveTo(it.key, 0)),
        button('↑', 'Move up', i === 0, () => moveTo(it.key, i - 1)),
        button('↓', 'Move down', i === items.length - 1, () => moveTo(it.key, i + 1)),
        button('⤓', 'Move to bottom', i === items.length - 1, () => moveTo(it.key, items.length))) : null);
    // A select or input inside a row must stay usable: dragging starts from the row, not from them.
    row.addEventListener('dragstart', (e) => {
      if (e.target.closest?.('select, input, textarea, button:not(.ord-grip)') && e.target !== row) { e.preventDefault(); return; }
      dragging = { list, key: it.key };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', it.key);
      row.classList.add('is-dragging');
    });
    row.addEventListener('dragend', () => { dragging = null; row.classList.remove('is-dragging'); clearMarks(); });
    row.addEventListener('dragover', (e) => {
      if (dragging?.list !== list || dragging.key === it.key) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const s = side(e, row);
      if (!row.classList.contains(`is-drop-${s}`)) { clearMarks(); row.classList.add(`is-drop-${s}`); }
    });
    row.addEventListener('dragleave', (e) => { if (!row.contains(e.relatedTarget)) row.classList.remove('is-drop-before', 'is-drop-after'); });
    row.addEventListener('drop', (e) => {
      if (dragging?.list !== list || dragging.key === it.key) return;
      e.preventDefault();
      const key = dragging.key;
      dragging = null;
      clearMarks();
      const rest = keys.filter((k) => k !== key);
      moveTo(key, rest.indexOf(it.key) + (side(e, row) === 'after' ? 1 : 0));
    });
    list.append(row);
  });
  return list;
}
