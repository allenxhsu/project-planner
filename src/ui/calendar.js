// The Calendar view: a week, with each task's blocks laid on the hours.
//
// A task appears here only when it asks to (Show in calendar, on the task's
// details), because a plan holds plenty of work nobody schedules hour by hour.
// The blocks themselves are computed, never stored — see model/agenda.js — so
// logging four hours or moving a task re-lays the week by itself.

import { el, clear } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { planBlocksAcross, agendaOf, formatClock, parseTime, personKeyOf, DEFAULT_AGENDA } from '../model/agenda.js';
import { planRecords, isCurrentWork } from '../state/sync.js';
import { parse } from '../io/json.js';
import { computeSchedule } from '../model/schedule.js';
import { weekStart, monthStart, addMonths, weekday, toDay, fromDay, today, formatDate, WEEKDAY_NAMES, MONTH_NAMES, makeCalendar } from '../model/calendar.js';
import { isSummary, phases, getPhase, getTask, getResource, URGENCIES, urgencyOf } from '../model/model.js';
import { showMenu, showText } from './dialog.js';

/**
 * How much of the calendar is on screen.
 *
 * A day for the hour-by-hour of it, the working week for the ordinary answer,
 * the whole week when the weekend is being worked, and a month to see the
 * shape of it. The first three are the same hour grid over a different set of
 * columns; a month is a different drawing, because thirty days of hours is
 * not something anyone reads.
 */
export const RANGES = {
  day: { label: 'Day', step: 1, unit: 'day' },
  three: { label: '3 days', step: 3, unit: 'day' },
  work: { label: 'Work week', step: 7, unit: 'week' },
  week: { label: 'Week', step: 7, unit: 'week' },
  month: { label: 'Month', step: 1, unit: 'month' },
};
export const rangeOf = () => (RANGES[store.ui.calendarRange] ? store.ui.calendarRange : 'work');

/** Which day is on screen, or a day inside the week or month that is. */
let anchor = null;
export function goToWeek(day) { anchor = day; set({}); }
export const showThisWeek = () => goToWeek(toDay(today()));
/** Move by whatever the current range is: a day, a week, or a month. */
export const shiftWeek = (steps) => {
  const at = anchor ?? toDay(today());
  const range = RANGES[rangeOf()];
  goToWeek(range.unit === 'month' ? addMonths(at, steps) : at + steps * range.step);
};
/** The days on screen, and where they start, for the range in force. */
export function daysOnScreen(project) {
  const at = anchor ?? toDay(today());
  const range = rangeOf();
  if (range === 'day') return { days: [at], start: at };
  // Three days runs from the day on screen, not from a Monday: "today and the
  // next two" is what anyone means by it.
  if (range === 'three') return { days: [at, at + 1, at + 2], start: at };
  if (range === 'month') {
    const first = monthStart(at);
    const gridStart = weekStart(first);
    const days = [];
    // Six rows always, so the grid does not change height from month to month.
    for (let d = gridStart; d < gridStart + 42; d++) days.push(d);
    return { days, start: first, gridStart };
  }
  const start = weekStart(at);
  const days = [];
  for (let d = start; d < start + 7; d++) days.push(d);
  if (range === 'week') return { days, start };
  // The working week is the plan's own idea of one, not Monday to Friday by decree.
  const cal = makeCalendar(project.calendar);
  const working = days.filter((d) => cal.isWorking(d));
  return { days: working.length ? working : days, start };
}

const HOUR_H = 46;

/**
 * Every plan on the shelf, parsed and scheduled, so one calendar can cover
 * them all. Kept until a plan's record changes; the plan that is *open* is
 * never taken from here, because the live one is newer than its record.
 */
const planCache = new Map();
let others = [];
let loadedPlans = false;

export async function reloadCalendarPlans() {
  try {
    const records = await planRecords();
    const out = [];
    for (const r of records) {
      if (r.id === store.project.id) continue;
      const hit = planCache.get(r.id);
      if (hit && hit.updatedAt === r.updatedAt) { out.push(hit.entry); continue; }
      try {
        const project = parse(r.body).project;
        // A template's tasks are a pattern to copy and an archived plan's are
        // history. Neither is hours anyone is spending this week.
        if (!isCurrentWork(project)) continue;
        const entry = { project, schedule: computeSchedule(project) };
        planCache.set(r.id, { updatedAt: r.updatedAt, entry });
        out.push(entry);
      } catch { /* a plan that cannot be read simply is not on the calendar */ }
    }
    others = out;
  } catch {
    others = [];
  }
  loadedPlans = true;
  set({});
}

