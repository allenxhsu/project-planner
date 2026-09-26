// The project, opened — Motion's project window, three columns wide.
//
// Left: the name, the description and the project's history with a box to
// comment in. Middle: how it stands (missed deadline, on track, or no ETA),
// its workspace and the stage it is in, then owner, status, dates, priority,
// colour and labels. Right: its tasks, stage by stage, under a strip that
// puts the stages on a line of dates — each stage with its dates, its tasks
// and a menu to extend it, fix what runs past it, complete, cancel or move it.
//
// Edits apply as they are made, like the task list beside it; the window
// redraws on every change while it is open.

import { el, clear } from '../util.js';
import { store, set, subscribe } from '../state/store.js';
import * as act from '../state/actions.js';
import { phases, getPhase, phaseOf, isSummary, URGENCIES, urgencyOf, stages, stageOf } from '../model/model.js';
import { PROJECT_STATUSES, stageRange, stageStatus, stageHealth, stageTasks, stageColour } from '../model/stages.js';
import { hoursLeft, expectedHours, agendaOf, formatClock } from '../model/agenda.js';
import { toDay, fromDay, today, formatDate, WEEKDAY_NAMES, weekday, makeCalendar } from '../model/calendar.js';
import { open, foot, button, showMenu, showPanel, promptText, confirmDialog } from './dialog.js';
import { datePanel, quickDates } from './datepick.js';
import { currentLayout, personColour } from './calendar.js';
import { taskSheet } from './blockmenu.js';

