// The new-task panel: a task set up in full before it exists.
//
// The name and a description on the left; on the right everything that
// decides where it lands — which project, held at an hour or placed by the
// calendar, who, what stage, how urgent, how long and in what pieces, from
// when, by when, in which schedule — and the project's own custom fields.
// Opened from a spot on the calendar (fixed at that hour) or from + New.

import { el, clear } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { stages, URGENCIES, timeBlocks, fieldsOf } from '../model/model.js';
import { BLOCK_CHOICES, parseTime, formatClock } from '../model/agenda.js';
import { formatDate } from '../model/calendar.js';
import { open, foot, button } from './dialog.js';
import { fieldInput } from './blockmenu.js';

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240, 360, 480];
const minText = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`);
const nowIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * @param {{ day?: string, start?: number, end?: number, fixed?: boolean }} at
 *   A spot on the calendar: the task is held there unless switched to
 *   auto-scheduled. Without one it is auto-scheduled from today.
 */
export async function newTaskPanel({ day = null, start = null, end = null, fixed = day !== null } = {}) {
  const sync = await import('../state/sync.js');
  const shelf = (await sync.listPlans().catch(() => [])).filter((p) => p.ok && !p.template && !p.archived);
  const plans = [{ id: store.project.id, name: store.project.name }, ...shelf.filter((p) => p.id !== store.project.id)];
  const planOf = async (id) => (id === store.project.id ? store.project : (await sync.readPlan(id)) || store.project);

  const answer = await open('New task', (close) => {
    let plan = store.project;
    const name = el('input', { class: 'ev-title tp-name', type: 'text', placeholder: 'Task name', 'data-autofocus': '' });
    const notes = el('textarea', { class: 'sc-textarea tp-notes', rows: 14, placeholder: 'Description' });
    const side = el('aside', { class: 'task-sheet-facts tp-side' });
    const project = el('select', { class: 'sc-select' }, ...plans.map((p) => el('option', { value: p.id, text: p.name })));
    const mode = el('select', { class: 'sc-select' },
      el('option', { value: 'fixed', text: day ? `Fixed at ${formatClock(start)}` : 'Fixed at a time', selected: fixed }),
      el('option', { value: 'auto', text: 'Auto-scheduled', selected: !fixed }));
    const when = el('div', { class: 'tp-when' });
    const fixedDay = el('input', { class: 'sc-input', type: 'date', value: day || nowIso() });
    const fixedFrom = el('input', { class: 'sc-input', type: 'time', step: 900, value: hhmm(start ?? 9 * 60) });
    const fixedTo = el('input', { class: 'sc-input', type: 'time', step: 900, value: hhmm(end ?? (start ?? 9 * 60) + 30) });
    when.append(fixedDay, fixedFrom, el('span', { text: '–' }), fixedTo);
    const duration = el('select', { class: 'sc-select' }, ...DURATIONS.map((m) => el('option', { value: m, text: minText(m), selected: m === 30 })));
    const chunk = el('select', { class: 'sc-select' }, el('option', { value: '', text: 'The plan’s block size' }),
      ...BLOCK_CHOICES.map((h) => el('option', { value: h, text: minText(h * 60) })));
    const startDate = el('input', { class: 'sc-input', type: 'date', value: day || nowIso() });
    const deadline = el('input', { class: 'sc-input', type: 'date', value: day || '' });
    const urgency = el('select', { class: 'sc-select' }, ...Object.entries(URGENCIES).map(([id, u]) => el('option', { value: id, text: u.label, selected: id === 'normal' })));
    let assignee, stage, schedule, custom = [];
    const fact = (label, value, cls = '') => el('div', { class: `fact ${cls}` }, el('span', { class: 'fact-label', text: label }), value);
    const autoOnly = [];

    const drawSide = () => {
      assignee = el('select', { class: 'sc-select' }, el('option', { value: '', text: 'Nobody' }),
        ...plan.resources.filter((r) => r.type === 'work').map((r, i) => el('option', { value: r.id, text: r.name, selected: i === 0 })));
      stage = el('select', { class: 'sc-select' }, ...stages(plan).map((st) => el('option', { value: st.id, text: st.name })));
      schedule = el('select', { class: 'sc-select' }, el('option', { value: '', text: 'Any — the plan’s default hours' }),
        ...timeBlocks(plan).map((b) => el('option', { value: b.id, text: b.name })));
      custom = fieldsOf(plan).map((f) => ({ field: f, ...fieldInput(plan, f, null) }));
      autoOnly.length = 0;
      const auto = (node) => { autoOnly.push(node); return node; };
      clear(side);
      side.append(
        fact('Project', project),
        el('div', { class: 'tp-mode' }, mode),
        fact('When', when, 'tp-fixed'),
        fact('Assignee', assignee),
        fact('Status', stage),
        fact('Priority', urgency),
        auto(fact('Duration', duration)),
        auto(fact('Min chunk', chunk)),
        auto(fact('Start date', startDate)),
        fact('Deadline', deadline),
        auto(fact('Schedule', schedule)),
        ...custom.map((c) => fact(c.field.name, c.node)));
      showMode();
    };
    const showMode = () => {
      const isFixed = mode.value === 'fixed';
      side.querySelector('.tp-fixed').hidden = !isFixed;
      for (const n of autoOnly) n.hidden = isFixed;
      side.querySelector('.tp-mode').dataset.mode = mode.value;
    };
    mode.addEventListener('change', showMode);
    project.addEventListener('change', async () => { plan = await planOf(project.value); drawSide(); });
    drawSide();

    const save = () => {
      const isFixed = mode.value === 'fixed';
      const from = parseTime(fixedFrom.value);
      const to = parseTime(fixedTo.value);
      close({
        planId: project.value, name: name.value.trim(), notes: notes.value,
        resourceId: assignee.value || null, stageId: stage.value, urgency: urgency.value,
        minutes: isFixed ? (to ?? 0) - (from ?? 0) : +duration.value,
        blockHours: !isFixed && chunk.value ? +chunk.value : null,
        startDay: isFixed ? fixedDay.value : (startDate.value || null),
        deadline: deadline.value || null,
        timeBlockId: !isFixed ? (schedule.value || null) : null,
        fixed: isFixed ? { day: fixedDay.value, start: from, minutes: (to ?? 0) - (from ?? 0) } : null,
        fields: Object.fromEntries(custom.map((c) => [c.field.id, c.get()]).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length))),
      });
    };
    setTimeout(() => document.querySelector('.tp-sheet')?.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); save(); }
    }), 0);

    return [
      el('div', { class: 'task-sheet tp-sheet' },
        el('div', { class: 'task-sheet-main' },
          el('div', { class: 'sheet-head' }, el('span', { class: 'sc-pill sheet-chip', text: '☑ Task' })),
          name, notes),
        side),
      foot(el('span', { class: 'sc-spacer' }), button('Cancel  Esc', () => close(null)), button('Save task  ⌘S', save, 'sc-button--primary')),
    ];
  }, { wide: true });
  if (!answer) return null;
  if (!answer.name) { act.hint('A task needs a name.'); return null; }
  if (answer.fixed && !(answer.fixed.minutes >= 5)) { act.hint('A task at a fixed time ends after it starts.'); return null; }

  // A task in another project is made there: that plan is opened first.
  if (answer.planId !== store.project.id && !(await sync.openPlan(answer.planId))) return null;
  // Time that has gone cannot be booked; a fixed task put there happened.
  const past = answer.fixed && (answer.fixed.day < nowIso()
    || (answer.fixed.day === nowIso() && answer.fixed.start + answer.fixed.minutes <= new Date().getHours() * 60 + new Date().getMinutes()));
  const t = past
    ? act.newTaskDoneAt({ name: answer.name, day: answer.fixed.day, start: answer.fixed.start, minutes: answer.fixed.minutes, notes: answer.notes })
    : act.createTask(answer);
  if (!t) return null;
  act.hint(past ? `That time has passed, so “${t.name}” is logged as done then.`
    : answer.fixed ? `“${t.name}” is fixed at ${formatClock(answer.fixed.start)} on ${formatDate(answer.fixed.day, 'day')}.`
      : `“${t.name}” is on the calendar, placed by it${answer.deadline ? ` to finish by ${formatDate(answer.deadline, 'day')}` : ''}.`);
  set({});
  return t;
}