/**
 * What the colour on a block means.
 *
 * Colour by person answers "who is in three places at once", which is the
 * question when several people share a calendar. Colour by project answers
 * "what am I spending the week on", which is the question when the calendar is
 * one person's and the projects are many — and one person's calendar coloured
 * by person is one colour, which says nothing. `auto` picks whichever of those
 * the week actually is.
 */
export const COLOUR_BY = { auto: 'Automatic', person: 'Person', plan: 'Project' };
export const colourModeFor = (blocks) => {
  const mode = COLOUR_BY[store.ui.calendarColour] ? store.ui.calendarColour : 'auto';
  if (mode !== 'auto') return mode;
  const people = new Set(blocks.flatMap((b) => b.people || []));
  return people.size > 1 ? 'person' : 'plan';
};

/** The shades a hue is drawn in: the edge, the body, and a heavier wash. */
export const hueColour = (h) => ({ hue: h, line: `hsl(${h} 72% 62%)`, fill: `hsl(${h} 58% 34% / 0.62)`, wash: `hsl(${h} 58% 34% / 0.8)` });

/** A stable colour per person, so a week of several people reads at a glance. */
export function personColour(name) {
  const key = String(name || '');
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return hueColour(h);
}

/**
 * A colour per project, far enough from its neighbours to tell apart.
 *
 * Hashing a name is stable but lands two projects on nearly the same hue as
 * often as not. Walking the hue circle by the golden angle instead puts every
 * project a long way from the ones before it, and because the step depends
 * only on a plan's position in a fixed order, adding a project does not
 * recolour the others. A plan that names its own colour keeps it.
 */
const GOLDEN_ANGLE = 137.508;
export function planPalette(entries) {
  const order = [...entries].sort((a, b) => String(a.project.id).localeCompare(String(b.project.id)));
  const out = new Map();
  order.forEach(({ project }, i) => {
    const stated = project.colour !== null && project.colour !== undefined && Number.isFinite(+project.colour);
    const own = stated ? ((Math.round(+project.colour) % 360) + 360) % 360 : null;
    out.set(project.id, hueColour(own ?? Math.round((i * GOLDEN_ANGLE) % 360)));
  });
  return out;
}

/** Who is on a block, as names and initials. */
function whoOf(entries, block) {
  const entry = entries.find((e) => e.project.id === block.planId);
  if (!entry) return { names: [], initials: '' };
  const names = [], inits = [];
  for (const id of block.lanes || []) {
    const r = getResource(entry.project, id);
    if (!r) continue;
    names.push(r.name);
    inits.push(r.initials || r.name.split(/\s+/).map((w) => w[0] || '').join('').toUpperCase().slice(0, 3));
  }
  return { names, initials: inits.join(' ') };
}

/**
 * Give every block a column within its day, so blocks that share an hour sit
 * beside each other. Blocks that overlap at all form one cluster and share the
 * width; a block alone in its hour keeps the whole column.
 */
function sideBySide(dayBlocks) {
  const sorted = [...dayBlocks].sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    if (!cluster.length) return;
    const ends = [];               // when each column is free again
    const placed = cluster.map((b) => {
      let slot = ends.findIndex((e) => e <= b.start);
      if (slot < 0) { slot = ends.length; ends.push(0); }
      ends[slot] = b.end;
      return { block: b, lane: slot };
    });
    const lanes = ends.length;
    for (const p of placed) out.push({ ...p, lanes });
    cluster = [];
    clusterEnd = -1;
  };
  for (const b of sorted) {
    if (cluster.length && b.start >= clusterEnd) flush();
    cluster.push(b);
    clusterEnd = Math.max(clusterEnd, b.end);
  }
  flush();
  return out;
}

/** A block from another plan: open that plan, and land on the task. */
async function openOther(planId, taskId) {
  const { openPlan } = await import('../state/sync.js');
  if (!(await openPlan(planId))) return;
  if (!taskId) return;
  act.revealTask(taskId);
  act.selectTask(taskId);
  set({ rightOpen: true, rightTab: 'task' });
}

