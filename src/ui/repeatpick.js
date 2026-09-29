// "Repeats": how often a task comes round (model/routines.js), for the task
// window and the new-task panel. How often, and — weekly or every two weeks —
// on which days; at a set time, or wherever the calendar has room; it starts
// on the task's start date, or today.

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
  // At a set time, or wherever the calendar has room (blank).
  const time = el('input', { class: 'sc-input rp-time', type: 'time', step: 900, value: was?.at || '', onkeydown: (e) => e.stopPropagation() });
  const clearTime = el('button', { type: 'button', class: 'sc-button sc-button--ghost sc-button--sm', text: 'Any time', title: 'Let the calendar place each one', onclick: () => { time.value = ''; showTime(); } });
  const timeNote = el('span', { class: 'sc-faint small' });
  const showTime = () => {
    timeNote.textContent = time.value ? 'Each one is fixed at this time' : 'Blank: the calendar places each one';
    clearTime.hidden = !time.value;
  };
  time.addEventListener('input', showTime);
  const timeRow = el('div', { class: 'rp-at' }, el('span', { class: 'sc-faint small', text: 'At' }), time, clearTime, timeNote);
  const showDays = () => {
    dayRow.hidden = !['weekly', 'biweekly'].includes(freq.value);
    timeRow.hidden = freq.value === 'none';
  };
  freq.addEventListener('change', showDays);
  showDays();
  showTime();
  const get = () => (freq.value === 'none' ? null : cleanRepeat({
    freq: freq.value, from: was?.freq === freq.value ? was.from : fromOf(), days: [...days], at: time.value ? time.value.slice(0, 5) : undefined,
  }));
  const key = (r) => (r ? `${r.freq}|${r.from}|${(r.days || []).join(',')}|${r.at || ''}` : 'none');
  return { node: el('span', { class: 'rp' }, freq, dayRow, timeRow), get, changed: () => key(get()) !== key(was) };
}
