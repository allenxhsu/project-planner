// Schedules: the hours of the week a kind of work may use, drawn on a week.
//
// A time block used to be a name, one span and some days, typed into three
// boxes. The schedules people keep are not that shape — nine to half past
// eleven and one to five on weekdays, mornings only on Saturday — so each one
// is drawn instead: drag down a day to add hours, click × to take them away,
// copy a day to the others. They are shared by every project (state/sync.js),
// because they are hours in a week and not properties of a plan.

import { el, clear } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { timeBlocks, slotsOf, mergeSlots, timeBlockIdsOf } from '../model/model.js';
import { parseTime, formatClock } from '../model/agenda.js';
import { WEEKDAY_NAMES } from '../model/calendar.js';
import { open, foot, button, confirmDialog, showMenu } from './dialog.js';

const DAY_ORDER = [0, 1, 2, 3, 4, 5, 6];           // Sunday first, as a week is drawn here
const HOUR_PX = 36;
const SNAP = 15;
const fmt = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const short = (d) => WEEKDAY_NAMES[d].slice(0, 3);

/** "Mon–Fri 9 AM–11:30 AM, 1 PM–5 PM · Sat 9 AM–12 PM": days with the same hours, together. */
export function describeSchedule(block) {
  const byDay = new Map();
  for (const r of slotsOf(block)) {
    const key = byDay.get(r.day) || [];
    key.push(`${formatClock(parseTime(r.from))}–${formatClock(parseTime(r.to))}`);
    byDay.set(r.day, key);
  }
  const groups = [];
  for (const d of [1, 2, 3, 4, 5, 6, 0]) {
    if (!byDay.has(d)) continue;
    const hours = byDay.get(d).join(', ');
    const last = groups[groups.length - 1];
    if (last && last.hours === hours && last.days[last.days.length - 1] === (d === 0 ? 6 : d - 1)) last.days.push(d);
    else groups.push({ hours, days: [d] });
  }
  if (!groups.length) return 'No hours';
  return groups.map((g) => {
    const label = g.days.length > 2 ? `${short(g.days[0])}–${short(g.days[g.days.length - 1])}` : g.days.map(short).join(', ');
    return `${label} ${g.hours}`;
  }).join(' · ');
}

/** The span and days the older fields should say, worked out from the ranges. */
function summaryFields(slots) {
  if (!slots.length) return { from: '09:00', to: '17:00', days: [1, 2, 3, 4, 5] };
  const from = Math.min(...slots.map((r) => parseTime(r.from)));
  const to = Math.max(...slots.map((r) => parseTime(r.to)));
  return { from: fmt(from), to: fmt(to), days: [...new Set(slots.map((r) => r.day))].sort() };
}

/** How many tasks in the open plan use a block — the reason not to delete it lightly. */
const usersOf = (id) => store.project.tasks.filter((t) => timeBlockIdsOf(t).includes(id)).length;

async function save(block, name, slots) {
  const { saveTimeBlock } = await import('../state/sync.js');
  const tidy = mergeSlots(slots);
  await saveTimeBlock({ ...block, name: name.trim() || block.name || 'Schedule', ...summaryFields(tidy), slots: tidy });
  set({});
}

/**
 * The editor: a week, drawn on.
 *
 * Drag down a day to add hours; each range snaps to a quarter of an hour and
 * joins any range it touches. × on a range takes it away. Copy puts one day's
 * hours on others.
 */
