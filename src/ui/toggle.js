// A switch: on or off at a glance, as Motion draws its auto-schedule toggle.

import { el } from '../util.js';

/**
 * @param {{ on: boolean, title?: string, small?: boolean, onchange: (on: boolean) => void }} opts
 */
export function switchToggle({ on, title = '', small = true, onchange }) {
  const box = el('input', { type: 'checkbox', class: 'tp-switch-box', checked: !!on,
    onchange: (e) => onchange(e.target.checked) });
  return el('label', { class: `fact-switch sw${small ? ' sw-sm' : ''}${on ? ' is-on' : ''}`, title,
    onclick: (e) => e.stopPropagation() }, box, el('span', { class: 'tp-switch' }));
}