export function renderCalendar(root) {
  const { project, schedule, ui } = store;
  clear(root);
  const pane = el('div', { class: 'cal-pane' });
  root.append(pane);

  if (!loadedPlans) void reloadCalendarPlans();
  // The open plan comes from the store, the rest from the shelf: one calendar
  // over everything, because the hours of a week are shared by all of it.
  // The open plan comes from the store and must not also arrive from the shelf.
  // The shelf list is filtered when it is read, but opening a different plan
  // does not re-read it, so the newly opened plan would still be in there —
  // and every one of its tasks would be booked twice, which looks like a task
  // taking twice the time it asked for.
  const entries = [{ project, schedule }, ...(ui.calendarScope === 'plan' ? [] : others.filter((e) => e.project.id !== project.id))];
  const all = planBlocksAcross(entries);
  // Whose week this is, by name — the same person is a different id in each plan.
  const everyone = [...new Map(entries.flatMap((e) => e.project.resources.map((r) => [personKeyOf(r), r.name]))).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const who = ui.calendarWho && everyone.some(([k]) => k === ui.calendarWho) ? ui.calendarWho : '';
  const blocks = who ? all.blocks.filter((b) => (b.people || []).includes(who)) : all.blocks;
  const meetings = who ? (all.meetings || []).filter((m) => m.lane === who) : all.meetings;
  const overflow = all.overflow;
  const colourMode = colourModeFor(blocks);
  const palette = planPalette(entries);
  const phaseList = phases(project);
  const current = project.currentPhaseId ? getPhase(project, project.currentPhaseId) : null;
  const planCount = entries.length;
  const bar = el('div', { class: 'cal-phase' },
    el('span', { class: 'sc-label', text: 'Calendar for' }),
    el('select', { class: 'sc-select', onchange: (e) => set({ calendarWho: e.target.value }) },
      el('option', { value: '', text: 'Everyone', selected: !who }),
      ...everyone.map(([key, name]) => el('option', { value: key, text: name, selected: key === who }))),
    el('select', { class: 'sc-select', onchange: (e) => set({ calendarScope: e.target.value }) },
      el('option', { value: 'all', text: `All projects (${others.length + 1})`, selected: ui.calendarScope !== 'plan' }),
      el('option', { value: 'plan', text: 'This project only', selected: ui.calendarScope === 'plan' })),
    el('span', { class: 'sc-label', text: 'Colour by' }),
    el('select', { class: 'sc-select', onchange: (e) => set({ calendarColour: e.target.value }) },
      ...Object.entries(COLOUR_BY).map(([id, label]) => el('option', {
        value: id, selected: (store.ui.calendarColour || 'auto') === id,
        text: id === 'auto' ? `Automatic — ${COLOUR_BY[colourMode].toLowerCase()}` : label,
      }))),
    el('span', { class: 'sc-faint small', text: who
      ? `One person’s week, across ${planCount === 1 ? 'this project' : `${planCount} projects`}. Colour is the ${colourMode === 'plan' ? 'project' : 'person'}.`
      : `Everyone’s hours, across ${planCount === 1 ? 'this project' : `${planCount} projects`}. Colour is the ${colourMode === 'plan' ? 'project' : 'person'}.` }));
  pane.append(bar);

  // What the colours stand for. Without this a colour is decoration; with it,
  // a glance at the week says which project is eating it.
  if (colourMode === 'plan' && planCount > 1) {
    const used = new Set(blocks.map((b) => b.planId));
    const legend = el('div', { class: 'cal-legend' });
    for (const e of entries) {
      if (!used.has(e.project.id)) continue;
      const colour = palette.get(e.project.id);
      legend.append(el('span', { class: 'cal-legend-item', title: e.project.id === project.id ? 'The open project' : 'Click to open this project' ,
        onclick: () => { if (e.project.id !== project.id) void openOther(e.project.id, null); } },
        el('span', { class: 'cal-legend-dot', style: { background: colour.fill, borderColor: colour.line } }),
        el('span', { text: e.project.name })));
    }
    if (legend.children.length) pane.append(legend);
  }

  if (phaseList.length) {
    pane.append(el('div', { class: 'cal-phase' },
      el('span', { class: 'sc-label', text: 'Releasing' }),
      el('select', { class: 'sc-select', onchange: (e) => act.setCurrentPhase(e.target.value) },
        el('option', { value: '', text: 'Every phase', selected: !current }),
        ...phaseList.map((ph) => el('option', { value: ph.id, text: ph.name, selected: ph.id === project.currentPhaseId }))),
      el('span', { class: 'sc-faint small', text: current ? `Only ${current.name} tasks reach the calendar.` : 'Every phase’s tasks reach the calendar.' })));
  }
  const shown = entries.flatMap((e) => e.project.tasks.filter((t, i) => !isSummary(e.project, i) && agendaOf(e.project, t).show));
  if (!shown.length) {
    pane.append(el('div', { class: 'empty-note sc-muted' },
      el('p', { text: 'Nothing is on the calendar yet.' }),
      el('p', { text: 'Open a task’s details and switch on “Show in calendar”. It will be cut into blocks of the size you choose — half an hour, one, one and a half, two or four — and laid inside the hours you say you work.' }),
      el('button', { class: 'sc-button sc-button--sm', text: 'Put every unfinished task on the calendar', onclick: () => act.showAllInCalendar() })));
    return;
  }

  const range = rangeOf();
  const screen = daysOnScreen(project);
  if (range === 'month') { renderMonth(pane, { entries, blocks, meetings, screen, project, who, planCount, colourMode, palette }); return; }
  const columns = screen.days;

  // The hours to draw: every task's window, and every block, has to fit.
  const base = { ...DEFAULT_AGENDA, ...(project.agenda || {}) };
  let from = parseTime(base.from) ?? 540, to = parseTime(base.to) ?? 1020;
  for (const e of entries) for (const t of e.project.tasks) { if (!agendaOf(e.project, t).show) continue; const a = agendaOf(e.project, t); from = Math.min(from, a.from); to = Math.max(to, a.to); }
  for (const b of blocks) if (columns.includes(b.day)) { from = Math.min(from, b.start); to = Math.max(to, b.end); }
  for (const m of (meetings || [])) if (columns.includes(m.day) && !m.allDay) { from = Math.min(from, m.start); to = Math.max(to, m.end); }
  const hourFrom = Math.floor(from / 60), hourTo = Math.ceil(to / 60);
  const y = (min) => ((min - hourFrom * 60) / 60) * HOUR_H;

  const todayDay = toDay(today());
  const head = el('div', { class: 'cal-head' }, el('div', { class: 'cal-gutter sc-mono', text: '' }));
  for (const d of columns) {
    head.append(el('div', { class: `cal-col-head${d === todayDay ? ' is-today' : ''}` },
      el('span', { class: 'sc-label', text: WEEKDAY_NAMES[((d + 4) % 7 + 7) % 7].slice(0, 3) }),
      el('span', { class: 'cal-date', text: formatDate(fromDay(d), 'day') })));
  }
  pane.append(head);

  const body = el('div', { class: 'cal-body' });
  const gutter = el('div', { class: 'cal-gutter' });
  for (let h = hourFrom; h < hourTo; h++) {
    gutter.append(el('div', { class: 'cal-hour sc-mono', style: { height: `${HOUR_H}px` }, text: formatClock(h * 60) }));
  }
  body.append(gutter);

  for (const d of columns) {
    const col = el('div', { class: `cal-col${d === todayDay ? ' is-today' : ''}`, style: { height: `${(hourTo - hourFrom) * HOUR_H}px` } });
    for (let h = hourFrom; h < hourTo; h++) col.append(el('div', { class: 'cal-line', style: { top: `${(h - hourFrom) * HOUR_H}px` } }));
    // Meetings from a connected calendar sit behind the work, because that is
    // what they are: hours already spoken for.
    for (const m of (meetings || []).filter((x) => x.day === d)) {
      col.append(el('div', {
        class: `cal-meeting${m.allDay ? ' is-allday' : ''}`,
        style: { top: `${y(m.start)}px`, height: `${Math.max(14, y(m.end) - y(m.start) - 1)}px` },
        title: `${m.title}\n${m.allDay ? 'All day' : `${formatClock(m.start)} – ${formatClock(m.end)}`}`,
      }, el('div', { class: 'cal-meeting-name', text: m.title })));
    }
    for (const { block: b, lane: slot, lanes } of sideBySide(blocks.filter((x) => x.day === d))) {
      const entry = entries.find((e) => e.project.id === b.planId) || entries[0];
      const t = entry.project.tasks.find((x) => x.id === b.taskId);
      const info = entry.schedule.tasks[b.taskId];
      if (!t || !info) continue;
      const person = whoOf(entries, b);
      const colour = colourMode === 'plan'
        ? (palette.get(b.planId) || personColour(b.planName))
        : personColour(person.names[0] || 'unassigned');
      const foreign = b.planId !== project.id;
      const height = Math.max(16, y(b.end) - y(b.start) - 2);
      // Half an hour is about twenty pixels: too short to stack a time, a name
      // and a project, so those go on one line and the block still says what
      // it is rather than only when it is.
      const tight = height < 34;
      // Two people can work the same hour, so their blocks sit side by side
      // rather than one hiding the other.
      const width = 100 / lanes;
      // A day has one column and room to spare, so the block reads as a line:
      // time, who, task, project, how long, how far along. A half-hour block in
      // a week is too short to stack that, which is why the week keeps to the
      // task's name and the day says the rest.
      const oneDay = range === 'day';
      col.append(el('div', {
        class: `cal-block${oneDay ? ' is-day' : ''}${tight && !oneDay ? ' is-tight' : ''}${b.overdue ? ' is-overdue' : ''}${b.critical ? ' is-critical' : ''}${ui.selection.includes(t.id) && !foreign ? ' is-sel' : ''}${foreign ? ' is-other-plan' : ''}`,
        style: {
          top: `${y(b.start)}px`, height: `${height}px`, left: `calc(${slot * width}% + 3px)`, width: `calc(${width}% - 6px)`, right: 'auto',
          '--who': colour.line, background: colour.fill, borderLeftColor: colour.line,
        },
        title: `${t.name}\n${b.planName}${person.names.length ? ` · ${person.names.join(', ')}` : ''}\n${formatClock(b.start)} – ${formatClock(b.end)} · ${b.minutes / 60}h\n${info.percent}% complete${b.overdue ? `\nOverdue: it was due to start ${formatDate(fromDay(info.start), 'long')}` : ''}`,
        onclick: () => { if (foreign) { void openOther(b.planId, t.id); return; } act.selectTask(t.id); },
        ondblclick: () => set({ rightOpen: true, rightTab: 'task', selection: [t.id] }),
        oncontextmenu: (e) => {
          e.preventDefault();
          act.selectTask(t.id);
          showMenu(e.clientX, e.clientY, [
            { label: 'Task information…', run: () => set({ rightOpen: true, rightTab: 'task' }) },
            { label: 'Show on the Gantt chart', run: () => { act.revealTask(t.id); set({ view: 'gantt' }); } },
            '-',
            { label: 'Do it now', run: () => act.editTask(t.id, 'urgency', 'now') },
            { label: 'Urgency: high', run: () => act.editTask(t.id, 'urgency', 'high') },
            { label: 'Urgency: low', run: () => act.editTask(t.id, 'urgency', 'low') },
            '-',
            { label: 'Break into subtasks…', run: () => act.breakUpDialog(t.id) },
            '-',
            { label: 'Take off the calendar', run: () => act.editTask(t.id, 'calendarShow', false) },
          ]);
        },
      },
        el('div', { class: 'cal-block-time sc-mono' },
          oneDay ? `${formatClock(b.start)} – ${formatClock(b.end)}` : formatClock(b.start),
          person.initials ? el('span', { class: 'cal-who', text: person.initials }) : null),
        el('div', { class: 'cal-block-name' }, urgencyOf(t) !== 'normal' ? el('span', { class: `urg-dot urg-${urgencyOf(t)}`, title: URGENCIES[urgencyOf(t)].label }) : null, t.name),
        (planCount > 1 && !who) || foreign || tight ? el('div', { class: 'cal-block-plan', text: b.planName }) : null,
        oneDay ? el('div', { class: 'cal-block-facts sc-mono sc-faint' },
          `${b.minutes % 60 ? `${b.minutes}m` : `${b.minutes / 60}h`}`,
          person.names.length ? el('span', { text: person.names.join(', ') }) : null,
          urgencyOf(t) !== 'normal' ? el('span', { class: `sc-pill urg-${urgencyOf(t)}`, text: URGENCIES[urgencyOf(t)].label }) : null,
          info.percent ? el('span', { text: `${info.percent}%` }) : null,
          info.critical ? el('span', { class: 'sc-pill', style: { '--tint': 'var(--sc-danger)' }, text: 'Critical' }) : null,
          t.deadline ? el('span', { text: `deadline ${formatDate(t.deadline, 'day')}` }) : null) : null));
    }
    body.append(col);
  }
  pane.append(body);

  // Why the afternoon is empty. A calendar that only shows what it placed
  // leaves you guessing whether the rest of the day is free, capped, or
  // waiting on something — so it says which.
  const onScreen = new Set(columns);
  const placed = blocks.filter((b) => onScreen.has(b.day));
  const placedHours = Math.round(placed.reduce((n, b) => n + b.minutes, 0) / 6) / 10;
  const later = blocks.filter((b) => !onScreen.has(b.day));
  const laterTasks = new Set(later.map((b) => b.taskId)).size;
  // Which projects are keeping work off the calendar, and how much. "Not all
  // my projects are here" is almost always this: the tasks were never put on
  // it, and the calendar only shows what asks to be shown.
  const held = entries.map((e) => ({
    name: e.project.name,
    tasks: e.project.tasks.filter((t, i) => !isSummary(e.project, i) && !agendaOf(e.project, t).show
      && (e.schedule.tasks[t.id]?.percent ?? 0) < 100 && !e.schedule.tasks[t.id]?.milestone),
  })).filter((h) => h.tasks.length);
  const notReleased = held.reduce((n, h) => n + h.tasks.length, 0);
  const heldBack = held.sort((a, b) => b.tasks.length - a.tasks.length).slice(0, 4).map((h) => `${h.name} ${h.tasks.length}`);
  if (held.length > 4) heldBack.push(`${held.length - 4} more`);
  const heldBackDetail = held.flatMap((h) => [`${h.name} — ${h.tasks.length}`, ...h.tasks.slice(0, 12).map((t) => `   ${t.name}`), h.tasks.length > 12 ? `   … ${h.tasks.length - 12} more` : null, '']).filter((x) => x !== null);
  const capHours = { ...DEFAULT_AGENDA, ...(project.agenda || {}) }.dailyCap;
  const room = Math.max(0, capHours * columns.length - placedHours);
  if (placedHours || laterTasks || notReleased) {
    pane.append(el('p', { class: 'sc-faint small cal-note' },
      `${placedHours}h placed${columns.length > 1 ? ` across ${columns.length} days` : ''}. `,
      room > 0 ? `Room for ${Math.round(room * 10) / 10}h more at ${capHours}h a day. ` : `That is the ${capHours}h a day this plan allows. `,
      laterTasks ? `${laterTasks} ${laterTasks === 1 ? 'task is' : 'tasks are'} on the calendar but not scheduled to start until later. ` : '',
      notReleased ? `${notReleased} unfinished ${notReleased === 1 ? 'task is' : 'tasks are'} not on the calendar yet${heldBack.length ? ` — ${heldBack.join(', ')}` : ''}. ` : '',
      notReleased ? el('button', {
        class: 'sc-button sc-button--ghost sc-button--sm', text: 'Show what is held back',
        title: 'Every unfinished task that is not on the calendar, by project',
        onclick: () => showText('Not on the calendar', heldBackDetail.join('\n')),
      }) : null));
  }

  if (overflow.length) {
    const hours = Math.round(overflow.reduce((s, o) => s + o.minutes, 0) / 6) / 10;
    pane.append(el('div', { class: 'sc-alert sc-alert--warning cal-overflow' },
      el('strong', { text: `${hours}h could not be placed. ` }),
      el('span', { text: overflow.some((o) => o.reason === 'window-too-short')
        ? 'One task asks for blocks longer than the hours it is allowed — widen its window, or use a smaller block.'
        : 'There are more hours of work than there are working hours to put them in.' })));
  }
}


/**
 * A month: one cell a day, each listing what is on it.
 *
 * Thirty days of an hour grid is unreadable and mostly empty, so a month shows
 * what a month is for — which days are heavy, which are free, what is on each
 * one. A cell says the hours it holds, lists its blocks in order, and clicking
 * one goes to that day.
 */
function renderMonth(pane, { entries, blocks, meetings, screen, project, who, planCount, colourMode, palette }) {
  const { ui } = store;
  const todayDay = toDay(today());
  const monthOf = (d) => fromDay(d).slice(0, 7);
  const thisMonth = fromDay(screen.start).slice(0, 7);
  const cal = makeCalendar(project.calendar);

  const byDay = new Map();
  for (const b of blocks) {
    if (!byDay.has(b.day)) byDay.set(b.day, []);
    byDay.get(b.day).push(b);
  }
  const meetingsByDay = new Map();
  for (const m of (meetings || [])) {
    if (!meetingsByDay.has(m.day)) meetingsByDay.set(m.day, []);
    meetingsByDay.get(m.day).push(m);
  }

  const head = el('div', { class: 'cal-month-head' });
  for (let i = 0; i < 7; i++) {
    head.append(el('div', { class: 'cal-col-head' },
      el('span', { class: 'sc-label', text: WEEKDAY_NAMES[(i + 1) % 7].slice(0, 3) })));
  }
  pane.append(el('div', { class: 'cal-month-title sc-display', text: `${MONTH_NAMES[+thisMonth.slice(5, 7) - 1]} ${thisMonth.slice(0, 4)}` }));
  pane.append(head);

  const grid = el('div', { class: 'cal-month' });
  for (const d of screen.days) {
    const mine = (byDay.get(d) || []).sort((a, b) => a.start - b.start);
    const meets = (meetingsByDay.get(d) || []).sort((a, b) => a.start - b.start);
    const hours = mine.reduce((n, b) => n + b.minutes, 0) / 60;
    const outside = monthOf(d) !== thisMonth;
    const cell = el('div', {
      class: `cal-month-cell${d === todayDay ? ' is-today' : ''}${outside ? ' is-outside' : ''}${cal.isWorking(d) ? '' : ' is-off'}`,
      ondblclick: () => { goToWeek(d); set({ calendarRange: 'day' }); },
    },
      el('div', { class: 'cal-month-day' },
        el('span', { class: 'sc-mono', text: String(+fromDay(d).slice(8, 10)) }),
        hours ? el('span', { class: 'sc-faint sc-mono small', text: `${Math.round(hours * 10) / 10}h` }) : null));

    for (const m of meets.slice(0, 2)) {
      cell.append(el('div', { class: 'cal-month-item is-meeting', title: `${m.title}\n${m.allDay ? 'All day' : formatClock(m.start)}`, text: m.allDay ? m.title : `${formatClock(m.start)} ${m.title}` }));
    }
    const room = Math.max(1, 4 - meets.slice(0, 2).length);
    for (const b of mine.slice(0, room)) {
      const entry = entries.find((e) => e.project.id === b.planId) || entries[0];
      const t = entry?.project.tasks.find((x) => x.id === b.taskId);
      if (!t) continue;
      const person = whoOf(entries, b);
      const colour = colourMode === 'plan'
        ? (palette.get(b.planId) || personColour(b.planName))
        : personColour(person.names[0] || 'unassigned');
      const foreign = b.planId !== project.id;
      cell.append(el('div', {
        class: `cal-month-item${b.critical ? ' is-critical' : ''}`,
        style: { background: colour.fill, borderLeftColor: colour.line },
        title: `${t.name}\n${b.planName}${person.names.length ? ` · ${person.names.join(', ')}` : ''}\n${formatClock(b.start)} – ${formatClock(b.end)} · ${b.minutes / 60}h`,
        onclick: (e) => { e.stopPropagation(); if (foreign) { void openOther(b.planId, t.id); return; } act.selectTask(t.id); set({ rightOpen: true, rightTab: 'task' }); },
      },
        el('span', { class: 'cal-month-time sc-mono', text: formatClock(b.start) }),
        el('span', { class: 'cal-month-name', text: t.name }),
        person.initials && !who ? el('span', { class: 'cal-who', text: person.initials }) : null));
    }
    const hidden = mine.length + meets.length - Math.min(mine.length, room) - Math.min(meets.length, 2);
    if (hidden > 0) {
      cell.append(el('button', {
        class: 'cal-month-more sc-button sc-button--ghost sc-button--sm',
        text: `+${hidden} more`,
        onclick: (e) => { e.stopPropagation(); goToWeek(d); set({ calendarRange: 'day' }); },
      }));
    }
    grid.append(cell);
  }
  pane.append(grid);
  void planCount;
}