const HUES = [null, 0, 25, 45, 90, 140, 170, 200, 220, 260, 290, 320];
const hueCss = (h) => (h === null || h === undefined ? 'var(--sc-text-3)' : `hsl(${h} 60% 55%)`);
const two = (n) => String(n).padStart(2, '0');
const shortDay = (iso) => (iso ? `${WEEKDAY_NAMES[weekday(toDay(iso))].slice(0, 2)} ${+iso.slice(5, 7)}/${+iso.slice(8, 10)}` : '—');
const mdY = (iso) => `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}/${iso.slice(2, 4)}`;
const minText = (m) => (m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`);
function ago(at) {
  const min = Math.round((Date.now() - new Date(`${at}:00`).getTime()) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 1440) return `${Math.round(min / 60)} h ago`;
  const days = Math.round(min / 1440);
  if (days < 31) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30.4);
  return months < 12 ? `${months} month${months === 1 ? '' : 's'} ago` : `${Math.round(months / 12)} year${months < 18 ? '' : 's'} ago`;
}

/** Open a project's window. Opens the plan first when it is not the open one. */
export async function projectSheet({ planId = store.project.id } = {}) {
  if (planId !== store.project.id) {
    const { openPlan } = await import('../state/sync.js');
    if (!(await openPlan(planId))) return;
  }
  const sync = await import('../state/sync.js');
  const spaces = await sync.listWorkspaces().catch(() => []);
  let unsubscribe = () => {};
  await open(store.project.name, (close) => {
    const root = el('div', { class: 'ps' });
    const ui = { adding: null, collapsed: new Set() };
    const draw = () => {
      // Keep focus and scroll where they were across a redraw.
      const scroll = [...root.querySelectorAll('.ps-col')].map((c) => c.scrollTop);
      clear(root);
      root.append(leftColumn(), middleColumn(close, spaces), rightColumn(ui, draw, close));
      [...root.querySelectorAll('.ps-col')].forEach((c, i) => { c.scrollTop = scroll[i] || 0; });
    };
    draw();
    let lastRev = -1;
    unsubscribe = subscribe(() => { if (store._rev !== lastRev) { lastRev = store._rev; if (document.body.contains(root)) draw(); } });
    return [root];
  }, { wide: true });
  unsubscribe();
}

// ---------------------------------------------------------------- left

function leftColumn() {
  const p = store.project;
  const title = el('input', { class: 'ps-title', type: 'text', value: p.name, onchange: (e) => act.editProject('name', e.target.value) });
  const desc = el('textarea', { class: 'ps-desc', rows: 8, placeholder: 'Description', value: p.description || '', onchange: (e) => act.editProject('description', e.target.value) });
  const comment = el('input', { class: 'sc-input act-input', type: 'text', placeholder: 'Enter comment — ↵ to post' });
  comment.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !comment.value.trim()) return;
    e.preventDefault(); e.stopPropagation();
    act.commentProject(comment.value);
  });
  const lines = [...(p.activity || [])].reverse().map((x) => el('li', { class: `act-item${x.kind === 'comment' ? ' is-comment' : ''}` },
    el('span', { class: 'act-dot' }),
    x.kind === 'comment' ? el('div', { class: 'act-comment', text: x.text })
      : x.kind === 'stage' ? el('span', { class: 'act-text' }, `${x.by || 'You'} changed stage from `, el('span', { class: 'ps-chip', text: x.from }), ' to ', el('span', { class: 'ps-chip', text: x.to }))
        : el('span', { class: 'act-text', text: x.from === undefined ? `Changed ${x.field}` : `Changed ${x.field} from ${x.from} to ${x.to}` }),
    el('span', { class: 'sc-faint act-at', title: x.at.replace('T', ' '), text: ago(x.at) })));
  return el('div', { class: 'ps-col ps-left' },
    el('div', { class: 'ps-crumb sc-faint small' }, el('span', { text: `▢ ${p.template ? 'Template' : 'Project'}` }),
      el('button', { class: 'sc-button sc-button--ghost sc-button--sm', text: '⚙ Settings', title: 'Working time, calendar and scheduling settings of this project',
        onclick: () => { void import('./inspector.js').then((m) => m.projectSettingsDialog()); } })),
    title, desc,
    el('details', { class: 'act', open: true }, el('summary', { text: 'Activity' }), comment,
      el('ul', { class: 'act-list' }, ...(lines.length ? lines : [el('li', { class: 'sc-faint small', text: 'Nothing recorded yet. Stage changes, dates and comments are kept here.' })]))));
}

// ---------------------------------------------------------------- middle

function projectHealth() {
  const p = store.project;
  const { all } = currentLayout();
  const todayDay = toDay(today());
  const mine = all.blocks.filter((b) => b.planId === p.id && !b.worked);
  const eta = mine.length ? fromDay(Math.max(...mine.map((b) => b.day))) : null;
  const byTask = all.byTask || new Map();
  const missed = phases(p).map((ph) => ({ ph, h: stageHealth(p, store.schedule, ph.id, { byTask, today: todayDay }) })).filter((x) => x.h.missed);
  const open = p.tasks.filter((t, i) => !isSummary(p, i) && !t.archived && (store.schedule.tasks[t.id]?.percent ?? 0) < 100);
  const pastProject = p.deadline && ((eta && eta > p.deadline) || (todayDay > toDay(p.deadline) && open.length));
  if (missed.length || pastProject) return { cls: 'is-late', text: 'Missed deadline', missed, eta };
  if (!mine.length) return { cls: 'is-off', text: open.length ? 'No ETA because there are no auto-scheduled tasks in this project' : 'Nothing left to do', missed, eta };
  return { cls: 'is-ok', text: `On track · done ${formatDate(eta, 'day')}`, missed, eta };
}

function middleColumn(close, spaces) {
  const p = store.project;
  const health = projectHealth();
  const fact = (label, node) => el('div', { class: 'fact' }, el('span', { class: 'fact-label', text: label }), node);
  const workspace = el('select', { class: 'sc-select', onchange: async (e) => {
    const sync = await import('../state/sync.js');
    await sync.setPlanWorkspace(p.id, e.target.value || null);
    set({});
  } }, el('option', { value: '', text: 'No workspace' }), ...spaces.map((w) => el('option', { value: w.id, text: w.name, selected: p.workspaceId === w.id })));
  const list = phases(p);
  const current = getPhase(p, p.currentPhaseId);
  const stagePick = el('select', { class: 'sc-select ps-stage-pick', style: current ? { '--st': stageColour(p, current) } : {}, onchange: (e) => act.goToStage(e.target.value || null) },
    el('option', { value: '', text: list.length ? 'No current stage' : 'No stages' }),
    ...list.map((ph) => el('option', { value: ph.id, text: ph.name, selected: ph.id === p.currentPhaseId })));
  const next = () => {
    const i = list.findIndex((ph) => ph.id === p.currentPhaseId);
    const n = list.slice(i + 1).find((ph) => stageStatus(ph) === 'open');
    if (n) act.goToStage(n.id); else act.hint('This is the last stage.');
  };
  const manager = el('select', { class: 'sc-select', onchange: (e) => act.editProject('managerId', e.target.value) },
    el('option', { value: '', text: 'Nobody' }), ...p.resources.filter((r) => r.type === 'work').map((r) => el('option', { value: r.id, text: r.name, selected: p.managerId === r.id })));
  const status = el('select', { class: 'sc-select', onchange: (e) => act.editProject('status', e.target.value) },
    ...PROJECT_STATUSES.map((s) => el('option', { value: s, text: s, selected: (p.status || 'Todo') === s })));
  const dateBtn = (iso, field, emptyText) => el('button', {
    class: `sc-button sc-button--sm ps-date${iso ? '' : ' is-empty'}`, text: iso ? formatDate(iso, 'long') : emptyText,
    onclick: (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      showPanel(r.left, r.bottom + 4, (shut) => datePanel({ value: iso, title: emptyText, clearable: field === 'deadline', quick: quickDates(p, [{ label: 'Project start', day: toDay(p.start) }]),
        onPick: (v) => { shut(); act.editProject(field, v); } }));
    },
  });
  const urgency = el('select', { class: 'sc-select', onchange: (e) => act.editProject('urgency', e.target.value) },
    ...Object.entries(URGENCIES).map(([id, u]) => el('option', { value: id, text: u.label, selected: (p.urgency || 'normal') === id })));
  const colours = el('div', { class: 'ps-swatches' }, ...HUES.map((h) => el('button', {
    class: `ps-swatch${(p.colour ?? null) === h ? ' is-on' : ''}`, title: h === null ? 'Automatic' : `Hue ${h}`, style: { background: hueCss(h) },
    onclick: () => act.editProject('colour', h),
  }, h === null ? 'A' : '')));
  const labels = el('input', { class: 'sc-input', type: 'text', value: (p.labels || []).join(', '), placeholder: 'None — comma-separated', onchange: (e) => act.editProject('labels', e.target.value) });
  const auto = el('input', { type: 'checkbox', class: 'tp-switch-box', checked: p.autoAdvance !== false, onchange: (e) => act.editProject('autoAdvance', e.target.checked) });
  return el('div', { class: 'ps-col ps-mid' },
    el('div', { class: `ps-state ${health.cls}` },
      el('span', { text: health.cls === 'is-late' ? '⚠ ' + health.text : health.text }),
      health.missed.length ? el('button', { class: 'ps-resolve', text: 'Resolve', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); stageMenu(health.missed[0].ph.id, r.left - 260, r.bottom + 4); } }) : null),
    el('div', { class: 'ps-group' },
      el('div', { class: 'sc-faint small', text: 'Workspace and Stage' }),
      fact('Workspace', workspace),
      el('div', { class: 'ps-stage-row' }, stagePick,
        el('button', { class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', text: '→', title: 'Move on to the next stage', onclick: next }))),
    el('div', { class: 'ps-group' },
      fact('Assignee', manager),
      fact('Status', status),
      fact('Start date', dateBtn(p.start, 'start', 'Start')),
      fact('Deadline', dateBtn(p.deadline, 'deadline', 'No deadline')),
      fact('Priority', urgency),
      fact('Color', colours)),
    el('div', { class: 'ps-group' },
      fact('Labels', labels),
      el('button', { class: 'sc-button sc-button--ghost sc-button--sm ps-add-field', text: '＋ Add custom field', onclick: () => { void import('./newproject.js').then((m) => m.editFieldsDialog()); } }),
      el('label', { class: 'tp-hard', title: 'When every task of the current stage is done, the project moves to the next stage by itself' },
        el('span', { text: 'Auto-advance stages' }), auto, el('span', { class: 'tp-switch' }))),
    el('div', { class: 'ps-group ps-links' },
      el('button', { class: 'sc-button sc-button--sm', text: 'Open the Gantt', onclick: () => { close(null); set({ view: 'gantt' }); } }),
      el('button', { class: 'sc-button sc-button--sm', text: 'Open the Kanban', onclick: () => { close(null); set({ view: 'kanban' }); } })));
}

// ---------------------------------------------------------------- create a stage

/**
 * Create new stage: a name, where it goes, how long it runs — and what that
 * does to the project's deadline, said before it is done.
 */
export async function createStageDialog(afterId = undefined) {
  const p = store.project;
  const list = phases(p);
  const initialAfter = afterId === undefined ? (list.at(-1)?.id || '') : (afterId || '');
  const answer = await open('Create new stage', (close) => {
    const name = el('input', { class: 'sc-input', type: 'text', value: `Stage ${list.length + 1}`, 'data-autofocus': '' });
    const where = el('select', { class: 'sc-select' }, el('option', { value: '', text: 'At the start' }),
      ...list.map((ph) => el('option', { value: ph.id, text: `After ${ph.name}`, selected: ph.id === initialAfter })));
    const count = el('input', { class: 'sc-input cs-count', type: 'number', min: 1, value: 7 });
    const unit = el('select', { class: 'sc-select' }, el('option', { value: '1', text: 'days' }), el('option', { value: '7', text: 'weeks' }));
    const effect = el('p', { class: 'sc-faint small' });
    const days = () => Math.max(1, Math.round(+count.value || 1)) * +unit.value;
    const explain = () => {
      const n = days();
      effect.textContent = p.deadline
        ? `This will move the project deadline by ${n} day${n === 1 ? '' : 's'}, from ${formatDate(p.deadline, 'long')} to ${formatDate(fromDay(toDay(p.deadline) + n), 'long')}. Stages after it move by the same.`
        : `Stages after it move ${n} day${n === 1 ? '' : 's'} later, so each keeps its length.`;
    };
    for (const n of [count, unit, where]) n.addEventListener('input', explain);
    unit.addEventListener('change', explain);
    explain();
    const save = () => close({ name: name.value, afterId: where.value || null, days: days() });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    close.onSave = save;
    return [
      el('div', { class: 'cs' },
        el('label', { class: 'sc-field' }, el('span', { class: 'sc-label', text: 'Name' }), name),
        el('label', { class: 'sc-field' }, el('span', { class: 'sc-label', text: 'Stage location' }), where),
        el('div', { class: 'sc-field' }, el('span', { class: 'sc-label', text: 'Expected duration' }), el('div', { class: 'cs-dur' }, count, unit)),
        effect),
      foot(el('span', { class: 'sc-spacer' }), button('Cancel', () => close(null)), button('Create new stage', save, 'sc-button--primary')),
    ];
  });
  if (!answer || !answer.name.trim()) return;
  act.createStage({ name: answer.name.trim(), afterId: answer.afterId, days: answer.days });
}

// ---------------------------------------------------------------- right

/** The stage menu: how a missed stage can be put right, then what can be done to any stage. */
function stageMenu(stageId, x, y) {
  const p = store.project;
  const ph = getPhase(p, stageId);
  if (!ph) return;
  const { all } = currentLayout();
  const todayDay = toDay(today());
  const h = stageHealth(p, store.schedule, stageId, { byTask: all.byTask || new Map(), today: todayDay });
  const list = phases(p);
  const i = list.indexOf(ph);
  const status = stageStatus(ph);
  showPanel(x, y, (shut) => {
    const node = el('div', { class: 'sm' });
    if (h.missed && ph.deadline) {
      const days = todayDay - toDay(ph.deadline);
      const projected = h.finish && h.finish > ph.deadline ? h.finish : fromDay(Math.max(todayDay, toDay(ph.deadline)));
      const cal = makeCalendar(p.calendar);
      const options = [
        { label: formatDate(projected, 'day'), sub: 'Projected date', note: 'Recommended', iso: projected },
        { label: formatDate(fromDay(toDay(projected) + 7), 'day'), sub: '1 week after', iso: fromDay(cal.next(toDay(projected) + 7)) },
        { label: formatDate(fromDay(toDay(projected) + 28), 'day'), sub: '1 month after', iso: fromDay(cal.next(toDay(projected) + 28)) },
      ];
      let chosen = options[0].iso;
      const choices = el('div', { class: 'sm-choices' });
      const drawChoices = () => choices.replaceChildren(...options.map((o) => el('button', {
        class: `sm-choice${o.iso === chosen ? ' is-on' : ''}`, onclick: () => { chosen = o.iso; drawChoices(); },
      }, el('strong', { text: o.label }), el('span', { text: o.sub }), o.note ? el('em', { text: o.note }) : null)));
      drawChoices();
      node.append(
        el('div', { class: 'sm-warn' },
          el('div', {}, el('span', { class: 'ps-chip', style: { '--st': stageColour(p, ph) }, text: ph.name }), ' stage missed deadline'),
          el('div', { class: 'small', text: `Due ${formatDate(ph.deadline, 'long')}${days > 0 ? ` (${days} day${days === 1 ? '' : 's'} ago)` : ''}` })),
        el('div', { class: 'sm-row' }, el('span', { text: `Extend ${ph.name} deadline` }),
          el('button', { class: 'sc-button sc-button--sm', text: 'Choose date', onclick: (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            showPanel(r.left, r.bottom + 4, (s2) => datePanel({ value: chosen, title: 'Stage deadline', clearable: false, quick: quickDates(p, []), onPick: (v) => { s2(); act.extendStageTo(stageId, v); } }));
          } })),
        choices,
        el('div', { class: 'sm-row sm-actions' },
          el('span', { class: 'sc-faint small', text: 'Later stages move by the same working days.' }),
          el('button', { class: 'sc-button sc-button--sm sc-button--primary', text: 'Extend deadline', onclick: () => { shut(); act.extendStageTo(stageId, chosen); } })));
      if (h.late.length) {
        node.append(el('div', { class: 'sm-row' }, el('strong', { text: `Fix tasks scheduled past deadline · ${h.late.length}` }),
          el('button', { class: 'sc-button sc-button--sm', text: 'Fix all', title: 'Give each the stage’s deadline, hard, at high priority', onclick: () => { shut(); act.fixStageTasks(stageId, h.late.map((l) => l.taskId)); } })));
        for (const l of h.late.slice(0, 8)) {
          node.append(el('div', { class: 'sm-task' },
            el('span', { class: 'sm-ring' }),
            el('span', { class: 'sm-task-name' }, l.name, el('span', { class: 'sc-faint small', text: ` · ${l.daysLate} day${l.daysLate === 1 ? '' : 's'} after stage deadline` })),
            el('button', { class: 'sc-button sc-button--ghost sc-button--sm', text: 'Fix', onclick: () => { shut(); act.fixStageTasks(stageId, [l.taskId]); } })));
        }
      }
      node.append(el('div', { class: 'sm-sep' }));
    }
    const item = (icon, label, run, danger = false) => el('button', { class: `sm-item${danger ? ' is-danger' : ''}`, onclick: () => { shut(); run(); } }, el('span', { class: 'sm-icon', text: icon }), label);
    node.append(...[
      status === 'open' ? item('✓', 'Complete stage', () => act.completeStageNow(stageId)) : item('↺', 'Reopen stage', () => act.reopenStageNow(stageId)),
      status === 'open' ? item('⊘', 'Cancel stage', () => act.cancelStageNow(stageId)) : null,
      p.currentPhaseId !== stageId ? item('➜', 'Make this the current stage', () => act.goToStage(stageId)) : null,
      item('📅', 'Change deadline…', () => {
        const r = { left: x, bottom: y };
        showPanel(r.left, r.bottom, (s2) => datePanel({ value: ph.deadline, title: 'Stage deadline', quick: quickDates(p, [{ label: 'Project start', day: toDay(p.start) }]), onPick: (v) => { s2(); act.setPhaseDeadline(stageId, v); } }));
      }),
      item('✎', 'Rename…', async () => { const n = await promptText('Rename the stage', '', ph.name); if (n?.trim()) act.editPhase(stageId, n); }),
      i > 0 ? item('↑', 'Move up', () => act.movePhaseBy(stageId, -1)) : null,
      i < list.length - 1 ? item('↓', 'Move down', () => act.movePhaseBy(stageId, 1)) : null,
      item('＋', 'Add a stage after this…', () => { void createStageDialog(stageId); }),
      item('🗑', 'Delete stage', async () => {
        if (await confirmDialog(`Delete “${ph.name}”?`, 'Its tasks stay in the project, in no stage.')) act.deletePhase(stageId);
      }, true)].filter(Boolean));
    return node;
  });
}

function taskRow(t) {
  const p = store.project;
  const info = store.schedule.tasks[t.id];
  const done = (info?.percent ?? 0) === 100;
  const late = t.deadline && !done && toDay(t.deadline) < toDay(today());
  const minutes = Math.round(expectedHours(p, info, t) * 60);
  const who = t.assignments.map((a) => p.resources.find((r) => r.id === a.resourceId)).filter(Boolean)[0];
  return el('div', { class: `ps-task${done ? ' is-done' : ''}${t.archived ? ' is-archived' : ''}`, title: stageOf(p, t).name },
    el('input', { type: 'checkbox', class: 'ps-ring', checked: done, title: done ? 'Completed — click to reopen' : 'Mark complete', onclick: (e) => e.stopPropagation(), onchange: (e) => act.setPercent(t.id, e.target.checked ? 100 : 0) }),
    el('button', { class: 'ps-task-name', text: t.name, onclick: () => { void taskSheet({ taskId: t.id }); } }),
    late ? el('span', { class: 'ps-late', title: `Past its deadline, ${formatDate(t.deadline, 'long')}`, text: '!' }) : null,
    el('span', { class: 'ps-task-dur', text: minutes ? minText(minutes) : '' }),
    el('span', { class: `ps-task-due${late ? ' is-late' : ''}`, text: t.deadline ? shortDay(t.deadline) : '' }),
    agendaOf(p, t).show && !done ? el('span', { class: 'ps-auto', title: 'Auto-scheduled', text: '✦' }) : el('span', { class: 'ps-auto is-off', title: 'Not auto-scheduled', text: '' }),
    who ? el('span', { class: 'ps-who', title: who.name, style: { background: personColour(who.name).line }, text: (who.initials || who.name[0] || '?').slice(0, 1) }) : el('span', { class: 'ps-who is-none' }));
}

function rightColumn(ui, draw) {
  const p = store.project;
  const list = phases(p);
  const todayDay = toDay(today());
  const { all } = currentLayout();
  const byTask = all.byTask || new Map();

  // The strip: each stage a dot on a line of dates, done ticked, cancelled
  // crossed, the current one ringed.
  const dated = list.filter((ph) => ph.deadline);
  let strip = null;
  if (dated.length) {
    const from = toDay(p.start);
    const to = Math.max(...dated.map((ph) => toDay(ph.deadline)), from + 1);
    const pos = (d) => `${Math.max(0, Math.min(100, ((d - from) / (to - from)) * 100))}%`;
    strip = el('div', { class: 'ps-strip' },
      el('div', { class: 'ps-strip-line' }),
      todayDay >= from && todayDay <= to ? el('div', { class: 'ps-strip-today', style: { left: pos(todayDay) }, title: 'Today' }) : null,
      ...dated.map((ph) => {
        const st = stageStatus(ph);
        return el('button', {
          class: `ps-strip-dot${ph.id === p.currentPhaseId ? ' is-current' : ''} is-${st}`, style: { left: pos(toDay(ph.deadline)), '--st': stageColour(p, ph) },
          title: `${ph.name} · due ${formatDate(ph.deadline, 'long')}`, text: st === 'done' ? '✓' : st === 'cancelled' ? '×' : '→',
          onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); stageMenu(ph.id, r.left - 120, r.bottom + 6); },
        });
      }),
      el('div', { class: 'ps-strip-dates' }, ...dated.map((ph) => el('span', { style: { left: pos(toDay(ph.deadline)) }, text: mdY(ph.deadline) }))));
  }

  const addTaskRow = (stageId) => {
    if (ui.adding !== (stageId ?? '')) {
      return el('button', { class: 'ps-add', text: '＋ Add task', onclick: () => { ui.adding = stageId ?? ''; draw(); setTimeout(() => document.querySelector('.ps-add-input')?.focus(), 0); } });
    }
    const input = el('input', { class: 'sc-input ps-add-input', type: 'text', placeholder: 'Task name — ↵ to add, Esc to stop' });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { ui.adding = null; draw(); }
      if (e.key === 'Enter' && input.value.trim()) { act.quickTaskInStage(stageId, input.value.trim()); setTimeout(() => document.querySelector('.ps-add-input')?.focus(), 0); }
    });
    return input;
  };

  const groups = el('div', { class: 'ps-groups' });
  const loose = p.tasks.filter((t, i) => !isSummary(p, i) && !t.archived && !phaseOf(p, t.id));
  if (loose.length || !list.length) {
    groups.append(el('div', { class: 'ps-stage' },
      el('div', { class: 'ps-stage-head' }, el('span', { class: 'ps-chip is-none', text: 'No Stage' })),
      ...loose.map(taskRow), addTaskRow(null)));
  }
  for (const ph of list) {
    const st = stageStatus(ph);
    const h = stageHealth(p, store.schedule, ph.id, { byTask, today: todayDay });
    const range = stageRange(p, ph.id);
    const tasks = stageTasks(p, ph.id, { archived: st === 'cancelled' });
    const collapsed = ui.collapsed.has(ph.id) || (st !== 'open' && !ui.collapsed.has(`open:${ph.id}`));
    groups.append(el('div', { class: `ps-stage is-${st}${ph.id === p.currentPhaseId ? ' is-current' : ''}` },
      el('div', { class: 'ps-stage-head' },
        el('span', { class: `ps-stage-dot is-${st}`, style: { '--st': stageColour(p, ph) }, text: st === 'done' ? '✓' : st === 'cancelled' ? '×' : '' }),
        el('button', { class: 'ps-chip ps-stage-name', style: { '--st': stageColour(p, ph) }, text: ph.name, title: 'Stage menu',
          onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); stageMenu(ph.id, r.left, r.bottom + 4); } }),
        h.missed ? el('span', { class: 'ps-late', title: h.late.length ? `${h.late.length} task(s) laid past the deadline` : 'Past its deadline', text: '!' }) : null,
        el('span', { class: 'sc-spacer' }),
        st === 'cancelled' ? el('em', { class: 'sc-faint small', text: 'Canceled' })
          : el('button', { class: 'ps-range', title: 'Change the stage deadline', text: `${shortDay(range.start)} – ${shortDay(range.end)}`, onclick: (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            showPanel(r.left - 200, r.bottom + 4, (shut) => datePanel({ value: ph.deadline, title: 'Stage deadline', quick: quickDates(p, [{ label: 'Project start', day: toDay(p.start) }, ...(p.deadline ? [{ label: 'Project deadline', day: toDay(p.deadline) }] : [])]),
              onPick: (v) => { shut(); act.setPhaseDeadline(ph.id, v); } }));
          } }),
        el('button', { class: 'side-twist', text: collapsed ? '▸' : '▾', title: collapsed ? 'Show its tasks' : 'Hide its tasks', onclick: () => {
          if (collapsed) { ui.collapsed.delete(ph.id); ui.collapsed.add(`open:${ph.id}`); } else { ui.collapsed.add(ph.id); ui.collapsed.delete(`open:${ph.id}`); }
          draw();
        } })),
      ...(collapsed ? [el('div', { class: 'sc-faint small ps-stage-sum', text: `${tasks.length} task${tasks.length === 1 ? '' : 's'}${h.done ? ` · ${h.done} done` : ''}` })] : [...tasks.map(taskRow), st === 'open' ? addTaskRow(ph.id) : null])));
  }
  groups.append(el('button', { class: 'ps-add ps-add-stage', text: '＋ Add stage', onclick: () => { void createStageDialog(); } }));

  return el('div', { class: 'ps-col ps-right' },
    el('div', { class: 'ps-tasks-head' },
      el('strong', { text: 'Tasks' }),
      el('button', { class: 'side-icon', text: '↗', title: 'Open the task list', onclick: () => set({ view: 'alltasks' }) }),
      el('span', { class: 'sc-spacer' }),
      el('button', { class: 'side-icon', text: '＋', title: 'Add a task to the current stage', onclick: () => { ui.adding = p.currentPhaseId ?? ''; draw(); setTimeout(() => document.querySelector('.ps-add-input')?.focus(), 0); } })),
    strip, groups);
}
