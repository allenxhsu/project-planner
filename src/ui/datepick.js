// A date picker that sits beside a menu: a month to click in, and the dates
// people actually mean — today, tomorrow, next week — one tap away.
//
// It is a panel, not a dialog, so it opens where the menu item is and goes
// with the menu. The value is an ISO day, 'YYYY-MM-DD'; clearing it hands back
// the empty string, which is how a field says "no date".

import { el } from '../util.js';
import { toDay, fromDay, today, weekStart, monthStart, addMonths, weekday, MONTH_NAMES, formatDate, makeCalendar } from '../model/calendar.js';

const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/**
 * The quick picks everyone means, worked out from today and the plan's own
 * working days, so "tomorrow" on a Friday is Monday when the plan works
 * weekdays.
 */
export function quickDates(project, extra = []) {
  const cal = makeCalendar(project?.calendar);
  const now = toDay(today());
  const nextWorking = (d) => cal.next(d);
  const nextMonday = weekStart(now) + 7;
  const firstOfNextMonth = addMonths(monthStart(now), 1);
  return [
    ...extra,
    { label: 'Today', day: now },
    { label: 'Tomorrow', day: nextWorking(now + 1) },
    { label: 'Next week', day: nextWorking(nextMonday) },
    { label: 'In 2 weeks', day: nextWorking(now + 14) },
    { label: 'Next month', day: nextWorking(firstOfNextMonth) },
  ].filter((q) => Number.isFinite(q.day));
}

/**
 * @param {{ value: string|null, title?: string, quick?: Array<{label, day}>, marks?: Map<number,string>,
 *           onPick: (iso: string) => void, clearable?: boolean }} opts
 *   marks: day number → a colour, for days worth pointing out (a deadline, a stage start).
 */
export function datePanel({ value, title = '', quick = [], marks = new Map(), onPick, clearable = true }) {
  const chosen = value ? toDay(value) : null;
  let month = monthStart(chosen ?? toDay(today()));
  const now = toDay(today());

  const grid = el('div', { class: 'dp-grid' });
  const monthLabel = el('span', { class: 'dp-month' });
  const pick = (day) => onPick(fromDay(day));

  const draw = () => {
    grid.replaceChildren();
    const iso = fromDay(month);
    monthLabel.textContent = `${MONTH_NAMES[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`;
    for (const d of DOW) grid.append(el('span', { class: 'dp-dow', text: d }));
    // Sunday-first rows, as a wall calendar reads.
    const start = month - weekday(month);
    for (let d = start; d < start + 42; d++) {
      const inMonth = fromDay(d).slice(0, 7) === iso.slice(0, 7);
      const mark = marks.get(d);
      grid.append(el('button', {
        class: `dp-day${inMonth ? '' : ' is-outside'}${d === now ? ' is-today' : ''}${d === chosen ? ' is-chosen' : ''}`,
        title: formatDate(fromDay(d), 'long'),
        onclick: (e) => { e.stopPropagation(); pick(d); },
      }, String(+fromDay(d).slice(8, 10)), mark ? el('span', { class: 'dp-mark', style: { background: mark } }) : null));
    }
  };
  draw();

  const head = el('div', { class: 'dp-head' },
    el('span', { class: 'dp-value', text: chosen !== null ? formatDate(fromDay(chosen), 'long') : (title || 'No date') }),
    clearable && chosen !== null ? el('button', { class: 'dp-clear', title: 'Clear the date', text: '×', onclick: (e) => { e.stopPropagation(); onPick(''); } }) : null);
  const nav = el('div', { class: 'dp-nav' },
    el('button', { class: 'dp-step', text: '‹', title: 'Month before', onclick: (e) => { e.stopPropagation(); month = addMonths(month, -1); draw(); } }),
    monthLabel,
    el('button', { class: 'dp-step', text: '›', title: 'Month after', onclick: (e) => { e.stopPropagation(); month = addMonths(month, 1); draw(); } }));

  const list = el('div', { class: 'dp-quick' }, ...quick.map((q) => el('button', {
    class: `dp-quick-item${q.day === chosen ? ' is-chosen' : ''}`,
    onclick: (e) => { e.stopPropagation(); pick(q.day); },
  }, el('span', { text: q.label }), el('span', { class: 'sc-faint', text: formatDate(fromDay(q.day), 'day') }))));

  return el('div', { class: 'dp' }, el('div', { class: 'dp-cal' }, head, nav, grid), quick.length ? list : null);
}
