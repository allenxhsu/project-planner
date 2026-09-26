// The Calendar view: a week, with each task's blocks laid on the hours.
//
// A task appears here only when it asks to (Show in calendar, on the task's
// details), because a plan holds plenty of work nobody schedules hour by hour.
// The blocks themselves are computed, never stored — see model/agenda.js — so
// logging four hours or moving a task re-lays the week by itself.

import { el, clear } from '../util.js';
import { store, set, revision } from '../state/store.js';
import * as act from '../state/actions.js';
import { planBlocksAcross, agendaOf, formatClock, parseTime, personKeyOf, DEFAULT_AGENDA } from '../model/agenda.js';
import { planRecords, isLiveWork } from '../state/sync.js';
import { parse } from '../io/json.js';
import { computeSchedule } from '../model/schedule.js';
import { weekStart, monthStart, addMonths, weekday, toDay, fromDay, today, formatDate, WEEKDAY_NAMES, MONTH_NAMES, makeCalendar } from '../model/calendar.js';
import { isSummary, phases, getPhase, getTask, getResource, URGENCIES, urgencyOf } from '../model/model.js';
import { showMenu, showText } from './dialog.js';
import { EVENT_COLOURS } from '../model/model.js';
import { blockMenu, blockSheet, meetingSheet, taskSheet, slotMenu, unlockBlock } from './blockmenu.js';
import { icon } from './icons.js';

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
/** Archived and finished plans: their logged time is drawn, nothing of them is planned. */
let historyPlans = [];
let loadedPlans = false;
/** Bumped whenever the shelf's plans are re-read, so a memo knows. */
let othersVersion = 0;

/**
 * The week as the calendar lays it, for anything that needs to know — the
 * checks panel says what will be late, the grid marks it. Memoised on the
 * open plan's revision and the shelf, because the checks re-render on every
 * keystroke and laying every plan's week on each one is waste.
 */
let layoutMemo = { key: '', value: null };
export function currentLayout() {
  const { project, schedule, ui } = store;
  // The quarter hour is in the key: as the day goes on, the hours behind now
  // stop being free, and the layout has to say so.
  const key = `${project.id}|${revision()}|${othersVersion}|${ui.calendarScope}|${Math.floor(Date.now() / 900000)}`;
  if (layoutMemo.key === key && layoutMemo.value) return layoutMemo.value;
  // Live projects are planned; finished and archived ones are history — their
  // logged time is drawn, nothing of them is laid. The open project is
  // whichever it is.
  const open = { project, schedule };
  const openIsLive = !project.template && isLiveWork(project);
  const onlyOpen = ui.calendarScope === 'plan';
  const entries = [...(openIsLive ? [open] : []), ...(onlyOpen ? [] : others.filter((e) => e.project.id !== project.id))];
  const history = [...(openIsLive || project.template ? [] : [open]), ...(onlyOpen ? [] : historyPlans.filter((e) => e.project.id !== project.id))];
  const value = { entries, history, all: planBlocksAcross(entries, { held: heldBlocks(), history }) };
  layoutMemo = { key, value };
  rememberToday(value.all.blocks);
  return value;
}

// A block that has started and is not done stays put until half an hour after
// it was due to end (model/agenda.js). The planner does not remember where it
// put things, so the calendar tells it: today's blocks from the last layout,
// kept for a reload too.
const HELD_KEY = 'project-planner:today-blocks';
const GRACE_MIN = 30;
const nowMinutes = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
function heldBlocks() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(HELD_KEY) || 'null'); } catch { saved = null; }
  if (!saved || saved.day !== toDay(today())) return [];
  const now = nowMinutes();
  return saved.blocks.filter((b) => b.start < now && now < b.end + GRACE_MIN).map((b) => ({ ...b, day: saved.day }));
}
function rememberToday(blocks) {
  const day = toDay(today());
  const mine = blocks.filter((b) => b.day === day && !b.worked && !b.pinned && !b.live)
    .map((b) => ({ planId: b.planId, taskId: b.taskId, start: b.start, end: b.end }));
  try { localStorage.setItem(HELD_KEY, JSON.stringify({ day, blocks: mine })); } catch { /* private mode */ }
}

