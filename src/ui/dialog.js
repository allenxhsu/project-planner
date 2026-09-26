// Modal dialogs and pop-up menus, built on the kit's sc-overlay / sc-dialog / sc-menu.

import { el } from '../util.js';

let openCount = 0;
export const modalOpen = () => openCount > 0;

/** `build(close)` returns the dialog body; the promise resolves with whatever `close` is given. */
/**
 * Dialogs that save — a task's sheet, the event window, the new-task panel —
 * say so by setting `close.onSave`. ⌘S is then theirs: in a browser their
 * own key handler takes it, and in the Mac app, where ⌘S belongs to the menu
 * bar's Save and never reaches the page, the menu command is handed here
 * first (main.js), so it saves the dialog rather than the document.
 */
const saving = [];
export function saveOpenDialog() {
  for (let i = saving.length - 1; i >= 0; i--) {
    const fn = saving[i].onSave;
    if (typeof fn === 'function') { fn(); return true; }
  }
  return false;
}

export function open(title, build, { dismissable = true, wide = false } = {}) {
  return new Promise((resolve) => {
    const close = (value) => {
      const at = saving.indexOf(close);
      if (at >= 0) saving.splice(at, 1);
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      openCount--;
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape' && dismissable) { e.stopPropagation(); close(null); } };
    const overlay = el('div', { class: 'sc-overlay', onpointerdown: (e) => { if (e.target === overlay && dismissable) close(null); } },
      el('div', { class: `sc-dialog sc-brackets${wide ? ' dialog-wide' : ''}`, role: 'dialog', 'aria-label': title },
        el('div', { class: 'sc-dialog-head' }, el('span', { class: 'sc-display', text: title })),
        el('div', { class: 'sc-dialog-body' }, build(close))));
    saving.push(close);
    openCount++;
    document.addEventListener('keydown', onKey, true);
    document.getElementById('modal-root').append(overlay);
    setTimeout(() => (overlay.querySelector('[data-autofocus]') || overlay.querySelector('input,select,textarea,button'))?.focus(), 0);
  });
}

export const foot = (...buttons) => el('div', { class: 'dialog-foot' }, ...buttons);
export const button = (text, onclick, variant = '') => el('button', { class: `sc-button ${variant}`, text, onclick });

export function confirmDialog(title, body, okLabel = 'Delete') {
  return open(title, (close) => [
    el('p', { text: body }),
    foot(el('button', { class: 'sc-button', text: 'Cancel', 'data-autofocus': '', onclick: () => close(false) }), button(okLabel, () => close(true), 'sc-button--danger')),
  ]);
}

export function promptText(title, body, value = '') {
  return open(title, (close) => {
    const input = el('input', { class: 'sc-input', type: 'text', value, 'data-autofocus': '' });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(input.value); });
    setTimeout(() => input.select(), 0);
    return [el('p', { text: body }), input, foot(button('Cancel', () => close(null)), button('OK', () => close(input.value), 'sc-button--primary'))];
  });
}

export function showText(title, text) {
  return open(title, (close) => [el('pre', { class: 'dialog-pre', text }), foot(el('button', { class: 'sc-button', text: 'Close', 'data-autofocus': '', onclick: () => close(null) }))], { wide: true });
}

/**
 * A form. `fields`: [{ key, label, type?: 'text'|'date'|'number'|'select'|'textarea'|'check', options?, value, hint? }].
 * Resolves { key: value } or null.
 */
