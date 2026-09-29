// "Repeats": how often a task comes round (model/routines.js), for the task
// window and the new-task panel. How often, and — weekly or every two weeks —
// on which days; it starts on the task's start date, or today.

import { el } from '../util.js';
import { REPEATS, cleanRepeat } from '../model/routines.js';
import { toDay, weekday, today } from '../model/calendar.js';

const DAY_LETTERS = [['S', 'Sunday'], ['M', 'Monday'], ['T', 'Tuesday'], ['W', 'Wednesday'], ['T', 'Thursday'], ['F', 'Friday'], ['S', 'Saturday']];

/**
 * @param {object|null} repeat  what the task has now
 * @param {() => string} fromOf the day a new routine starts ('YYYY-MM-DD')
 * @returns {{ node: HTMLElement, get: () => object|null, changed: () => boolean }}
 */
export function repeatPicker(repeat, fromOf = () => today()) {
  const was = cleanRepeat(repeat);
  const freq = el('select', { class: 'sc-select' },
    ...Object.entries(REPEATS).map(([id, label]) => el('option', { value: id, text: label, selected: (was?.freq || 'none') === id })));
  let days = new Set(was?.days || [weekday(toDay(fromOf()))]);
  const dayRow = el('div', { class: 'rp-days' }, ...DAY_LETTERS.map(([letter, name], d) => el('button', {
    type: 'button', class: `rp-day${days.has(d) ? ' is-on' : ''}`, title: name, text: letter,
    onclick: (e) => {
      if (days.has(d) && days.size > 1) days.delete(d); else days.add(d);
      e.currentTarget.classList.toggle('is-on', days.has(d));
    },
  })));
  const showDays = () => { dayRow.hidden = !['weekly', 'biweekly'].includes(freq.value); };
  freq.addEventListener('change', showDays);
  showDays();
  const get = () => (freq.value === 'none' ? null : cleanRepeat({
    freq: freq.value, from: was?.freq === freq.value ? was.from : fromOf(), days: [...days],
  }));
  const key = (r) => (r ? `${r.freq}|${r.from}|${(r.days || []).join(',')}` : 'none');
  return { node: el('span', { class: 'rp' }, freq, dayRow), get, changed: () => key(get()) !== key(was) };
}