// The clock moves the calendar on: the now-line every minute, and the layout
// every quarter hour (the key above changes), when a calendar is on screen.
let lastQuarter = Math.floor(Date.now() / 900000);
setInterval(() => {
  const line = document.querySelector('.cal-now');
  if (line) line.style.top = `${line.dataset.from ? ((nowMinutes() - +line.dataset.from) / 60) * HOUR_H : 0}px`;
  const q = Math.floor(Date.now() / 900000);
  if (q !== lastQuarter) { lastQuarter = q; if (['calendar', 'today'].includes(store.ui.view)) set({}); }
}, 60 * 1000);
/** Pick out a task's blocks for a moment, and bring the first into view. */
export function flashTask(taskId) {
  setTimeout(() => {
    const nodes = [...document.querySelectorAll(`.cal-block[data-task="${CSS.escape(taskId)}"]`)];
    nodes[0]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    for (const n of nodes) { n.classList.add('is-flash'); setTimeout(() => n.classList.remove('is-flash'), 2200); }
  }, 60);
}

/** "PDT", "GMT+1": the short name of the zone the hours are drawn in. */
export function timeZoneLabel() {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value || '';
  } catch { return ''; }
}

/** "Sep 2026", or "Sep – Oct 2026" when the days on screen cross a month. */
export function calendarTitle() {
  const screen = daysOnScreen(store.project);
  const range = rangeOf();
  const first = fromDay(range === 'month' ? screen.start : screen.days[0]);
  const last = fromDay(range === 'month' ? screen.start : screen.days[screen.days.length - 1]);
  const mon = (iso) => MONTH_NAMES[+iso.slice(5, 7) - 1].slice(0, 3);
  if (first.slice(0, 7) === last.slice(0, 7)) return { month: mon(first), year: first.slice(0, 4) };
  return { month: `${mon(first)} – ${mon(last)}`, year: last.slice(0, 4) };
}

