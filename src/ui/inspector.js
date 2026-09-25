// The right-hand panel: the selected task, the selected resource, or the project.

import { el, clear, formatMoney, formatHours } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { CONSTRAINTS, LINK_TYPES, RESOURCE_TYPES, taskIndex, isAncestor, linkError, getResource, timesheetsFor, stages, stageOf } from '../model/model.js';
import { formatDate, formatDuration, fromDay, today, WEEKDAY_NAMES } from '../model/calendar.js';
import { BLOCK_CHOICES, GAP_CHOICES, LOAD_CHOICES, CAP_CHOICES, DEFAULT_AGENDA, agendaOf, formatTime, hoursLeft } from '../model/agenda.js';
import { hueColour } from './calendar.js';
import { timeBlocks, phases, feeds, PROVIDERS, URGENCIES, urgencyOf } from '../model/model.js';
import { tryCommit } from '../state/store.js';

const field = (label, input, hint) => el('label', { class: 'sc-field' }, el('span', { class: 'sc-label', text: label }), input, hint ? el('span', { class: 'sc-faint field-hint', text: hint }) : null);
const readout = (rows) => el('div', { class: 'readout sc-mono' }, ...rows.map(([k, v]) => el('div', { class: 'readout-row' }, el('span', { class: 'sc-muted', text: k }), el('span', { text: v }))));
const dayNames = (days) => (!days || days.length === 7 ? 'every day'
  : days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d)) ? 'weekdays'
  : days.map((d) => WEEKDAY_NAMES[d].slice(0, 3)).join(' '));

const stopKeys = (input) => { input.addEventListener('keydown', (e) => e.stopPropagation()); return input; };
const text = (value, onchange, attrs = {}) => stopKeys(el('input', { class: 'sc-input', type: 'text', value, spellcheck: false, onchange: (e) => onchange(e.target.value), ...attrs }));
const date = (value, onchange) => stopKeys(el('input', { class: 'sc-input', type: 'date', value: value || '', onchange: (e) => onchange(e.target.value) }));
const select = (value, options, onchange) => el('select', { class: 'sc-select', onchange: (e) => onchange(e.target.value) }, ...options.map((o) => el('option', { value: o.value, text: o.label, selected: o.value === value })));

export function renderInspector(root) {
  const { ui } = store;
  clear(root);
  if (ui.rightTab === 'resource') renderResource(root);
  else if (ui.rightTab === 'project') renderProject(root);
  else renderTask(root);
}