export function editSchedule(block = null) {
  const draft = block ? slotsOf(block).map((r) => ({ ...r })) : [1, 2, 3, 4, 5].map((day) => ({ day, from: '09:00', to: '17:00' }));
  return open(block ? 'Edit schedule' : 'New schedule', (close) => {
    let slots = mergeSlots(draft);
    const name = el('input', { class: 'sc-input', type: 'text', value: block?.name || '', placeholder: 'Study hours', 'data-autofocus': '' });
    const cols = new Map();
    const grid = el('div', { class: 'sched-grid' });
    const gutter = el('div', { class: 'sched-gutter' });
    for (let h = 0; h < 24; h++) gutter.append(el('div', { class: 'sched-hour sc-mono', style: { height: `${HOUR_PX}px` }, text: h === 0 ? '' : formatClock(h * 60).toLowerCase().replace(' ', '') }));
    grid.append(gutter);

    const draw = () => {
      for (const [day, col] of cols) {
        col.querySelectorAll('.sched-slot').forEach((n) => n.remove());
        for (const r of slots.filter((x) => x.day === day)) {
          const a = parseTime(r.from);
          const b = parseTime(r.to);
          col.append(el('div', {
            class: 'sched-slot',
            style: { top: `${(a / 60) * HOUR_PX}px`, height: `${Math.max(12, ((b - a) / 60) * HOUR_PX - 2)}px` },
            onpointerdown: (e) => e.stopPropagation(),
          },
            el('span', { class: 'sched-slot-time', text: `${formatClock(a)} – ${formatClock(b)}` }),
            el('button', {
              class: 'sched-slot-x', title: 'Remove these hours', text: '×',
              onclick: (e) => { e.stopPropagation(); slots = slots.filter((x) => x !== r); draw(); },
            })));
        }
      }
    };

    for (const day of DAY_ORDER) {
      const col = el('div', { class: 'sched-col', style: { height: `${24 * HOUR_PX}px` } });
      for (let h = 1; h < 24; h++) col.append(el('div', { class: 'sched-line', style: { top: `${h * HOUR_PX}px` } }));
      // Drag down to add hours.
      col.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const top = col.getBoundingClientRect().top;
        const at = (y) => Math.max(0, Math.min(24 * 60, Math.round((((y - top) / HOUR_PX) * 60) / SNAP) * SNAP));
        const start = at(e.clientY);
        const ghost = el('div', { class: 'sched-slot is-ghost' });
        col.append(ghost);
        const paint = (y) => {
          const a = Math.min(start, at(y));
          const b = Math.max(start + SNAP, at(y));
          ghost.style.top = `${(a / 60) * HOUR_PX}px`;
          ghost.style.height = `${((b - a) / 60) * HOUR_PX}px`;
          ghost.textContent = `${formatClock(a)} – ${formatClock(b)}`;
          return [a, b];
        };
        let span = paint(e.clientY);
        const move = (ev) => { span = paint(ev.clientY); };
        const up = () => {
          removeEventListener('pointermove', move);
          removeEventListener('pointerup', up);
          ghost.remove();
          const [a, b] = span;
          if (b - a >= SNAP) { slots = mergeSlots([...slots, { day, from: fmt(a), to: fmt(Math.min(b, 24 * 60)) }]); draw(); }
        };
        addEventListener('pointermove', move);
        addEventListener('pointerup', up);
      });
      cols.set(day, col);
      grid.append(col);
    }

    const copyFrom = (from, to) => {
      const source = slots.filter((r) => r.day === from);
      slots = mergeSlots([...slots.filter((r) => !to.includes(r.day)), ...to.flatMap((day) => source.map((r) => ({ ...r, day })))]);
      draw();
    };
    const head = el('div', { class: 'sched-head' }, el('div', { class: 'sched-gutter-head' }),
      ...DAY_ORDER.map((day) => el('div', { class: 'sched-day-head' },
        el('span', { text: short(day) }),
        el('button', {
          class: 'sc-button sc-button--ghost sc-button--sm', text: 'Copy', title: `Put ${WEEKDAY_NAMES[day]}'s hours on other days`,
          onclick: (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            showMenu(r.left, r.bottom + 4, [
              { note: `${WEEKDAY_NAMES[day]}'s hours to…` },
              { label: 'Every weekday', run: () => copyFrom(day, [1, 2, 3, 4, 5].filter((d) => d !== day)) },
              { label: 'Every day', run: () => copyFrom(day, DAY_ORDER.filter((d) => d !== day)) },
              { label: 'Saturday and Sunday', run: () => copyFrom(day, [6, 0].filter((d) => d !== day)) },
              ...DAY_ORDER.filter((d) => d !== day).map((d) => ({ label: WEEKDAY_NAMES[d], run: () => copyFrom(day, [d]) })),
              '-',
              { label: `Clear ${WEEKDAY_NAMES[day]}`, danger: true, run: () => { slots = slots.filter((x) => x.day !== day); draw(); } },
            ]);
          },
        }))));

    const scroller = el('div', { class: 'sched-scroll' }, grid);
    // Open on the working morning, not on midnight.
    setTimeout(() => { scroller.scrollTop = Math.max(0, (Math.min(...slots.map((r) => parseTime(r.from)), 7 * 60) / 60 - 0.5) * HOUR_PX); }, 0);
    draw();

    return [
      el('div', { class: 'sched-editor' },
        el('aside', { class: 'sched-side' },
          el('label', { class: 'sc-field' }, el('span', { class: 'sc-label', text: 'Schedule name' }), name),
          el('p', { class: 'sc-faint small', text: 'Drag down a day to add hours. × removes them. Copy puts one day’s hours on others.' }),
          el('p', { class: 'sc-faint small', text: 'Shared by every project: tasks that belong to this schedule are laid only inside these hours.' })),
        el('div', { class: 'sched-main' }, head, scroller)),
      foot(
        el('span', { class: 'sc-faint small', text: 'Drag to select times.' }),
        el('span', { class: 'sc-spacer' }),
        button('Cancel', () => close(null)),
        button('Save changes', async () => {
          if (!slots.length) { act.hint('A schedule needs at least one range of hours.'); return; }
          await save(block || {}, name.value, slots);
          close(true);
        }, 'sc-button--primary')),
    ];
  }, { wide: true });
}

