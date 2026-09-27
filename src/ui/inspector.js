// Project scheduling settings (working time, calendars, schedules) and a task's logged time, each in a window.
import { el, clear, formatHours } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { getResource, timesheetsFor, stages } from '../model/model.js';
import { today, WEEKDAY_NAMES } from '../model/calendar.js';
import { BLOCK_CHOICES, GAP_CHOICES, LOAD_CHOICES, CAP_CHOICES, DEFAULT_AGENDA } from '../model/agenda.js';
import { timeBlocks, feeds, PROVIDERS, bufferOf, BUFFER_CHOICES } from '../model/model.js';
import { describeSchedule } from './schedules.js';
import { subscribe as subscribeStore } from '../state/store.js';

const field = (label, input, hint) => el('label', { class: 'sc-field' }, el('span', { class: 'sc-label', text: label }), input, hint ? el('span', { class: 'sc-faint field-hint', text: hint }) : null);
const readout = (rows) => el('div', { class: 'readout sc-mono' }, ...rows.map(([k, v]) => el('div', { class: 'readout-row' }, el('span', { class: 'sc-muted', text: k }), el('span', { text: v }))));

const stopKeys = (input) => { input.addEventListener('keydown', (e) => e.stopPropagation()); return input; };
const text = (value, onchange, attrs = {}) => stopKeys(el('input', { class: 'sc-input', type: 'text', value, spellcheck: false, onchange: (e) => onchange(e.target.value), ...attrs }));
const date = (value, onchange) => stopKeys(el('input', { class: 'sc-input', type: 'date', value: value || '', onchange: (e) => onchange(e.target.value) }));
const select = (value, options, onchange) => el('select', { class: 'sc-select', onchange: (e) => onchange(e.target.value) }, ...options.map((o) => el('option', { value: o.value, text: o.label, selected: o.value === value })));

