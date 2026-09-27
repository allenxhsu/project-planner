// Resolve: what to do about a task the calendar says is in trouble.
//
// Late — laid past its deadline. Motion's answer is a small wizard: move the
// deadline to when the work will really be done (the projected date, a week
// after it, a month after it, or a day of your own), do it first, finish it,
// or cancel it. After the choice the calendar is laid again and the wizard
// says whether that fixed it.
//
// Missed — a block that went by and the task was not ticked off. It stays on
// the calendar with a "!" (model/missed.js) until someone says what happened:
// done then, done in part, or not done (it is laid again from now on).

import { el } from '../util.js';
import { store } from '../state/store.js';
import * as act from '../state/actions.js';
import { stages, pinsOf } from '../model/model.js';
import { formatClock } from '../model/agenda.js';
import { toDay, fromDay, formatDate } from '../model/calendar.js';
import { open, foot, button } from './dialog.js';
import { withTask } from './blockmenu.js';

const minText = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`);
/** The same day a month on (the 31st into a shorter month is its last day). */
const monthAfter = (iso) => { const [y, m, d] = iso.split('-').map(Number); const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); return new Date(Date.UTC(y, m, Math.min(d, last))).toISOString().slice(0, 10); };
const daysWord = (n) => `${n} day${n === 1 ? '' : 's'}`;

async function lateLineOf(planId, taskId) {
  const { currentLayout } = await import('./calendar.js');
  return (currentLayout().all.late || []).find((l) => l.planId === planId && l.taskId === taskId) || null;
}

/** After a fix: say whether the calendar now makes the deadline. */
async function report(planId, taskId, name, what) {
  const still = await lateLineOf(planId, taskId);
  if (!still) { act.hint(`${what} “${name}” is on track now.`); return; }
  act.hint(`${what} “${name}” is still late: ${still.finishIso ? `it is done ${formatDate(still.finishIso, 'day')}, after ${formatDate(still.deadlineIso, 'day')}` : `${minText(still.minutesShort)} does not fit anywhere yet`}. Resolve again for more.`);
}

function cancelTask(t) {
  const c = stages(store.project).find((s) => s.cancelled);
  if (c) act.setTaskStage(t.id, c.id);
  else act.editTask(t.id, 'archived', true);
}

/** The late wizard: extend the deadline, do it first, complete it or cancel it. */
export async function resolveLate({ planId = store.project.id, taskId }) {
  const t = await withTask(planId, taskId);
  if (!t) return;
  const line = await lateLineOf(store.project.id, t.id);
  if (!line) { act.hint(`“${t.name}” is on track — nothing to resolve.`); return; }
  const deadline = toDay(line.deadlineIso);
  const projected = line.finishIso ? toDay(line.finishIso) : null;
  const base = projected ?? deadline;
  const choices = [
    ...(projected !== null ? [{ iso: fromDay(projected), title: formatDate(fromDay(projected), 'day'), sub: 'Projected date', note: 'Recommended' }] : []),
    { iso: fromDay(base + 7), title: formatDate(fromDay(base + 7), 'day'), sub: projected !== null ? '1 week after projected' : '1 week later' },
    { iso: monthAfter(fromDay(base)), title: formatDate(monthAfter(fromDay(base)), 'day'), sub: projected !== null ? '1 month after projected' : '1 month later' },
  ];

  const picked = await open('Resolve', (close) => {
    let chosen = choices[0].iso;
    const custom = el('input', { class: 'sc-input sheet-date', type: 'date', value: '', min: fromDay(deadline + 1), onkeydown: (e) => e.stopPropagation() });
    const cards = choices.map((c) => el('button', {
      class: `rv-card${c.iso === chosen ? ' is-on' : ''}`,
      onclick: (e) => { chosen = c.iso; custom.value = ''; for (const x of cards) x.classList.toggle('is-on', x === e.currentTarget); },
    }, el('strong', { text: c.title }), el('span', { text: c.sub }), c.note ? el('small', { text: c.note }) : null));
    custom.addEventListener('change', () => { if (custom.value) { chosen = custom.value; for (const x of cards) x.classList.remove('is-on'); } });
    const row = (glyph, cls, label, sub, value) => el('button', { class: `rv-row ${cls}`, onclick: () => close(value) },
      el('span', { class: 'rv-glyph', text: glyph }), el('span', { class: 'rv-label' }, el('span', { text: label }), sub ? el('small', { text: sub }) : null));
    return [
      el('div', { class: 'rv-head' },
        el('strong', { text: '! Task is scheduled past deadline' }),
        el('span', { text: `“${t.name}” is due ${formatDate(line.deadlineIso, 'day')}. ${projected !== null
          ? `Scheduled ${daysWord(projected - deadline)} after — ${minText(line.minutesShort)} lands past it.`
          : `${minText(line.minutesShort)} of it does not fit anywhere yet.`}` })),
      el('div', { class: 'rv-section' },
        el('div', { class: 'rv-section-head' }, el('span', { text: '📅 Extend deadline' }), el('span', { class: 'sc-spacer' }),
          el('label', { class: 'rv-choose' }, el('span', { class: 'sc-faint small', text: 'Choose date' }), custom)),
        el('div', { class: 'rv-cards' }, ...cards),
        el('div', { class: 'rv-apply' }, el('button', { class: 'sc-button sc-button--primary', text: 'Extend deadline', 'data-autofocus': '', onclick: () => close({ kind: 'extend', iso: chosen }) }))),
      el('div', { class: 'rv-rows' },
        row('!', 'is-asap', 'Do ASAP', 'Lay it before everything else, from now', { kind: 'asap' }),
        t.hardDeadline ? null : row('⚑', 'is-hard', 'Make the deadline hard', 'It is laid ahead of work with soft deadlines', { kind: 'hard' }),
        row('✓', 'is-done', 'Complete task', null, { kind: 'complete' }),
        row('✕', 'is-cancel', 'Cancel task', null, { kind: 'cancel' })),
      foot(el('span', { class: 'sc-spacer' }), button('Close', () => close(null))),
    ];
  });
  if (!picked) return;
  const again = await withTask(planId, taskId);
  if (!again) return;
  if (picked.kind === 'extend') {
    act.editTask(again.id, 'deadline', picked.iso);
    await report(store.project.id, again.id, again.name, `Deadline moved to ${formatDate(picked.iso, 'day')}:`);
  } else if (picked.kind === 'asap') {
    act.editTask(again.id, 'urgency', 'now');
    if (again.calendar?.notBefore) act.editTask(again.id, 'notBefore', null);
    await report(store.project.id, again.id, again.name, 'Doing it first:');
  } else if (picked.kind === 'hard') {
    act.editTask(again.id, 'hardDeadline', true);
    await report(store.project.id, again.id, again.name, 'Hard deadline:');
  } else if (picked.kind === 'complete') {
    act.completeFromBlock(again.id);
    act.hint(`“${again.name}” is complete.`);
  } else if (picked.kind === 'cancel') {
    cancelTask(again);
    act.hint(`“${again.name}” is cancelled.`);
  }
}

/** A block that went by, not done: say what happened. `b` is the block drawn (missed, or a fixed one). */
export async function resolveMissed(b) {
  const t = await withTask(b.planId, b.taskId);
  if (!t) return;
  const late = await lateLineOf(store.project.id, t.id);
  const when = `${formatDate(b.dateIso || fromDay(b.day), 'day')}, ${formatClock(b.start)} – ${formatClock(b.end)}`;
  const length = b.end - b.start;
  const picked = await open('Resolve', (close) => {
    const part = el('input', { class: 'sc-input rv-minutes', type: 'number', min: 5, max: length, step: 5, value: String(Math.round(length / 2 / 5) * 5 || 5), onkeydown: (e) => e.stopPropagation() });
    const row = (glyph, cls, label, sub, value, extra = null) => el('div', { class: `rv-row ${cls}`, role: 'button', tabindex: 0,
      onclick: (e) => { if (e.target.closest('input')) return; close(typeof value === 'function' ? value() : value); } },
    el('span', { class: 'rv-glyph', text: glyph }), el('span', { class: 'rv-label' }, el('span', { text: label }), sub ? el('small', { text: sub }) : null), extra);
    return [
      el('div', { class: 'rv-head' },
        el('strong', { text: '! This went by and it is not done' }),
        el('span', { text: `“${t.name}” was on the calendar ${when}. What happened?` })),
      el('div', { class: 'rv-rows' },
        row('✓', 'is-done', 'I did it then — complete', `Logs ${minText(length)} there, and ticks it off`, { kind: 'done' }),
        row('◐', 'is-part', 'I did part of it', 'Logs this much there; the rest is laid from now', () => ({ kind: 'part', minutes: Math.max(5, Math.min(length, +part.value || 0)) }),
          el('span', { class: 'rv-part' }, part, el('span', { class: 'sc-faint small', text: 'min' }))),
        row('↻', 'is-again', 'I didn’t get to it', 'Clears the “!”; the work is on the calendar again from now', { kind: 'skip' }),
        row('✕', 'is-cancel', 'Cancel task', null, { kind: 'cancel' })),
      late ? el('div', { class: 'rv-also' }, el('span', { text: 'It will also miss its deadline.' }),
        button('Resolve that…', () => close({ kind: 'late' }), 'sc-button--sm')) : null,
      foot(el('span', { class: 'sc-spacer' }), button('Close', () => close(null))),
    ];
  });
  if (!picked) return;
  const again = await withTask(b.planId, b.taskId);
  if (!again) return;
  const { dismissMissed } = await import('./calendar.js');
  // A fixed block is freed: the log (or the calendar, from now) says where the work is now.
  const unpin = () => {
    if (!b.pinned) return;
    const i = Number.isInteger(b.pinIndex) ? b.pinIndex : pinsOf(again).findIndex((p) => p.day === (b.dateIso || fromDay(b.day)) && p.start === b.start);
    if (i >= 0) act.unpinBlock(again.id, i);
  };
  const iso = b.dateIso || fromDay(b.day);
  if (picked.kind === 'done' || picked.kind === 'part') {
    unpin();
    act.logBlockWorked(again.id, { date: iso, start: b.start, minutes: picked.kind === 'done' ? length : picked.minutes, complete: picked.kind === 'done' });
    if (b.key) dismissMissed(b.key);
    act.hint(picked.kind === 'done'
      ? `“${again.name}” is done, logged ${when}.`
      : `Logged ${minText(picked.minutes)} on “${again.name}”; the rest is on the calendar.`);
  } else if (picked.kind === 'skip') {
    unpin();
    if (b.key) dismissMissed(b.key);
    act.hint(`“${again.name}” is laid again from now.`);
  } else if (picked.kind === 'cancel') {
    if (b.key) dismissMissed(b.key);
    cancelTask(again);
    act.hint(`“${again.name}” is cancelled.`);
  } else if (picked.kind === 'late') {
    await resolveLate({ planId: b.planId, taskId: b.taskId });
  }
}