/** Display options: who and what the calendar shows, and how it is coloured. */
export function displayOptions(close) {
  const { project, ui } = store;
  const { entries } = currentLayout();
  const everyone = [...new Map(entries.flatMap((e) => e.project.resources.map((r) => [personKeyOf(r), r.name]))).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const toggle = (label, key, hint) => el('label', { class: 'dopt-row', title: hint },
    el('span', { text: label }),
    el('input', { type: 'checkbox', class: 'tp-switch-box', checked: ui[key] !== false, onchange: (e) => set({ [key]: e.target.checked }) }),
    el('span', { class: 'tp-switch' }));
  const pick = (label, value, options, onchange) => el('label', { class: 'dopt-row' }, el('span', { text: label }),
    el('select', { class: 'sc-select', onchange: (e) => onchange(e.target.value) },
      ...options.map(([v, t]) => el('option', { value: v, text: t, selected: v === value }))));
  const phaseList = phases(project);
  return el('div', { class: 'dopt' },
    el('div', { class: 'dopt-title', text: 'Calendar' }),
    pick('Calendar for', ui.calendarWho || '', [['', 'Everyone'], ...everyone], (v) => set({ calendarWho: v })),
    pick('Projects', ui.calendarScope === 'plan' ? 'plan' : 'all', [['all', `All projects (${others.length + 1})`], ['plan', 'This project only']], (v) => set({ calendarScope: v })),
    pick('Colour by', ui.calendarColour || 'auto', Object.entries(COLOUR_BY), (v) => set({ calendarColour: v })),
    phaseList.length ? pick('Releasing', project.currentPhaseId || '', [['', 'Every stage'], ...phaseList.map((ph) => [ph.id, ph.name])], (v) => act.setCurrentPhase(v)) : null,
    el('div', { class: 'dopt-sep' }),
    toggle('Show tasks in calendar', 'calShowTasks', 'Work the calendar has placed, and fixed blocks'),
    toggle('Show completed work', 'calShowWorked', 'Time logged by starting and stopping a task, where it was worked'),
    el('div', { class: 'dopt-sep' }),
    el('button', { class: 'dopt-link', text: 'Auto-schedule every unfinished task', onclick: () => { close(); act.showAllInCalendar(); } }),
    el('button', { class: 'dopt-link', text: 'Schedules — the hours work may use ⚙', onclick: () => { close(); set({ view: 'schedules' }); } }),
    el('button', { class: 'dopt-link', text: 'Auto-scheduling settings ⚙', onclick: () => { close(); void import('./inspector.js').then((m) => m.projectSettingsDialog()); } }));
}

let miniMonth = null;
/**
 * The right-hand panel on the calendar, as Motion has it: a month to jump
 * around in, then the calendars — the connected ones with their colours, the
 * people whose week this can be, and the projects with the colour each is
 * drawn in.
 */
export function renderCalendarSide(root) {
  clear(root);
  const { project, ui } = store;
  const { entries, all } = currentLayout();
  const todayDay = toDay(today());
  const screen = daysOnScreen(project);
  const onScreen = new Set(rangeOf() === 'month' ? [] : screen.days);
  const month = miniMonth ?? monthStart(anchor ?? todayDay);
  const iso = fromDay(month);
  const grid = el('div', { class: 'mini-grid' }, ...['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => el('span', { class: 'mini-dow', text: d })));
  const startGrid = month - weekday(month);
  for (let d = startGrid; d < startGrid + 42; d++) {
    const inMonth = fromDay(d).slice(0, 7) === iso.slice(0, 7);
    grid.append(el('button', {
      class: `mini-day${inMonth ? '' : ' is-out'}${d === todayDay ? ' is-today' : ''}${onScreen.has(d) ? ' is-shown' : ''}`,
      text: String(+fromDay(d).slice(8, 10)), title: formatDate(fromDay(d), 'long'),
      onclick: () => { miniMonth = null; goToWeek(d); },
    }));
  }
  const peopleQ = { value: '' };
  const everyone = [...new Map(entries.flatMap((e) => e.project.resources.filter((r) => r.type === 'work').map((r) => [personKeyOf(r), r.name]))).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const peopleList = el('div', { class: 'cals-list' });
  const drawPeople = () => {
    peopleList.replaceChildren(
      el('button', { class: `cals-item${!ui.calendarWho ? ' is-on' : ''}`, onclick: () => set({ calendarWho: '' }) },
        el('span', { class: 'cals-chip', style: { background: 'var(--sc-text-3)' } }), el('span', { text: 'Everyone' })),
      ...everyone.filter(([, n]) => n.toLowerCase().includes(peopleQ.value.toLowerCase())).map(([key, name]) => {
        const c = personColour(name);
        return el('button', { class: `cals-item${ui.calendarWho === key ? ' is-on' : ''}`, onclick: () => set({ calendarWho: ui.calendarWho === key ? '' : key }) },
          el('span', { class: 'cals-chip', style: { background: c.line } }), el('span', { text: name }));
      }));
  };
  drawPeople();
  const palette = planPalette(entries);
  const feedsList = entries.flatMap((e) => (e.project.feeds || []).map((f) => ({ f, plan: e.project })));
  const section = (title, count, body, extra = null) => el('details', { class: 'cals-section', open: true },
    el('summary', {}, el('span', { text: `${title}${count !== null ? ` (${count})` : ''}` }), extra), body);
  root.append(el('div', { class: 'cal-side' },
    el('div', { class: 'mini-head' },
      el('strong', { text: `${MONTH_NAMES[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}` }),
      el('button', { class: 'sc-button sc-button--ghost sc-button--sm', text: 'Today', onclick: () => { miniMonth = null; showThisWeek(); } }),
      el('span', { class: 'sc-spacer' }),
      el('button', { class: 'side-icon', text: '‹', title: 'Month before', onclick: () => { miniMonth = addMonths(month, -1); set({}); } }),
      el('button', { class: 'side-icon', text: '›', title: 'Month after', onclick: () => { miniMonth = addMonths(month, 1); set({}); } })),
    grid,
    el('div', { class: 'cals-head' }, el('strong', { text: 'Calendars' }),
      el('button', { class: 'sc-button sc-button--ghost sc-button--sm', text: '＋ Add calendar', onclick: () => act.connectCalendarDialog() })),
    el('input', { class: 'sc-input cals-search', type: 'search', placeholder: 'Search teammates', oninput: (e) => { peopleQ.value = e.target.value; drawPeople(); } }),
    section('People', everyone.length, peopleList),
    section('My calendars', feedsList.length, el('div', { class: 'cals-list' },
      ...(feedsList.length ? feedsList.map(({ f, plan }) => el('div', { class: 'cals-item is-static', title: `${f.events.length} events · on ${plan.name}` },
        el('span', { class: 'cals-chip', style: { background: 'var(--sc-accent-2)' } }), el('span', { text: f.name }),
        el('span', { class: 'cals-src', text: f.provider === 'google' ? 'G' : f.provider === 'outlook' ? 'O' : 'ics' })))
        : [el('div', { class: 'sc-faint small', text: 'None connected. Add a Google or Outlook calendar and its meetings become busy time.' })]))),
    section('Projects', entries.length, el('div', { class: 'cals-list' },
      ...entries.map((e) => {
        const c = palette.get(e.project.id) || personColour(e.project.name);
        const hours = Math.round(all.blocks.filter((b) => b.planId === e.project.id && onScreen.has(b.day)).reduce((n, b) => n + b.minutes, 0) / 6) / 10;
        return el('button', { class: `cals-item${e.project.id === project.id ? ' is-on' : ''}`, title: e.project.id === project.id ? 'The open project' : 'Open this project',
          onclick: () => { if (e.project.id !== project.id) void openOther(e.project.id, null); } },
        el('span', { class: 'cals-chip', style: { background: c.line } }), el('span', { text: e.project.name }),
        hours ? el('span', { class: 'cals-src', text: `${hours}h` }) : null);
      })))));
}

/** What will not make its deadline, across the plans the calendar covers. */
export const lateness = () => currentLayout().all.late || [];

export async function reloadCalendarPlans() {
  try {
    const records = await planRecords();
    const out = [];
    const past = [];
    for (const r of records) {
      if (r.id === store.project.id) continue;
      const hit = planCache.get(r.id);
      if (hit && hit.updatedAt === r.updatedAt) { (hit.history ? past : out).push(hit.entry); continue; }
      try {
        const project = parse(r.body).project;
        // A template's tasks are a pattern to copy: not on the calendar. An
        // archived or finished plan's are history: nothing of it is planned,
        // but the time worked on it stays where it was worked. Workspaces are
        // not a filter here: the calendar is every hour, always.
        if (project.template) continue;
        const history = !isLiveWork(project);
        const entry = { project, schedule: computeSchedule(project) };
        planCache.set(r.id, { updatedAt: r.updatedAt, entry, history });
        (history ? past : out).push(entry);
      } catch { /* a plan that cannot be read simply is not on the calendar */ }
    }
    others = out;
    historyPlans = past;
    othersVersion++;
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

/** Hours as a person says them: 12h, 1.5h, 30 min. */
const hoursText = (minutes) => (minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 6) / 10}h`);

/** One line of what will be late, readable on its own. */
export function lateSentence(l) {
  const by = formatDate(l.deadlineIso, 'day');
  return l.finishIso
    ? `${l.name} will not be finished by ${by}: ${hoursText(l.minutesShort)} lands after it, and at this rate it is done ${formatDate(l.finishIso, 'day')}.`
    : `${l.name} will not be finished by ${by}: ${hoursText(l.minutesShort)} does not fit anywhere in the next six months at this rate.`;
}

/**
 * What will be late, in one line that opens into the list. The week is the
 * page; the warning is a strip above it, not a panel pushing it down.
 */
let lateOpen = false;
function lateBanner(list) {
  const box = el('details', { class: 'cal-late', open: lateOpen, ontoggle: (e) => { lateOpen = e.currentTarget.open; } },
    el('summary', {},
      el('span', { class: 'cal-late-dot' }),
      el('strong', { text: list.length === 1 ? 'One deadline will be missed' : `${list.length} deadlines will be missed` }),
      el('span', { class: 'cal-late-first', text: ` — ${lateSentence(list[0])}` })));
  const ul = el('ul', { class: 'cal-late-list' });
  for (const l of list.slice(0, 12)) {
    ul.append(el('li', {
      class: 'clickable', title: `${l.planName} — click to open the task`,
      onclick: () => { void taskSheet({ planId: l.planId, taskId: l.taskId }); },
    }, lateSentence(l), el('span', { class: 'sc-faint', text: ` · ${l.planName}` })));
  }
  if (list.length > 12) ul.append(el('li', { class: 'sc-faint', text: `and ${list.length - 12} more.` }));
  box.append(ul);
  return box;
}

/**
 * Drag a block to pin it.
 *
 * Moving a computed block turns it into a pin at the spot it was dropped;
 * moving a pinned one moves its pin. The drop snaps to a quarter of an hour
 * and to whichever day column is under the pointer, and a drag of a few
 * pixels is still a click, so selecting a block does not pin it by accident.
 */
function startDrag(e, b, { hourFrom }) {
  if (e.button !== 0) return;
  const block = e.currentTarget;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let dragging = false;
  const move = (ev) => {
    const dx = ev.clientX - x0;
    const dy = ev.clientY - y0;
    if (!dragging && Math.hypot(dx, dy) < 6) return;
    dragging = true;
    block.classList.add('is-dragging');
    block.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  const up = (ev) => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    if (!dragging) return;
    block.dataset.dragged = '1';
    block.classList.remove('is-dragging');
    block.style.transform = '';
    const col = document.elementsFromPoint(ev.clientX, ev.clientY)
      .map((node) => node.closest?.('.cal-col[data-day]')).find(Boolean);
    if (!col) return;
    const rect = col.getBoundingClientRect();
    const topPx = (ev.clientY - y0) + (block.getBoundingClientRect().top - rect.top) - 0;
    const raw = hourFrom * 60 + (topPx / HOUR_H) * 60;
    const start = Math.max(0, Math.min(24 * 60 - b.minutes, Math.round(raw / 15) * 15));
    act.pinBlock(b.taskId, { day: col.dataset.day, start, minutes: b.minutes }, b.pinned ? b.pinIndex : null);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

/** A block from another plan: open that plan, and land on the task. */
async function openOther(planId, taskId) {
  const { openPlan } = await import('../state/sync.js');
  if (!(await openPlan(planId))) return;
  if (!taskId) return;
  act.revealTask(taskId);
  act.selectTask(taskId);
  void taskSheet({ taskId });
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
  const { entries, history = [], all } = currentLayout();
  // Blocks can belong to a finished project too (time worked on it): look them up in both.
  const known = [...entries, ...history];
  // Whose week this is, by name — the same person is a different id in each plan.
  const everyone = [...new Map(entries.flatMap((e) => e.project.resources.map((r) => [personKeyOf(r), r.name]))).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const who = ui.calendarWho && everyone.some(([k]) => k === ui.calendarWho) ? ui.calendarWho : '';
  const blocks = who ? all.blocks.filter((b) => (b.people || []).includes(who)) : [...all.blocks];
  const meetings = who ? (all.meetings || []).filter((m) => m.lane === who || m.lane === '*') : all.meetings;
  const overflow = all.overflow;
  const colourMode = colourModeFor(blocks);
  const palette = planPalette(known);
  const phaseList = phases(project);
  const current = project.currentPhaseId ? getPhase(project, project.currentPhaseId) : null;
  const planCount = entries.length;
  // The filters live in Display options (the toolbar) and the colours in
  // the right-hand panel, as Motion keeps them: the page is the week.
  const showTasks = ui.calShowTasks !== false;
  const showWorked = ui.calShowWorked !== false;
  if (!showTasks) blocks.splice(0, blocks.length, ...blocks.filter((b) => b.worked && showWorked));
  else if (!showWorked) blocks.splice(0, blocks.length, ...blocks.filter((b) => !b.worked));
  void current; void phaseList;

  const shown = entries.flatMap((e) => e.project.tasks.filter((t, i) => !isSummary(e.project, i) && agendaOf(e.project, t).show));
  if (!shown.length) {
    pane.append(el('div', { class: 'empty-note sc-muted' },
      el('p', { text: 'Nothing is on the calendar yet.' }),
      el('p', { text: 'Open a task’s details and switch on “Auto-schedule”. It will be cut into blocks of the size you choose — half an hour, one, one and a half, two or four — and laid inside the hours you say you work.' }),
      el('button', { class: 'sc-button sc-button--sm', text: 'Auto-schedule every unfinished task', onclick: () => act.showAllInCalendar() })));
    return;
  }

  const range = rangeOf();
  const screen = daysOnScreen(project);
  // The most valuable sentence the view can say: "you cannot finish this by
  // Friday". One line per task that will not make its deadline at this rate,
  // with how much will not fit and when it would really be done.
  const lateHere = (all.late || []).filter((l) => !who || (all.byTask.get(l.taskId) || []).some((b) => (b.people || []).includes(who)));
  if (lateHere.length) pane.append(lateBanner(lateHere));

  if (range === 'month') { renderMonth(pane, { entries: known, blocks, meetings, screen, project, who, planCount, colourMode, palette }); return; }
  const columns = screen.days;

  // The hours to draw: every task's window, and every block, has to fit.
  const base = { ...DEFAULT_AGENDA, ...(project.agenda || {}) };
  let from = parseTime(base.from) ?? 540, to = parseTime(base.to) ?? 1020;
  for (const e of entries) for (const t of e.project.tasks) { if (!agendaOf(e.project, t).show) continue; const a = agendaOf(e.project, t); from = Math.min(from, a.from); to = Math.max(to, a.to); }
  for (const b of blocks) if (columns.includes(b.day)) { from = Math.min(from, b.start); to = Math.max(to, b.end); }
  for (const m of (meetings || [])) if (columns.includes(m.day) && !m.allDay) { from = Math.min(from, m.start - (m.bufferBefore || 0)); to = Math.max(to, m.end + (m.bufferAfter || 0)); }
  const hourFrom = Math.floor(from / 60), hourTo = Math.ceil(to / 60);
  const y = (min) => ((min - hourFrom * 60) / 60) * HOUR_H;

  const todayDay = toDay(today());
  const head = el('div', { class: 'cal-head' }, el('div', { class: 'cal-gutter cal-tz', text: timeZoneLabel(), title: 'Times are in this time zone' }));
  for (const d of columns) {
    // "Sun 20", today's number in a pill — the week reads as dates, not labels.
    head.append(el('div', { class: `cal-col-head${d === todayDay ? ' is-today' : ''}` },
      el('span', { class: 'cal-dow', text: WEEKDAY_NAMES[((d + 4) % 7 + 7) % 7].slice(0, 3) }),
      el('span', { class: 'cal-dnum', text: String(+fromDay(d).slice(8, 10)) })));
  }
  pane.append(head);

  const body = el('div', { class: 'cal-body' });
  const gutter = el('div', { class: 'cal-gutter' });
  for (let h = hourFrom; h < hourTo; h++) {
    gutter.append(el('div', { class: 'cal-hour sc-mono', style: { height: `${HOUR_H}px` }, text: formatClock(h * 60) }));
  }
  body.append(gutter);

  for (const d of columns) {
    const col = el('div', { class: `cal-col${d === todayDay ? ' is-today' : ''}`, 'data-day': fromDay(d), style: { height: `${(hourTo - hourFrom) * HOUR_H}px` } });
    for (let h = hourFrom; h < hourTo; h++) col.append(el('div', { class: 'cal-line', style: { top: `${(h - hourFrom) * HOUR_H}px` } }));
    // Now: a line across today at the minute it is.
    if (d === todayDay) col.append(el('div', { class: 'cal-now', 'data-from': String(hourFrom * 60), title: 'Now', style: { top: `${((nowMinutes() - hourFrom * 60) / 60) * HOUR_H}px` } }));
    // Drag down empty time: pick the hours, then say what goes in them — the
    // same menu as a right-click, for exactly the range drawn.
    col.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.cal-block, .cal-meeting, .cal-buffer, .cal-slot-ghost')) return;
      e.preventDefault();
      const top = col.getBoundingClientRect().top;
      const minuteAt = (cy) => hourFrom * 60 + ((cy - top) / HOUR_H) * 60;
      const snap = (m) => Math.max(0, Math.min(24 * 60, Math.round(m / 15) * 15));
      const anchor = Math.max(0, Math.min(24 * 60 - 15, Math.floor(minuteAt(e.clientY) / 15) * 15));
      let range = [anchor, anchor + 15];
      let moved = false;
      const ghost = el('div', { class: 'cal-slot-ghost' });
      const paint = () => {
        ghost.style.top = `${y(range[0])}px`;
        ghost.style.height = `${y(range[1]) - y(range[0])}px`;
        ghost.textContent = `${formatClock(range[0])} – ${formatClock(range[1])}`;
      };
      const move = (ev) => {
        if (Math.abs(ev.clientY - e.clientY) > 4 && !moved) { moved = true; col.append(ghost); }
        if (!moved) return;
        const b = snap(minuteAt(ev.clientY));
        range = b >= anchor ? [anchor, Math.max(anchor + 15, b)] : [b, anchor + 15];
        paint();
      };
      const up = (ev) => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        if (!moved) return;
        const drop = () => ghost.remove();
        slotMenu({ day: col.dataset.day, start: range[0], end: range[1] }, ev.clientX, ev.clientY, drop);
        setTimeout(() => addEventListener('pointerdown', drop, { once: true, capture: true }), 0);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });
    // Right-click empty time: an event or a fixed-time task there, half an
    // hour from the quarter hour clicked, marked while the menu is open.
    col.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.cal-block, .cal-meeting, .cal-buffer')) return;
      e.preventDefault();
      const raw = hourFrom * 60 + ((e.clientY - col.getBoundingClientRect().top) / HOUR_H) * 60;
      const start = Math.max(0, Math.min(24 * 60 - 30, Math.floor(raw / 15) * 15));
      const end = start + 30;
      const ghost = el('div', { class: 'cal-slot-ghost', style: { top: `${y(start)}px`, height: `${y(end) - y(start)}px` } }, `${formatClock(start)} – ${formatClock(end)}`);
      col.append(ghost);
      const drop = () => ghost.remove();
      slotMenu({ day: col.dataset.day, start, end }, e.clientX, e.clientY, drop);
      setTimeout(() => addEventListener('pointerdown', drop, { once: true, capture: true }), 0);
    });
    // Meetings from a connected calendar sit behind the work, because that is
    // what they are: hours already spoken for.
    for (const m of (meetings || []).filter((x) => x.day === d)) {
      // Travel time, when the event is somewhere: booked as busy, drawn as a
      // hatched edge so it is clear why no work sits right up against it.
      if (m.bufferBefore) {
        col.append(el('div', { class: 'cal-buffer', title: `${m.bufferBefore} minutes to get to ${m.location}`,
          style: { top: `${y(m.start - m.bufferBefore)}px`, height: `${Math.max(3, y(m.start) - y(m.start - m.bufferBefore))}px` } }));
      }
      if (m.bufferAfter) {
        col.append(el('div', { class: 'cal-buffer', title: `${m.bufferAfter} minutes back from ${m.location}`,
          style: { top: `${y(m.end)}px`, height: `${Math.max(3, y(m.end + m.bufferAfter) - y(m.end))}px` } }));
      }
      col.append(el('div', {
        class: `cal-meeting${m.allDay ? ' is-allday' : ''}${m.own ? ' is-own' : ''}${m.free ? ' is-free' : ''}`,
        onclick: () => { void meetingSheet(m); },
        style: { top: `${y(m.start)}px`, height: `${Math.max(14, y(m.end) - y(m.start) - 1)}px`, ...(m.colour && EVENT_COLOURS[m.colour] ? { '--ev': EVENT_COLOURS[m.colour].hex } : {}) },
        title: `${m.title}\n${m.allDay ? 'All day' : `${formatClock(m.start)} – ${formatClock(m.end)}`}${m.location ? `\n${m.location}` : ''}${m.bufferBefore ? `\n${m.bufferBefore} minutes' travel either side` : ''}`,
      }, el('div', { class: 'cal-meeting-name', text: m.title }),
        m.own && !m.allDay ? el('div', { class: 'cal-meeting-time', text: `${formatClock(m.start)} – ${formatClock(m.end)}${m.location ? ` · ${m.location}` : ''}` }) : null));
    }
    for (const { block: b, lane: slot, lanes } of sideBySide(blocks.filter((x) => x.day === d))) {
      const entry = known.find((e) => e.project.id === b.planId) || known[0];
      const t = entry.project.tasks.find((x) => x.id === b.taskId);
      const info = entry.schedule.tasks[b.taskId];
      if (!t || !info) continue;
      const person = whoOf(known, b);
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
        'data-task': b.taskId,
        class: `cal-block${oneDay ? ' is-day' : ''}${tight && !oneDay ? ' is-tight' : ''}${b.overdue ? ' is-overdue' : ''}${b.late ? ' is-late' : ''}${b.pinned ? ' is-pinned' : ''}${b.live ? ' is-live' : ''}${b.worked ? ' is-worked' : ''}${!foreign && !b.worked ? ' is-draggable' : ''}${b.critical ? ' is-critical' : ''}${ui.selection.includes(t.id) && !foreign ? ' is-sel' : ''}${foreign ? ' is-other-plan' : ''}`,
        style: {
          top: `${y(b.start)}px`, height: `${height}px`, left: `calc(${slot * width}% + 3px)`, width: `calc(${width}% - 6px)`, right: 'auto',
          '--who': colour.line, background: colour.fill, borderLeftColor: colour.line,
        },
        title: `${t.name}\n${b.planName}${person.names.length ? ` · ${person.names.join(', ')}` : ''}\n${formatClock(b.start)} – ${formatClock(b.end)} · ${b.minutes / 60}h\n${info.percent}% complete${b.overdue ? `\nOverdue: it was due to start ${formatDate(fromDay(info.start), 'long')}` : ''}${b.late ? `\nAfter its deadline, ${formatDate(t.deadline, 'long')}` : ''}${b.pinned ? '\nPinned here by hand — drag to move, or Unpin from the menu' : foreign ? '' : '\nDrag to pin it somewhere else'}`,
        onclick: (e) => {
          if (e.currentTarget.dataset.dragged) { delete e.currentTarget.dataset.dragged; return; }
          const lateLine = (all.late || []).find((l) => l.taskId === t.id && l.planId === b.planId);
          if (b.worked) { void taskSheet({ planId: b.planId, taskId: b.taskId }); return; }
          void blockSheet(b, { late: lateLine ? lateSentence(lateLine) : null });
        },
        onpointerdown: foreign || b.worked ? null : (e) => startDrag(e, b, { hourFrom, y }),
        oncontextmenu: (e) => {
          e.preventDefault();
          if (!foreign) act.selectTask(t.id);
          blockMenu(b, e.clientX, e.clientY);
        },
      },
        el('div', { class: 'cal-block-time sc-mono' },
          b.worked ? el('span', { class: 'cal-pin', title: 'Worked — logged time', text: '✓' })
            : b.live ? el('span', { class: 'cal-pin', title: 'Running now', text: '▶' })
            : null,
          oneDay ? `${formatClock(b.start)} – ${formatClock(b.end)}` : formatClock(b.start),
          person.initials ? el('span', { class: 'cal-who', text: person.initials }) : null,
          // Fixed at this time: a lock, and clicking it lets the calendar place the task again.
          b.pinned ? el('button', { class: 'cal-lock', title: 'This task is locked at this time — click to release it',
            onpointerdown: (e) => e.stopPropagation(),
            onclick: (e) => { e.stopPropagation(); void unlockBlock(b); } }, icon('lock')) : null),
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
        onclick: () => showText('Not auto-scheduled', heldBackDetail.join('\n')),
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
        onclick: (e) => { e.stopPropagation(); if (foreign) { void openOther(b.planId, t.id); return; } act.selectTask(t.id); void taskSheet({ taskId: t.id }); },
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
