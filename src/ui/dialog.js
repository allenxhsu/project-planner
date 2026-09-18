// Modal dialogs and pop-up menus, built on the kit's sc-overlay / sc-dialog / sc-menu.

import { el } from '../util.js';

let openCount = 0;
export const modalOpen = () => openCount > 0;

/** `build(close)` returns the dialog body; the promise resolves with whatever `close` is given. */
export function open(title, build, { dismissable = true, wide = false } = {}) {
  return new Promise((resolve) => {
    const close = (value) => {
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
export function closeMenu() { openMenu?.remove(); openMenu = null; }

/**
 * Pop a menu at a screen position. `items`: [{ label, run, danger?, disabled?, note?, key?, checked? } | '-'].
 */
export function showMenu(x, y, items) {
  closeMenu();
  const menu = el('div', { class: 'sc-menu pop-menu' }, ...items.map((it) => {
    if (it === '-') return el('div', { class: 'sc-menu-sep' });
    if (it.note) return el('div', { class: 'menu-note', text: it.note });
    return el('button', {
      class: `sc-menu-item${it.danger ? ' is-danger' : ''}`, disabled: !!it.disabled,
      onclick: () => { closeMenu(); it.run(); },
    }, el('span', { text: `${it.checked ? '✓ ' : ''}${it.label}` }), it.key ? el('span', { class: 'sc-kbd', text: it.key }) : null);
  }));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  openMenu = menu;
}
document.addEventListener('pointerdown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
