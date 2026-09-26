// The new-task panel: a task set up in full before it exists.
//
// The name and a description on the left. On the right, where it goes —
// workspace, then the project's phase (the planner's nearest thing to a
// folder), then the project — whether the calendar places it or it is held
// at an hour, and then everything that decides where it lands: who, what
// stage, how urgent, how long and in what pieces, from when, by when and how
// hard that is, in which schedule, with which labels, and the project's own
// custom fields. Opened from a spot on the calendar or from + New.

import { el, clear } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { stages, URGENCIES, timeBlocks, fieldsOf, phases } from '../model/model.js';
import { BLOCK_CHOICES, parseTime, formatClock } from '../model/agenda.js';
import { formatDate } from '../model/calendar.js';
import { open, foot, button } from './dialog.js';
import { fieldInput } from './blockmenu.js';

const DURATIONS = [15, 30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 480];
const minText = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`);
const nowIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const hhmm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * @param {{ day?: string, start?: number, end?: number, fixed?: boolean }} at
 *   A spot on the calendar: held there unless auto-scheduling is switched on.
 *   Without one it is auto-scheduled from today.
 */
export async function newTaskPanel({ day = null, start = null, end = null, fixed = day !== null } = {}) {
  const sync = await import('../state/sync.js');
  const [shelf, spaces] = await Promise.all([sync.listPlans().catch(() => []), sync.listWorkspaces().catch(() => [])]);
  const plans = [
    { id: store.project.id, name: store.project.name, workspaceId: store.project.workspaceId || null },
    ...shelf.filter((p) => p.ok && !p.template && !p.archived && p.id !== store.project.id),
  ];
  const planOf = async (id) => (id === store.project.id ? store.project : (await sync.readPlan(id)) || store.project);

  const answer = await open('New task', (close) => {
    let plan = store.project;
    const name = el('input', { class: 'ev-title tp-name', type: 'text', placeholder: 'Task name', 'data-autofocus': '' });
    const notes = el('textarea', { class: 'sc-textarea tp-notes', rows: 14, placeholder: 'Description' });
    const side = el('aside', { class: 'tp-side' });

    // Where it goes.
    const workspace = el('select', { class: 'sc-select' }, el('option', { value: '', text: 'Any workspace' }),
      ...spaces.map((w) => el('option', { value: w.id, text: w.name, selected: (plan.workspaceId || sync.activeWorkspace() || '') === w.id })));
    const project = el('select', { class: 'sc-select' });
    const phase = el('select', { class: 'sc-select' });
    const fillProjects = () => {
      const w = workspace.value;
      const here = plans.filter((p) => !w || (p.workspaceId || null) === w || !p.workspaceId);
      project.replaceChildren(...here.map((p) => el('option', { value: p.id, text: p.name, selected: p.id === plan.id })));
    };

    // Placed by the calendar, or held at an hour.
    const auto = el('input', { type: 'checkbox', class: 'tp-switch-box', checked: !fixed });
    const autoRow = el('label', { class: 'tp-auto' }, el('span', { class: 'tp-auto-text' }), auto, el('span', { class: 'tp-switch' }));
    const fixedDay = el('input', { class: 'sc-input', type: 'date', value: day || nowIso() });
    const fixedFrom = el('input', { class: 'sc-input', type: 'time', step: 900, value: hhmm(start ?? 9 * 60) });
    const whenBox = el('div', { class: 'tp-when' }, fixedDay, fixedFrom);

    const firstLength = end !== null && start !== null ? end - start : 30;
    const duration = el('select', { class: 'sc-select' }, ...[...new Set([...DURATIONS, firstLength])].sort((a, b) => a - b)
      .map((m) => el('option', { value: m, text: minText(m), selected: m === firstLength })));
    const chunk = el('select', { class: 'sc-select' },
      el('option', { value: '', text: 'The plan’s block size' }),
      ...BLOCK_CHOICES.map((h) => el('option', { value: h, text: minText(h * 60) })),
      el('option', { value: 'whole', text: 'No chunks — one sitting' }));
    const startDate = el('input', { class: 'sc-input', type: 'date', value: day || nowIso() });
    const deadline = el('input', { class: 'sc-input', type: 'date', value: day || '' });
    const hard = el('input', { type: 'checkbox', class: 'tp-switch-box' });
    const hardRow = el('label', { class: 'tp-hard', title: 'A hard deadline must hold: it is placed ahead of soft ones, and it is the soft ones that slip.' },
      el('span', { class: 'sc-faint', text: 'Hard deadline' }), hard, el('span', { class: 'tp-switch' }));
    const urgency = el('select', { class: 'sc-select' }, ...Object.entries(URGENCIES).map(([id, u]) => el('option', { value: id, text: u.label, selected: id === 'normal' })));
    const labels = el('input', { class: 'sc-input', type: 'text', placeholder: 'None — comma-separated' });
    let assignee, stage, schedule, custom = [];
    const rows = {};
    const fact = (key, label, value) => (rows[key] = el('div', { class: 'fact' }, el('span', { class: 'fact-label', text: label }), value));

    const drawPlanParts = () => {
      assignee = el('select', { class: 'sc-select' }, el('option', { value: '', text: 'Nobody' }),
        ...plan.resources.filter((r) => r.type === 'work').map((r, i) => el('option', { value: r.id, text: r.name, selected: i === 0 })));
      stage = el('select', { class: 'sc-select' }, ...stages(plan).map((st) => el('option', { value: st.id, text: st.name })));
      schedule = el('select', { class: 'sc-select' }, el('option', { value: '', text: 'Any — the plan’s default hours' }),
        ...timeBlocks(plan).map((b) => el('option', { value: b.id, text: b.name })));
      phase.replaceChildren(el('option', { value: '', text: phases(plan).length ? 'No stage' : 'No stages in this project' }),
        ...phases(plan).map((ph) => el('option', { value: ph.id, text: ph.name, selected: ph.id === plan.currentPhaseId })));
      phase.disabled = !phases(plan).length;
      custom = fieldsOf(plan).map((f) => ({ field: f, ...fieldInput(plan, f, null) }));
      clear(side);
      side.append(
        el('div', { class: 'tp-where' },
          fact('workspace', 'Workspace', workspace),
          fact('project', 'Project', project),
          fact('phase', 'Stage', phase)),
        autoRow,
        fact('when', 'When', whenBox),
        el('div', { class: 'tp-group' },
          fact('assignee', 'Assignee', assignee),
          fact('status', 'Status', stage),
          fact('priority', 'Priority', urgency)),
        el('div', { class: 'tp-group' },
          fact('duration', 'Duration', duration),
          fact('chunk', 'Min chunk', chunk),
          fact('start', 'Start date', startDate),
          fact('deadline', 'Deadline', el('div', { class: 'tp-deadline' }, deadline, hardRow)),
          fact('schedule', 'Schedule', schedule)),
        el('div', { class: 'tp-group' },
          fact('labels', 'Labels', labels),
          ...custom.map((c) => fact(`f_${c.field.id}`, c.field.name, c.node)),
          fields.length ? null : el('div', { class: 'sc-faint small tp-fields-hint', text: 'Custom fields: Project ▸ Custom fields…' })));
      showMode();
    };
    let fields = [];
    const showMode = () => {
      fields = fieldsOf(plan);
      const isAuto = auto.checked;
      autoRow.classList.toggle('is-on', isAuto);
      autoRow.querySelector('.tp-auto-text').textContent = isAuto ? '✦ Auto-scheduled — the calendar places it' : `⌖ Fixed time — held at ${formatClock(parseTime(fixedFrom.value) ?? 0)}`;
      rows.when.hidden = isAuto;
      rows.chunk.hidden = !isAuto;
      rows.start.hidden = !isAuto;
      rows.schedule.hidden = !isAuto;
    };
    auto.addEventListener('change', showMode);
    fixedFrom.addEventListener('change', showMode);
    workspace.addEventListener('change', async () => { fillProjects(); plan = await planOf(project.value); drawPlanParts(); });
    project.addEventListener('change', async () => { plan = await planOf(project.value); drawPlanParts(); });
    fillProjects();
    drawPlanParts();

    const save = () => {
      const isAuto = auto.checked;
      const minutes = +duration.value;
      const from = parseTime(fixedFrom.value);
      close({
        planId: project.value, phaseId: phase.value || null, name: name.value.trim(), notes: notes.value,
        resourceId: assignee.value || null, stageId: stage.value, urgency: urgency.value, minutes,
        blockHours: isAuto && chunk.value && chunk.value !== 'whole' ? +chunk.value : null,
        whole: isAuto && chunk.value === 'whole',
        startDay: isAuto ? (startDate.value || null) : fixedDay.value,
        deadline: deadline.value || null, hardDeadline: hard.checked && !!deadline.value,
        timeBlockId: isAuto ? (schedule.value || null) : null,
        labels: labels.value.split(',').map((x) => x.trim()).filter(Boolean),
        fixed: isAuto ? null : { day: fixedDay.value, start: from, minutes: Math.min(minutes, 24 * 60 - (from ?? 0)) },
        fields: Object.fromEntries(custom.map((c) => [c.field.id, c.get()]).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length))),
      });
    };
    setTimeout(() => document.querySelector('.tp-sheet')?.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); save(); }
      if (e.key === 'Enter' && e.target === name) { e.preventDefault(); save(); }
    }), 0);
    close.onSave = save;

    return [
      el('div', { class: 'tp-sheet' },
        el('div', { class: 'tp-main' },
          el('div', { class: 'sheet-head' }, el('span', { class: 'sc-pill sheet-chip', text: '☑ Task' })),
          name, notes),
        side),
      foot(el('span', { class: 'sc-spacer' }), button('Cancel  Esc', () => close(null)), button('Save task  ⌘S', save, 'sc-button--primary')),
    ];
  }, { wide: true });
  if (!answer) return null;
  if (!answer.name) { act.hint('A task needs a name.'); return null; }
  if (answer.fixed && !(answer.fixed.minutes >= 5 && answer.fixed.start !== null)) { act.hint('A task at a fixed time needs a start and a length.'); return null; }

  // A task in another project is made there: that plan is opened first.
  if (answer.planId !== store.project.id && !(await sync.openPlan(answer.planId))) return null;
  // A day that has gone cannot be booked; a fixed task put there happened.
  // Earlier today is still today: it stays a task at that hour, as placed.
  const past = answer.fixed && answer.fixed.day < nowIso();
  const t = past
    ? act.newTaskDoneAt({ name: answer.name, day: answer.fixed.day, start: answer.fixed.start, minutes: answer.fixed.minutes, notes: answer.notes })
    : act.createTask(answer);
  if (!t) return null;
  act.hint(past ? `That time has passed, so “${t.name}” is logged as done then.`
    : answer.fixed ? `“${t.name}” is fixed at ${formatClock(answer.fixed.start)} on ${formatDate(answer.fixed.day, 'day')}.`
      : `“${t.name}” is on the calendar, placed by it${answer.deadline ? ` to finish by ${formatDate(answer.deadline, 'day')}${answer.hardDeadline ? ' (hard)' : ''}` : ''}.`);
  set({});
  // Show where it went: the week it landed in, with the block picked out.
  // At eleven at night an auto-scheduled task is tomorrow's, not where the
  // click was, and a task that appears somewhere else looks like no task.
  const cal = await import('./calendar.js');
  const first = cal.currentLayout().all.blocks.filter((b) => b.taskId === t.id && b.planId === store.project.id).sort((a, b) => a.day - b.day || a.start - b.start)[0];
  if (first && store.ui.view === 'calendar') { cal.goToWeek(first.day); set({}); cal.flashTask(t.id); }
  return t;
}