/** A task's logged time: what was allocated, spent and is left, and each line, editable. */
export function renderTimeLines(root, id) {
  const { project, schedule } = store;
  const t = project.tasks.find((x) => x.id === id);
  const s = schedule.tasks[id];
  if (!t || !s) return;
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

/** A window over a part of this panel that redraws as the plan changes. */
function liveDialog(title, draw, { wide = true } = {}) {
  let off = () => {};
  const done = import('./dialog.js').then(({ open, foot, button }) => open(title, (close) => {
    const body = el('div', { class: 'insp settings-dialog' });
    const redraw = () => { const y = body.scrollTop; clear(body); draw(body); body.scrollTop = y; };
    redraw();
    let rev = store._rev;
    off = subscribeStore(() => { if (store._rev !== rev) { rev = store._rev; if (document.body.contains(body)) redraw(); } });
    return [body, foot(el('span', { class: 'sc-spacer' }), button('Done', () => close(true), 'sc-button--primary'))];
  }, { wide }));
  return done.then(() => off());
}

/** Project settings: working time and how the calendar schedules — Motion keeps these in Settings. */
export const projectSettingsDialog = () => liveDialog(`Project settings — ${store.project.name}`, (root) => renderProject(root));
/** Logged time for one task. */
export const timeLogDialog = (taskId) => liveDialog('Logged time', (root) => renderTimeLines(root, taskId), { wide: false });

/** The open project's scheduling settings, drawn in `root`; `only` picks one part: 'working', 'calendars' or 'schedules'. */
export const renderProjectSettings = (root, only = null) => renderProject(root, { only });

function renderProject(root, { only = null } = {}) {
  const { project } = store;
  // The project itself — name, dates, stages, status, colour — is in its
  // window; this is how it is scheduled: working time and the calendar.
  const want = (part) => !only || only === part;
  const form = el('div', { class: 'insp-form' });
  form.append(field('Status date', date(project.statusDate, (v) => act.setProjectInfo({ statusDate: v })), 'what “today” is for progress — blank is today'));
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
      CAP_CHOICES.map((h) => ({ value: String(h), label: h ? `${h} hours` : 'No limit — fill the schedule' })), (v) => act.setAgenda({ dailyCap: +v })),
      'per person; with no limit the schedule’s hours are filled, as Motion fills them')));
  form.append(field('When a task does not say its hours', select(String((project.agenda || {}).assumedLoad ?? DEFAULT_AGENDA.assumedLoad),
    LOAD_CHOICES.map((n) => ({ value: String(n), label: n === 100 ? 'All of its duration — full time' : `${n}% of its duration` })), (v) => act.setAgenda({ assumedLoad: +v })),
    'Microsoft Project counts a task’s days in full; a task’s own duration (its hours) always wins'));
  form.append(field('Holidays', stopKeys(el('textarea', { class: 'sc-textarea sc-mono', rows: 4, value: project.calendar.holidays.join('\n'), onchange: (e) => {
    const list = e.target.value.split(/[\n,;\s]+/).map((x) => x.trim()).filter(Boolean);
    const bad = list.filter((x) => !/^\d{4}-\d{2}-\d{2}$/.test(x));
    if (bad.length) { act.hint(`Not a date: ${bad[0]} (use YYYY-MM-DD, one per line).`); return; }
    act.setCalendar({ holidays: [...new Set(list)].sort() });
  } })), 'one date per line, YYYY-MM-DD'));
  if (want('working')) root.append(el('div', { class: 'sc-section-title', text: 'Working time' }), form);
  // ---- connected calendars: real meetings, so work goes around them
  if (want('calendars')) {
  root.append(el('div', { class: 'sc-section-title', text: 'Connected calendars' }));
  root.append(el('p', { class: 'sc-muted small', text: 'Meetings on these calendars become busy hours the calendar schedules around. Google: sign in once and tick calendars. Outlook, Hotmail and others: paste the calendar’s published iCalendar link. Both are read through your sync server, and read again as the calendar opens.' }));
  const list = el('div', { class: 'link-list' });
  for (const f of feeds(project)) {
    list.append(el('div', { class: 'tb-card sc-card' },
      el('div', { class: 'tb-row feed-row' },
        text(f.name, (v) => act.editCalendar(f.id, 'name', v)),
        select(f.resourceId || '', [{ value: '', label: 'Me / unassigned' }, ...project.resources.map((r) => ({ value: r.id, label: r.name }))], (v) => act.editCalendar(f.id, 'resourceId', v)),
        select(String(bufferOf(f)), BUFFER_CHOICES.map((m) => ({ value: String(m), label: m === 0 ? 'No travel time' : `${m} min travel` })), (v) => act.editCalendar(f.id, 'bufferMinutes', +v)),
        el('button', { class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', text: '↻', title: 'Read it again', onclick: () => act.refreshCalendar(f.id) }),
        el('button', { class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', text: '✕', title: 'Disconnect', onclick: () => act.disconnectCalendar(f.id) })),
      el('div', { class: 'sc-faint small', text: `${f.google ? `Google · ${f.google.account}` : PROVIDERS[f.provider]} · ${f.events.length} busy event${f.events.length === 1 ? '' : 's'}${f.events.some((e) => e.location) ? `, ${f.events.filter((e) => e.location).length} with a place to get to` : ''}${f.fetchedAt ? ` · read ${new Date(f.fetchedAt).toLocaleString()}` : ' · not read yet'}` })));
  }
  list.append(el('div', { class: 'tb-row' },
    el('button', { class: 'sc-button sc-button--sm sc-button--primary', text: '＋ Google calendars…', title: 'Sign in with Google and tick calendars', onclick: () => { void import('./gcal.js').then((m) => m.googleCalendarsDialog()); } }),
    el('button', { class: 'sc-button sc-button--sm', text: '+ Paste a calendar link…', title: 'Outlook, Hotmail or any published iCalendar address', onclick: () => act.connectCalendarDialog() })));
  root.append(list);
  }

  // ---- schedules: the hours of the week that are for a kind of work. They
  // are drawn on their own page, because a week is not three boxes.
  if (!want('schedules')) return;
  root.append(el('div', { class: 'sc-section-title', text: 'Schedules' }));
  root.append(el('p', { class: 'sc-muted small', text: 'The hours each kind of work may use, shared by every project.' }));
  const sched = el('div', { class: 'link-list' });
  for (const b of timeBlocks(project)) {
    sched.append(el('div', { class: 'sched-mini' }, el('strong', { text: b.name }), el('span', { class: 'sc-faint small', text: describeSchedule(b) })));
  }
  sched.append(el('button', { class: 'sc-button sc-button--sm', text: 'Edit schedules…', onclick: () => set({ view: 'schedules' }) }));
  root.append(sched);
}