function renderTask(root) {
  const { project, schedule } = store;
  const t = act.activeTask();
  if (!t) { root.append(el('p', { class: 'empty-note sc-muted', text: 'Select a task to see and edit its details.' })); return; }
  const s = schedule.tasks[t.id];
  const id = t.id;
  const setF = (f) => (v) => act.editTask(id, f, v);
  root.append(el('div', { class: 'sc-panel sc-brackets insp-head' },
    el('div', { class: 'sc-label', text: `Task ${s.index} · WBS ${s.wbs}${s.summary ? ' · summary' : s.milestone ? ' · milestone' : ''}` }),
    el('div', { class: 'sc-display insp-title', text: t.name }),
    el('div', { class: 'row insp-pills' },
      s.critical ? el('span', { class: 'sc-pill', style: { '--tint': 'var(--sc-danger)' }, text: 'Critical' }) : el('span', { class: 'sc-pill', text: `Slack ${s.slack}d` }),
      s.percent === 100 ? el('span', { class: 'sc-pill', style: { '--tint': 'var(--sc-success)' }, text: 'Complete' }) : null,
      s.deadlineMissed ? el('span', { class: 'sc-pill', style: { '--tint': 'var(--sc-danger)' }, text: 'Deadline missed' }) : null)));

  const form = el('div', { class: 'insp-form' });
  form.append(field('Name', text(t.name, setF('name'))));
  if (!s.summary) {
    form.append(el('div', { class: 'two' },
      field('Duration', text(formatDuration(t.duration), setF('duration')), 'how long it is open: 5d · 2w'),
      field('Work', text(t.work == null ? '' : String(t.work), setF('work')),
        t.work == null ? `${formatHours(s.work)} implied by the assignment` : `${Math.round((s.work / Math.max(1, s.duration)) * 10) / 10}h a day over ${formatDuration(s.duration)}`)));
    form.append(el('div', { class: 'two' },
      field('% complete', text(String(t.percent), setF('percent'))),
      field('Urgency', select(urgencyOf(t), Object.entries(URGENCIES).map(([value, u]) => ({ value, label: u.label })), setF('urgency')),
        'who gets the earliest hours')));
    form.append(el('label', { class: 'row check-row' }, el('input', { class: 'sc-check', type: 'checkbox', checked: !!t.milestone, onchange: (e) => act.editTask(id, 'milestone', e.target.checked) }), el('span', { text: 'Milestone (zero duration)' })));
    form.append(field('Stage', select(stageOf(project, t).id, stages(project).map((st) => ({ value: st.id, label: st.name })), (v) => act.setTaskStage(id, v)), 'the Kanban column this task sits in'));
  } else form.append(el('p', { class: 'sc-muted small', text: `Summary of ${s.children.length} subtasks: ${formatDuration(s.duration)}, ${s.percent}% complete. Its dates come from them.` }));
  form.append(el('div', { class: 'two' },
    field('Start', date(s.startIso, setF('start')), s.summary ? 'from subtasks' : 'typing a date pins it'),
    field('Finish', date(s.finishIso, setF('finish')), s.summary ? 'from subtasks' : 'changes the duration')));
  if (!s.summary) {
    form.append(el('div', { class: 'two' },
      field('Constraint', select(t.constraint?.type || 'ASAP', Object.entries(CONSTRAINTS).map(([value, c]) => ({ value, label: c.label })), setF('constraintType'))),
      CONSTRAINTS[t.constraint?.type || 'ASAP'].dated ? field('Constraint date', date(t.constraint.date, setF('constraintDate'))) : el('span')));
  }
  form.append(el('div', { class: 'two' }, field('Deadline', date(t.deadline, setF('deadline'))), field('Fixed cost', text(String(t.fixedCost || 0), setF('fixedCost')))));
  form.append(field('Notes', stopKeys(el('textarea', { class: 'sc-textarea', rows: 3, value: t.notes, onchange: (e) => act.editTask(id, 'notes', e.target.value) }))));
  root.append(form);

  // ---- calendar: whether this task gets hours in the week, and which
  if (!s.summary && !s.milestone) {
    const a = agendaOf(project, t);
    root.append(el('div', { class: 'sc-section-title', text: 'Calendar' }));
    const cal = el('div', { class: 'insp-form' });
    cal.append(el('label', { class: 'row check-row' },
      el('input', { class: 'sc-check', type: 'checkbox', checked: a.show, onchange: (e) => act.editTask(id, 'calendarShow', e.target.checked) }),
      el('span', { text: 'Show in calendar' })));
    if (a.show) {
      cal.append(el('div', { class: 'two' },
        field('Block size', select(String(a.blockHours), BLOCK_CHOICES.map((h) => ({ value: String(h), label: h === 0.5 ? 'Half an hour' : `${h} hour${h === 1 ? '' : 's'}` })), (v) => act.editTask(id, 'blockHours', v)),
          `${Math.ceil((hoursLeft(project, s, t) || 0) / a.blockHours)} block(s) to place`),
        el('span')));
      cal.append(el('button', {
        class: 'sc-button sc-button--ghost sc-button--sm tb-edit-link',
        text: 'Edit time blocks…',
        title: 'The hours each kind of work is allowed, in Project information',
        onclick: () => { set({ rightTab: 'project' }); requestAnimationFrame(() => document.querySelector('.tb-card')?.scrollIntoView({ block: 'center' })); },
      }));
      cal.append(field('Time block',
        select(t.calendar?.timeBlockId || '', [{ value: '', label: `Plan default — ${a.timeBlock ? a.timeBlock.name : 'working hours'}` },
          ...timeBlocks(project).map((b) => ({ value: b.id, label: `${b.name} · ${b.from}–${b.to}` }))],
          (v) => act.setTaskTimeBlock(id, v)),
        a.timeBlock ? `${formatTime(a.from)}–${formatTime(a.to)} on ${dayNames(a.days)}` : 'the hours this task may use'));
      cal.append(el('button', { class: 'sc-button sc-button--sm', text: 'Break into subtasks…', onclick: () => act.breakUpDialog(id) }));
    }
    root.append(cal);
  }

  root.append(el('div', { class: 'sc-section-title', text: 'Schedule' }));
  root.append(readout([
    ['Early start', formatDate(s.startIso)], ['Early finish', formatDate(s.finishIso)],
    ['Late start', formatDate(fromDay(s.ls))], ['Late finish', formatDate(fromDay(s.lf))],
    ['Total slack', `${s.slack} d`], ['Work', formatHours(s.work)], ['Cost', formatMoney(s.cost, project.currency)],
  ]));

  // predecessors
  root.append(el('div', { class: 'sc-section-title', text: 'Predecessors' }));
  const preds = el('div', { class: 'link-list' });
  const i = taskIndex(project, id);
  const candidates = project.tasks.map((x, j) => ({ x, j })).filter(({ x, j }) => x.id !== id && !isAncestor(project, j, i) && !isAncestor(project, i, j));
  for (const l of t.predecessors) {
    const p = project.tasks[taskIndex(project, l.id)];
    if (!p) continue;
    preds.append(el('div', { class: 'link-row' },
      select(l.id, candidates.map(({ x, j }) => ({ value: x.id, label: `${j + 1} ${x.name}` })), (v) => { if (!linkError(project, v, id) || v === l.id) tryCommit('Change link', (pr) => { const tt = pr.tasks.find((a) => a.id === id); const ll = tt.predecessors.find((a) => a.id === l.id); ll.id = v; if (tt.predecessors.filter((a) => a.id === v).length > 1) tt.predecessors = tt.predecessors.filter((a) => a !== ll); }); else act.hint(linkError(project, v, id)); }),
      select(l.type, Object.entries(LINK_TYPES).map(([value, label]) => ({ value, label: value, title: label })), (v) => tryCommit('Link type', (pr) => { pr.tasks.find((a) => a.id === id).predecessors.find((a) => a.id === l.id).type = v; })),
      text(`${l.lag || 0}d`, (v) => tryCommit('Link lag', (pr) => { const n = parseFloat(v); if (Number.isNaN(n)) throw new Error('Lag is a number of days, e.g. 2 or -1.'); pr.tasks.find((a) => a.id === id).predecessors.find((a) => a.id === l.id).lag = n; }), { class: 'sc-input lag', title: 'Lag in working days (negative for lead)' }),
      el('button', { class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', text: '✕', title: 'Remove link', onclick: () => act.unlinkTasks(l.id, id) })));
  }
  const addSel = select('', [{ value: '', label: '+ Add predecessor…' }, ...candidates.filter(({ x }) => !t.predecessors.some((l) => l.id === x.id)).map(({ x, j }) => ({ value: x.id, label: `${j + 1} ${x.name}` }))], (v) => { if (v) act.linkTasks(v, id); });
  preds.append(addSel);
  root.append(preds);

  // resources
  root.append(el('div', { class: 'sc-section-title', text: 'Resources' }));
  const res = el('div', { class: 'link-list' });
  for (const a of t.assignments) {
    const r = getResource(project, a.resourceId);
    if (!r) continue;
    res.append(el('div', { class: 'link-row' },
      select(r.id, project.resources.map((x) => ({ value: x.id, label: x.name })), (v) => { act.unassignResource(id, r.id); act.assignResource(id, v, a.units); }),
      text(r.type === 'work' ? `${Math.round(a.units * 100)}%` : String(a.units), (v) => { const n = parseFloat(v); if (Number.isNaN(n)) { act.hint('Units is a number.'); return; } act.assignResource(id, r.id, r.type === 'work' ? (n > 5 ? n / 100 : n) : n); }, { class: 'sc-input lag', title: r.type === 'work' ? 'Units, as a percentage of the resource' : 'Quantity' }),
      el('button', { class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', text: '✕', title: 'Unassign', onclick: () => act.unassignResource(id, r.id) })));
  }
  const free = project.resources.filter((r) => !t.assignments.some((a) => a.resourceId === r.id));
  res.append(select('', [{ value: '', label: project.resources.length ? '+ Assign resource…' : '+ New resource…' }, ...free.map((r) => ({ value: r.id, label: r.name })), { value: '__new', label: '＋ New resource…' }], async (v) => {
    if (v === '__new') { const r = act.newResource(); set({ editing: null, view: store.ui.view }); act.assignResource(id, r.id, 1); set({ rightTab: 'resource' }); }
    else if (v) act.assignResource(id, v, 1);
  }));
  root.append(res);

  // ---- time: what was expected, what was spent, what is left
  if (!s.summary || timesheetsFor(project, id).length) {
    root.append(el('div', { class: 'sc-section-title', text: 'Time' }));
    root.append(readout([
      ['Allocated', formatHours(s.work)],
      ['Spent', formatHours(s.spent)],
      ['Remaining', formatHours(s.remaining)],
    ]));
    const lines = el('div', { class: 'link-list' });
    for (const line of timesheetsFor(project, id)) {
      const who = getResource(project, line.resourceId);
      lines.append(el('div', { class: 'time-row' },
        date(line.date, (v) => act.editTimeLine(line.id, 'date', v)),
        select(line.resourceId || '', [{ value: '', label: '—' }, ...project.resources.map((r) => ({ value: r.id, label: r.initials || r.name }))], (v) => act.editTimeLine(line.id, 'resourceId', v)),
        text(String(line.hours), (v) => act.editTimeLine(line.id, 'hours', v), { class: 'sc-input lag', title: 'Hours' }),
        el('button', { class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', text: '✕', title: 'Remove this line', onclick: () => act.deleteTimeLine(line.id) })));
      if (line.note) lines.append(el('div', { class: 'sc-faint small time-note', text: line.note }));
    }
    const newDate = el('input', { class: 'sc-input', type: 'date', value: today() });
    const newWho = el('select', { class: 'sc-select' }, el('option', { value: '', text: '—' }),
      ...project.resources.map((r) => el('option', { value: r.id, text: r.initials || r.name })));
    const newHours = el('input', { class: 'sc-input lag', type: 'text', placeholder: 'h' });
    if (t.assignments.length) newWho.value = t.assignments[0].resourceId;
    for (const input of [newHours]) input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') addLine(); });
    const addLine = () => {
      if (!newHours.value.trim()) { act.hint('How many hours?'); newHours.focus(); return; }
      if (act.logTime({ taskId: id, resourceId: newWho.value || null, date: newDate.value || null, hours: newHours.value })) newHours.value = '';
    };
    lines.append(el('div', { class: 'time-row' }, newDate, newWho, newHours,
      el('button', { class: 'sc-button sc-button--sm', text: '+', title: 'Log this time', onclick: addLine })));
    root.append(lines);
  }
}

function renderResource(root) {
  const { project, schedule, ui } = store;
  const r = getResource(project, ui.resourceId);
  if (!r) { root.append(el('p', { class: 'empty-note sc-muted', text: 'Select a resource in the Resource Sheet or Resource Usage view.' })); return; }
  const setF = (f) => (v) => act.editResource(r.id, f, v);
  root.append(el('div', { class: 'sc-panel sc-brackets insp-head' }, el('div', { class: 'sc-label', text: `${RESOURCE_TYPES[r.type]} resource` }), el('div', { class: 'sc-display insp-title', text: r.name })));
  const form = el('div', { class: 'insp-form' });
  form.append(el('div', { class: 'two' }, field('Name', text(r.name, setF('name'))), field('Initials', text(r.initials, setF('initials')))));
  form.append(el('div', { class: 'two' },
    field('Type', select(r.type, Object.entries(RESOURCE_TYPES).map(([value, label]) => ({ value, label })), setF('type'))),
    r.type === 'work' ? field('Max units', text(`${Math.round(r.maxUnits * 100)}%`, setF('maxUnits'))) : el('span')));
  form.append(el('div', { class: 'two' }, field(r.type === 'work' ? 'Rate per hour' : 'Rate per unit', text(String(r.rate), setF('rate'))), field('Group', text(r.group, setF('group')))));
  root.append(form);
  root.append(el('div', { class: 'sc-section-title', text: 'Assigned tasks' }));
  const list = el('div', { class: 'assign-list' });
  const tasks = project.tasks.filter((t) => t.assignments.some((a) => a.resourceId === r.id));
  if (!tasks.length) list.append(el('p', { class: 'sc-muted small', text: 'Nothing assigned.' }));
  for (const t of tasks) {
    const s = schedule.tasks[t.id];
    const a = t.assignments.find((x) => x.resourceId === r.id);
    list.append(el('button', { class: 'link-item', onclick: () => { set({ view: ['gantt', 'sheet'].includes(ui.view) ? ui.view : 'gantt', rightTab: 'task' }); act.selectTask(t.id); act.revealTask(t.id); } },
      el('span', { class: 'grow', text: `${s.index} ${t.name}` }), el('span', { class: 'sc-mono sc-muted', text: `${formatDate(s.startIso, 'day')} – ${formatDate(s.finishIso, 'day')}${a.units !== 1 ? ` · ${Math.round(a.units * 100)}%` : ''}` })));
  }
  root.append(list);
  root.append(el('div', { class: 'insp-actions' }, el('button', { class: 'sc-button sc-button--danger sc-button--sm', text: 'Delete resource', onclick: () => act.deleteResource(r.id) })));
}

function renderProject(root) {
  const { project, schedule } = store;
  root.append(el('div', { class: 'sc-panel sc-brackets insp-head' }, el('div', { class: 'sc-label', text: 'Project' }), el('div', { class: 'sc-display insp-title', text: project.name })));
  const form = el('div', { class: 'insp-form' });
  form.append(field('Name', text(project.name, (v) => act.setProjectInfo({ name: v }))));
  form.append(el('div', { class: 'two' },
    field('Start date', date(project.start, (v) => { if (v) act.setProjectInfo({ start: v }); }), 'tasks with no links start here'),
    field('Status date', date(project.statusDate, (v) => act.setProjectInfo({ statusDate: v })), 'blank = today')));
  form.append(el('div', { class: 'two' },
    field('Currency symbol', text(project.currency, (v) => act.setProjectInfo({ currency: v }))),
    field('Hours per day', text(String(project.calendar.hoursPerDay), (v) => { const n = parseFloat(v); if (n > 0 && n <= 24) act.setCalendar({ hoursPerDay: n }); else act.hint('Hours per day is a number from 1 to 24.'); }))));
  const days = el('div', { class: 'workdays' }, ...[1, 2, 3, 4, 5, 6, 0].map((d) => el('label', { class: 'row check-row' },
    el('input', { class: 'sc-check', type: 'checkbox', checked: project.calendar.workDays.includes(d), onchange: (e) => { const wd = new Set(project.calendar.workDays); if (e.target.checked) wd.add(d); else wd.delete(d); if (!wd.size) { act.hint('At least one working day is needed.'); e.target.checked = true; return; } act.setCalendar({ workDays: [...wd].sort() }); } }),
    el('span', { text: WEEKDAY_NAMES[d].slice(0, 3) }))));
  form.append(field('Working days', days));
  form.append(el('div', { class: 'two' },
    field('Default block size', select(String((project.agenda || {}).blockHours || 1),
      BLOCK_CHOICES.map((h) => ({ value: String(h), label: h === 0.5 ? 'Half an hour' : `${h} hour${h === 1 ? '' : 's'}` })), (v) => act.setAgenda({ blockHours: +v })),
      'what a task uses unless it says otherwise'),
    field('Default time block', select((project.agenda || {}).timeBlockId || '',
      timeBlocks(project).map((b) => ({ value: b.id, label: b.name })), (v) => act.setAgenda({ timeBlockId: v })),
      'the hours a task uses unless it says otherwise')));
  form.append(el('div', { class: 'two' },
    field('Gap between blocks', select(String((project.agenda || {}).gapMinutes ?? 0),
      GAP_CHOICES.map((m) => ({ value: String(m), label: m === 0 ? 'None — back to back' : `${m} minutes` })), (v) => act.setAgenda({ gapMinutes: +v })),
      'breathing room after every block'),
    field('Most work in a day', select(String((project.agenda || {}).dailyCap ?? DEFAULT_AGENDA.dailyCap),
      CAP_CHOICES.map((h) => ({ value: String(h), label: `${h} hours` })), (v) => act.setAgenda({ dailyCap: +v })),
      'per person, so a day is never filled wall to wall')));
  form.append(field('When a task does not say its hours', select(String((project.agenda || {}).assumedLoad ?? DEFAULT_AGENDA.assumedLoad),
    LOAD_CHOICES.map((n) => ({ value: String(n), label: n === 100 ? 'All of its duration — full time' : `${n}% of its duration` })), (v) => act.setAgenda({ assumedLoad: +v })),
    'a five-day task is rarely five days of doing it; state a task’s work to override this'));
  // The colour this project wears on a shared calendar.
  const swatches = el('div', { class: 'colour-row' });
  const own = project.colour !== null && project.colour !== undefined && Number.isFinite(+project.colour) ? Math.round(+project.colour) : null;
  swatches.append(el('button', {
    class: `colour-chip is-auto${own === null ? ' is-on' : ''}`, title: 'Let the calendar choose, spaced away from the other projects',
    text: 'Auto', onclick: () => act.setProjectInfo({ colour: null }),
  }));
  for (let h = 0; h < 360; h += 30) {
    swatches.append(el('button', {
      class: `colour-chip${own === h ? ' is-on' : ''}`, title: `Hue ${h}`,
      style: { background: hueColour(h).fill, borderColor: hueColour(h).line },
      onclick: () => act.setProjectInfo({ colour: h }),
    }));
  }
  form.append(field('Calendar colour', swatches, 'what this project is drawn in when the calendar colours by project'));
  form.append(field('Holidays', stopKeys(el('textarea', { class: 'sc-textarea sc-mono', rows: 4, value: project.calendar.holidays.join('\n'), onchange: (e) => {
    const list = e.target.value.split(/[\n,;\s]+/).map((x) => x.trim()).filter(Boolean);
    const bad = list.filter((x) => !/^\d{4}-\d{2}-\d{2}$/.test(x));
    if (bad.length) { act.hint(`Not a date: ${bad[0]} (use YYYY-MM-DD, one per line).`); return; }
    act.setCalendar({ holidays: [...new Set(list)].sort() });
  } })), 'one date per line, YYYY-MM-DD'));
  root.append(form);
  // ---- the phase the plan is in, which is what the calendar releases
  const phaseList = phases(project);
  if (phaseList.length) {
    root.append(el('div', { class: 'sc-section-title', text: 'Phase' }));
    root.append(field('Working on',
      select(project.currentPhaseId || '', [{ value: '', label: 'Every phase' }, ...phaseList.map((ph) => ({ value: ph.id, label: ph.name }))],
        (v) => act.setCurrentPhase(v)),
      'only this phase’s tasks are put on the calendar'));
  }

  // ---- connected calendars: real meetings, so work goes around them
  root.append(el('div', { class: 'sc-section-title', text: 'Connected calendars' }));
  root.append(el('p', { class: 'sc-muted small', text: 'Google and Outlook each hand out a private iCalendar address for a calendar. Paste one here and its meetings become busy hours the calendar schedules around.' }));
  const list = el('div', { class: 'link-list' });
  for (const f of feeds(project)) {
    list.append(el('div', { class: 'tb-card sc-card' },
      el('div', { class: 'tb-row feed-row' },
        text(f.name, (v) => act.editCalendar(f.id, 'name', v)),
        select(f.resourceId || '', [{ value: '', label: 'Me / unassigned' }, ...project.resources.map((r) => ({ value: r.id, label: r.name }))], (v) => act.editCalendar(f.id, 'resourceId', v)),
        el('button', { class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', text: '↻', title: 'Read it again', onclick: () => act.refreshCalendar(f.id) }),
        el('button', { class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', text: '✕', title: 'Disconnect', onclick: () => act.disconnectCalendar(f.id) })),
      el('div', { class: 'sc-faint small', text: `${PROVIDERS[f.provider]} · ${f.events.length} busy event${f.events.length === 1 ? '' : 's'}${f.fetchedAt ? ` · read ${new Date(f.fetchedAt).toLocaleString()}` : ' · not read yet'}` })));
  }
  list.append(el('button', { class: 'sc-button sc-button--sm', text: '+ Connect a calendar…', onclick: () => act.connectCalendarDialog() }));
  root.append(list);

  // ---- time blocks: the hours of the week that are for a kind of work
  root.append(el('div', { class: 'sc-section-title', text: 'Time blocks' }));
  root.append(el('p', { class: 'sc-muted small', text: 'The hours a kind of work is allowed. A task belongs to one, and the calendar releases it into those hours by itself.' }));
  const blocks = el('div', { class: 'link-list' });
  for (const b of timeBlocks(project)) {
    const days = el('div', { class: 'workdays tb-days' }, ...[1, 2, 3, 4, 5, 6, 0].map((d) => el('label', { class: 'row check-row', title: WEEKDAY_NAMES[d] },
      el('input', { class: 'sc-check', type: 'checkbox', checked: b.days.includes(d), onchange: (e) => {
        const next = e.target.checked ? [...b.days, d] : b.days.filter((x) => x !== d);
        if (!act.editTimeBlock(b.id, 'days', next)) e.target.checked = !e.target.checked;
      } }),
      el('span', { text: WEEKDAY_NAMES[d][0] }))));
    blocks.append(el('div', { class: 'tb-card sc-card' },
      el('div', { class: 'tb-row' },
        text(b.name, (v) => act.editTimeBlock(b.id, 'name', v)),
        text(b.from, (v) => act.editTimeBlock(b.id, 'from', v), { class: 'sc-input lag', title: 'Starts' }),
        text(b.to, (v) => act.editTimeBlock(b.id, 'to', v), { class: 'sc-input lag', title: 'Ends' }),
        el('button', { class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', text: '✕', title: 'Delete this block', onclick: () => act.deleteTimeBlock(b.id) })),
      days));
  }
  blocks.append(el('button', { class: 'sc-button sc-button--sm', text: '+ New time block', onclick: () => act.newTimeBlock({ name: 'New block' }) }));
  root.append(blocks);

  root.append(el('div', { class: 'sc-section-title', text: 'Statistics' }));
  root.append(readout([
    ['Start', formatDate(schedule.startIso)], ['Finish', formatDate(schedule.finishIso)], ['Duration', `${schedule.duration} d`],
    ['Work', formatHours(schedule.work)], ['Cost', formatMoney(schedule.cost, project.currency)], ['Complete', `${schedule.percent}%`],
    ['Tasks', String(project.tasks.length)], ['Critical', String(schedule.criticalCount)], ['Resources', String(project.resources.length)],
  ]));
}