export function renderSchedules(root) {
  clear(root);
  const pane = el('div', { class: 'projects-pane' });
  root.append(pane);
  pane.append(el('div', { class: 'projects-head people-head' },
    el('div', { class: 'people-head-text' },
      el('div', { class: 'sc-display', text: 'Schedules' }),
      el('span', { class: 'sc-muted small', text: 'The hours each kind of work may use, shared by every project. A task belongs to one or more, and the calendar lays it only inside their hours.' })),
    el('div', { class: 'people-head-actions' },
      el('button', { class: 'sc-button sc-button--primary sc-button--sm', text: '+ New schedule', onclick: () => { void editSchedule(null); } }))));

  const list = el('div', { class: 'sched-list sc-card' });
  const blocks = timeBlocks(store.project);
  for (const b of blocks) {
    const used = usersOf(b.id);
    list.append(el('div', { class: 'sched-row', ondblclick: () => { void editSchedule(b); } },
      el('div', { class: 'sched-row-text' },
        el('div', { class: 'sched-row-name', text: b.name }),
        el('div', { class: 'sc-faint small', text: describeSchedule(b) })),
      el('span', { class: 'sc-faint small', text: used ? `${used} task${used === 1 ? '' : 's'} here` : '' }),
      el('button', { class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', text: '✎', title: 'Edit this schedule', onclick: () => { void editSchedule(b); } }),
      el('button', {
        class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', text: '🗑', title: blocks.length > 1 ? 'Delete this schedule' : 'There has to be one schedule left',
        disabled: blocks.length <= 1,
        onclick: async () => {
          const yes = await confirmDialog(`Delete “${b.name}”?`, used
            ? `${used} task${used === 1 ? '' : 's'} in this project use it, and fall back to the plan's default hours.`
            : 'No task in this project uses it. Other projects that do fall back to their default hours.');
          if (yes) await act.deleteTimeBlock(b.id);
        },
      })));
  }
  pane.append(list);
  pane.append(el('p', { class: 'sc-faint small projects-note', text: `${blocks.length} schedule${blocks.length === 1 ? '' : 's'}` }));
}