export function formDialog(title, fields, okLabel = 'OK', intro = null) {
  return open(title, (close) => {
    const inputs = {};
    const rows = fields.map((f) => {
      let input;
      if (f.type === 'select') input = el('select', { class: 'sc-select' }, ...f.options.map((o) => el('option', { value: o.value, text: o.label, selected: o.value === f.value })));
      else if (f.type === 'textarea') input = el('textarea', { class: 'sc-textarea', rows: f.rows || 4, value: f.value || '' });
      else if (f.type === 'check') input = el('input', { class: 'sc-check', type: 'checkbox', checked: !!f.value });
      else input = el('input', { class: 'sc-input', type: f.type || 'text', value: f.value ?? '', step: f.step, min: f.min, placeholder: f.placeholder });
      inputs[f.key] = input;
      if (f.type === 'check') return el('label', { class: 'row check-row' }, input, el('span', { text: f.label }));
      return el('label', { class: 'sc-field' }, el('span', { class: 'sc-label', text: f.label }), input, f.hint ? el('span', { class: 'sc-faint field-hint', text: f.hint }) : null);
    });
    const ok = () => close(Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.type === 'checkbox' ? i.checked : i.value])));
    const body = el('div', { class: 'dialog-form' }, ...rows);
    body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); ok(); } });
    return [intro ? el('p', { class: 'sc-muted', text: intro }) : null, body, foot(button('Cancel', () => close(null)), button(okLabel, ok, 'sc-button--primary'))];
  });
}

// ---------------------------------------------------------------- menus

let openMenu = null;
export function closeMenu() { openMenu?._side?.remove(); openMenu?.remove(); openMenu = null; }

/**
 * Pop a menu at a screen position. `items`: [{ label, run, danger?, disabled?, note?, key?, checked? } | '-'].
 */
/**
 * A pop-up menu.
 *
 * items: '-' for a separator, { note } for a line of text, or
 *   { label, run, key?, checked?, danger?, disabled?, icon? } for a command,
 *   { label, submenu: items } for a menu that opens beside it, or
 *   { label, panel: (close) => Element } for anything else beside it — a date
 *   picker, say. Side panels open on hover and on click, one at a time, and go
 *   when the menu goes.
 */
export function showMenu(x, y, items) {
  closeMenu();
  let side = null;
  const closeSide = () => { side?.remove(); side = null; };
  const closeAll = () => { closeSide(); closeMenu(); };
  const openSide = (row, it) => {
    if (side?.dataset.for === it.label) return;
    closeSide();
    side = it.submenu
      ? el('div', { class: 'sc-menu pop-menu pop-side' }, ...it.submenu.map((sub) => itemRow(sub, true)))
      : el('div', { class: 'sc-menu pop-menu pop-side pop-panel' }, it.panel(closeAll));
    side.dataset.for = it.label;
    document.body.append(side);
    const r = row.getBoundingClientRect();
    const s = side.getBoundingClientRect();
    const right = r.right + 2;
    side.style.left = `${right + s.width < window.innerWidth - 4 ? right : Math.max(4, r.left - s.width - 2)}px`;
    side.style.top = `${Math.max(4, Math.min(r.top - 4, window.innerHeight - s.height - 4))}px`;
    if (openMenu) openMenu._side = side;
  };
  const itemRow = (it, inSide = false) => {
    if (it === '-') return el('div', { class: 'sc-menu-sep' });
    if (it.note) return el('div', { class: 'menu-note', text: it.note });
    const opens = !!(it.submenu || it.panel);
    const row = el('button', {
      class: `sc-menu-item${it.danger ? ' is-danger' : ''}${opens ? ' has-side' : ''}`, disabled: !!it.disabled,
      onclick: (e) => { if (opens) { e.stopPropagation(); openSide(row, it); return; } closeAll(); it.run(); },
      onpointerenter: inSide ? null : () => { if (opens) openSide(row, it); else closeSide(); },
    },
      el('span', { class: 'menu-label' }, it.icon ? el('span', { class: 'menu-icon', text: it.icon }) : null, `${it.checked ? '✓ ' : ''}${it.label}`),
      it.key ? el('span', { class: 'sc-kbd', text: it.key }) : opens ? el('span', { class: 'menu-more', text: '›' }) : null);
    return row;
  };
  const menu = el('div', { class: 'sc-menu pop-menu' }, ...items.map((it) => itemRow(it)));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  openMenu = menu;
}
document.addEventListener('pointerdown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

/** A panel — a date picker, say — opened where a menu would be, and closed the way a menu is. */
export function showPanel(x, y, build) {
  closeMenu();
  const menu = el('div', { class: 'sc-menu pop-menu pop-panel' }, build(closeMenu));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  openMenu = menu;
}
