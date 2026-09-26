// Editing commands over the store: what menus, keys, toolbar and grid all call.

import { store, set, commit, tryCommit, emit } from './store.js';
import * as agendaModule from '../model/agenda.js';
import { hosted } from '../host.js';
import {
  insertTask as insertTaskRaw, removeTasks, indentTasks, outdentTasks, moveTask, linkChain, unlinkAll, link, unlink, taskIndex, descendants,
  setTaskField, setFinish, isSummary, getTask, addResource, removeResource, setResourceField, assign, unassign,
  setStage, addStage, renameStage, removeStage, moveStage, setStageDone,
  addTimesheet, removeTimesheet, setTimesheetField, breakIntoSubtasks, isSummary as isSummaryAt,
  addFeed, removeFeed, setFeedField, setFeedEvents, feeds, getFeed,
  addPhase, setPhaseField, removePhase, movePhase, getPhase, phases,
  cleanField, fieldsOf, getField, removeField, setFieldValue, getResource,
  setPin, removePin, clearPins, phaseOf, pinsOf, stopWork, saveEvent, removeEvent, addComment,
} from '../model/model.js';
import { workspaceNow } from './sync.js';
import { taskDefaults } from '../ui/taskdefaults.js';
import { setProjectField, commentOnProject, extendStage, fixTaskToStage, completeStage, cancelStage, reopenStage, setCurrentStage, autoAdvance, logProject, insertStage } from '../model/stages.js';

export const hint = (text) => set({ hint: text });
/** Run an undoable edit; true when it applied, false when it threw (the message is shown as the hint). */
function attempt(label, fn) { try { commit(label, fn); return true; } catch { return false; } }

export const activeId = () => store.ui.selection[store.ui.selection.length - 1] || null;
export const activeTask = () => getTask(store.project, activeId());
export const activeInfo = () => (activeId() ? store.schedule.tasks[activeId()] : null);

// ---------------------------------------------------------------- selection

export function selectTask(id, { extend = false, range = false } = {}) {
  const { ui, project } = store;
  if (!id) { set({ selection: [] }); return; }
  if (range && ui.selection.length) {
    const a = taskIndex(project, activeId()), b = taskIndex(project, id);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const ids = project.tasks.slice(lo, hi + 1).map((t) => t.id).filter((x) => visibleIds().has(x));
    set({ selection: id === project.tasks[lo].id ? ids.reverse() : ids });
  } else if (extend) {
    set({ selection: ui.selection.includes(id) ? ui.selection.filter((x) => x !== id) : [...ui.selection, id] });
  } else set({ selection: [id] });
}
export function selectAll() { set({ selection: store.project.tasks.map((t) => t.id) }); }

/** Tasks shown in the grid: everything not hidden under a collapsed summary. */
export function visibleTasks() {
  const { project, ui } = store;
  const out = [];
  let hideBelow = Infinity;
  project.tasks.forEach((t, i) => {
    if (t.level > hideBelow) return;
    hideBelow = Infinity;
    out.push(t);
    if (ui.collapsed[t.id] && isSummary(project, i)) hideBelow = t.level;
  });
  return out;
}
export const visibleIds = () => new Set(visibleTasks().map((t) => t.id));

export function toggleCollapse(id) {
  const collapsed = { ...store.ui.collapsed };
  if (collapsed[id]) delete collapsed[id]; else collapsed[id] = true;
  set({ collapsed });
}
export function collapseAll(on) {
  const { project } = store;
  const collapsed = {};
  if (on) project.tasks.forEach((t, i) => { if (isSummary(project, i)) collapsed[t.id] = true; });
  set({ collapsed });
}
export function revealTask(id) {
  const { project, ui } = store;
  const i = taskIndex(project, id);
  if (i < 0) return;
  const collapsed = { ...ui.collapsed };
  let lvl = project.tasks[i].level;
  for (let j = i - 1; j >= 0; j--) if (project.tasks[j].level < lvl) { delete collapsed[project.tasks[j].id]; lvl = project.tasks[j].level; }
  set({ collapsed });
}

/** Move the active row up or down among the visible rows. */
export function moveCursor(delta, { extend = false } = {}) {
  const rows = visibleTasks();
  if (!rows.length) return;
  const cur = rows.findIndex((t) => t.id === activeId());
  const next = rows[Math.max(0, Math.min(rows.length - 1, (cur < 0 ? (delta > 0 ? -1 : rows.length) : cur) + delta))];
  selectTask(next.id, { range: extend });
}

/**
 * Who a new task goes to when nobody is named: the workspace's default
 * assignee (Workspace settings), else the one in Task defaults. They join the
 * plan as a resource if they are not on it yet.
 */
export function defaultAssigneeFor(p) {
  const w = workspaceNow(p.workspaceId);
  if (w?.defaultAssignee?.name) return w.defaultAssignee;
  const d = taskDefaults();
  return d.assigneeName ? { personId: d.assigneeId || null, name: d.assigneeName } : null;
}
export function applyDefaultAssignee(p, t) {
  if (!t || t.assignments.length || t.milestone) return;
  const who = defaultAssigneeFor(p);
  if (!who) return;
  const same = (r) => (who.personId && r.personId === who.personId) || String(r.name).trim().toLowerCase() === String(who.name).trim().toLowerCase();
  const r = p.resources.find((x) => x.type !== 'material' && x.type !== 'cost' && same(x)) || addResource(p, { name: who.name, personId: who.personId || null });
  assign(p, t.id, r.id, 1);
}
/** A task inserted by the planner: as the model makes it, then given its default assignee. */
function insertTask(p, at, props = {}) {
  const t = insertTaskRaw(p, at, props);
  applyDefaultAssignee(p, t);
  return t;
}

// ---------------------------------------------------------------- tasks

export function newTaskBelow() {
  const { project } = store;
  const id = activeId();
  const at = id ? taskIndex(project, id) + 1 + descendants(project, taskIndex(project, id)).length : project.tasks.length;
  const t = commit('Insert task', (p) => insertTask(p, at, id ? { level: getTask(p, id).level } : {}));
  set({ selection: [t.id], activeCol: 'name', editing: { kind: 'task', id: t.id, col: 'name' } });
  return t;
}
/** A new task at the end of a summary's tasks, one level in. */
export function newSubtask(summaryId) {
  const { project } = store;
  const i = taskIndex(project, summaryId);
  if (i < 0) return null;
  const at = i + 1 + descendants(project, i).length;
  const t = commit('Insert task', (p) => insertTask(p, at, { level: getTask(p, summaryId).level + 1 }));
  if (store.ui.collapsed[summaryId]) toggleCollapse(summaryId);
  set({ selection: [t.id], activeCol: 'name', editing: { kind: 'task', id: t.id, col: 'name' } });
  return t;
}
export function newTaskAbove() {
  const { project } = store;
  const id = activeId();
  const at = id ? taskIndex(project, id) : 0;
  const t = commit('Insert task', (p) => insertTask(p, at, id ? { level: getTask(p, id).level } : {}));
  set({ selection: [t.id], activeCol: 'name', editing: { kind: 'task', id: t.id, col: 'name' } });
  return t;
}
export function newMilestone() {
  const t = newTaskBelow();
  tryCommit('Milestone', (p) => setTaskField(p, t.id, 'milestone', true));
}
export function deleteSelection() {
  const ids = store.ui.selection;
  if (!ids.length) { hint('Select a task first.'); return; }
  const { project } = store;
  const first = Math.min(...ids.map((id) => taskIndex(project, id)));
  commit(`Delete ${ids.length > 1 ? `${ids.length} tasks` : 'task'}`, (p) => removeTasks(p, ids));
  const next = store.project.tasks[Math.min(first, store.project.tasks.length - 1)];
  set({ selection: next ? [next.id] : [] });
}
export function indentSelection() {
  const ids = store.ui.selection;
  if (!ids.length) return;
  const n = tryCommit('Indent', (p) => indentTasks(p, ids));
  if (n === 0) hint('The first task in a group cannot be indented further.');
}
export function outdentSelection() {
  const ids = store.ui.selection;
  if (!ids.length) return;
  const n = tryCommit('Outdent', (p) => outdentTasks(p, ids));
  if (n === 0) hint('The task is already at the top level.');
}
export function moveSelection(dir) {
  const id = activeId();
  if (!id) return;
  const ok = tryCommit(dir < 0 ? 'Move up' : 'Move down', (p) => moveTask(p, id, dir));
  if (!ok) hint('There is no sibling to move past.');
}
export function linkSelection() {
  const ids = store.ui.selection;
  if (ids.length < 2) { hint('Select two or more tasks (⇧-click or ⌘-click), then link them in order.'); return; }
  const idx = ids.map((id) => taskIndex(store.project, id)).sort((a, b) => a - b);
  const missing = idx.slice(1).some((i, k) => !store.project.tasks[i].predecessors.some((l) => l.id === store.project.tasks[idx[k]].id));
  if (!missing) { hint('Those tasks are already linked in that order.'); return; }
  const n = tryCommit('Link tasks', (p) => linkChain(p, ids));
  if (n === 0) hint('Those tasks cannot be linked (a summary and its own subtask, or a circular chain).');
}
export function unlinkSelection() {
  const ids = store.ui.selection;
  if (!ids.length) return;
  const n = tryCommit('Unlink tasks', (p) => unlinkAll(p, ids));
  if (n === 0) hint('Nothing was linked.');
}
export function linkTasks(fromId, toId, type = 'FS', lag = 0) {
  return attempt('Link tasks', (p) => link(p, fromId, toId, type, lag));
}
export function unlinkTasks(fromId, toId) { tryCommit('Unlink', (p) => unlink(p, fromId, toId)); }

/** A summary is a heading over tasks: it is not done, or a milestone, on its own. */
const summaryNo = (id, what) => {
  const i = taskIndex(store.project, id);
  if (i >= 0 && isSummary(store.project, i)) { hint(`A summary is not a task — ${what}`); return true; }
  return false;
};
export function toggleMilestone() {
  const t = activeTask();
  if (!t) return;
  if (summaryNo(t.id, 'make one of its tasks a milestone instead.')) return;
  tryCommit(t.milestone ? 'Not a milestone' : 'Milestone', (p) => setTaskField(p, t.id, 'milestone', !t.milestone));
}

/** Set a task field from user input; errors surface as the status hint. Returns true on success. */
export function editTask(id, field, value) {
  const label = { name: 'Rename', duration: 'Duration', start: 'Start', finish: 'Finish', percent: 'Progress', predecessors: 'Links', resources: 'Assignments' }[field] || `Edit ${field}`;
  if (field === 'finish') {
    const info = store.schedule.tasks[id];
    return attempt(label, (p) => setFinish(p, id, info.startIso, value));
  }
  // Every edit to a task may finish its stage; the project then moves on.
  const ok = attempt(label, (p) => { setTaskField(p, id, field, value); autoAdvance(p); });
  // Typing "Ana, Ben" into Resource Names invents resources; each one that is
  // new to the shelf joins the directory, so the next plan can pick them.
  if (ok && field === 'resources') void linkNewResources();
  return ok;
}

/** Any resource here that is not yet a person in the directory becomes one. */
async function linkNewResources() {
  for (const r of [...store.project.resources]) if (!r.personId) await rememberResource(r.id);
}
export function setPercent(id, percent) { if (summaryNo(id, 'its progress comes from its tasks.')) return false; return editTask(id, 'percent', percent); }
/** Drag a bar: pin the task to a new start with a Start No Earlier Than constraint. */
export function pinStart(id, iso) {
  return attempt('Move task', (p) => { const t = getTask(p, id); t.constraint = { type: t.constraint.type === 'MSO' ? 'MSO' : 'SNET', date: iso }; });
}
export function setDuration(id, days) { return editTask(id, 'duration', days); }

// ---------------------------------------------------------------- resources

/**
 * Add someone to this plan. People already known to the shelf are offered
 * first, because a person is not a per-project thing: bringing Uma into a
 * second plan should be picking her, not typing her in again.
 */
export async function newResource() {
  const { listPeople, rememberPerson } = await import('./sync.js');
  const known = (await listPeople()).filter((person) => !store.project.resources.some((r) => r.personId === person.id));
  if (known.length) {
    const { formDialog } = await import('../ui/dialog.js');
    const answer = await formDialog('Add someone', [
      { key: 'who', label: 'Who', type: 'select', value: known[0].id,
        options: [...known.map((p) => ({ value: p.id, label: `${p.name}${p.group ? ` · ${p.group}` : ''}` })), { value: '__new', label: '＋ Someone new…' }] },
      { key: 'name', label: 'Their name (for someone new)', type: 'text', value: '' },
    ], 'Add');
    if (!answer) return null;
    if (answer.who !== '__new') {
      const person = known.find((p) => p.id === answer.who);
      const r = commit('Add someone', (p) => addResource(p, {
        personId: person.id, name: person.name, initials: person.initials || '',
        type: person.resourceType || 'work', rate: person.rate || 0, group: person.group || '',
      }));
      set({ resourceId: r.id });
      return r;
    }
    const name = String(answer.name || '').trim() || 'New resource';
    const person = await rememberPerson({ name });
    const r = commit('Add someone', (p) => addResource(p, { personId: person?.id || null, name }));
    set({ resourceId: r.id, editing: { kind: 'resource', id: r.id, col: 'name' } });
    return r;
  }
  const r = commit('New resource', (p) => addResource(p, {}));
  set({ resourceId: r.id, editing: { kind: 'resource', id: r.id, col: 'name' } });
  return r;
}

/** Keep the directory in step when a resource is named or re-rated here. */
export async function rememberResource(id) {
  const r = store.project.resources.find((x) => x.id === id);
  if (!r || r.personId) return;
  const { rememberPerson } = await import('./sync.js');
  const person = await rememberPerson({ name: r.name, initials: r.initials, type: r.type, rate: r.rate, group: r.group });
  if (person) tryCommit('Link to the directory', (p) => setResourceField(p, id, 'personId', person.id));
}
export function deleteResource(id = store.ui.resourceId) {
  if (!id) { hint('Select a resource first.'); return; }
  commit('Delete resource', (p) => removeResource(p, id));
  set({ resourceId: null });
}
export function editResource(id, field, value) {
  const ok = attempt('Edit resource', (p) => setResourceField(p, id, field, value));
  // A resource that has just been given a real name becomes a person the other
  // plans can pick, rather than one more copy of the same human being.
  if (ok && field === 'name') void rememberResource(id);
  return ok;
}
export function assignResource(taskId, resourceId, units = 1) { return attempt('Assign', (p) => assign(p, taskId, resourceId, units)); }
export function unassignResource(taskId, resourceId) { tryCommit('Unassign', (p) => unassign(p, taskId, resourceId)); }

// ---------------------------------------------------------------- calendars

/**
 * Read a calendar's ICS. The page cannot fetch it directly — Google and
 * Outlook serve those addresses without CORS headers — so it goes through the
 * server this page is served from, which is also what lets the Mac app do it.
 */
async function fetchIcs(url) {
  // The Mac app serves the page from its own scheme and has no such endpoint,
  // so refreshing happens in a browser tab; the events themselves travel with
  // the plan, which is why the Mac app still shows them.
  if (hosted) throw new Error('Read this calendar in a browser tab (the Mac app has nothing to fetch it with). The events sync with the plan, so they will appear here.');
  let res;
  try { res = await fetch(`/api/ics?url=${encodeURIComponent(url)}`); }
  catch { throw new Error('The page has to be served by ./serve.sh to read a calendar (a browser cannot fetch one directly).'); }
  if (!res.ok) {
    let message = `The calendar could not be read (${res.status}).`;
    try { const j = await res.json(); message = j.error || message; } catch { /* not JSON */ }
    throw new Error(message);
  }
  return res.text();
}

/** Ask for an address, and say where each provider keeps theirs. */
export async function connectCalendarDialog() {
  const { formDialog } = await import('../ui/dialog.js');
  const answer = await formDialog('Connect a calendar', [
    { key: 'provider', label: 'Where it comes from', type: 'select', value: 'google',
      options: [{ value: 'google', label: 'Google Calendar' }, { value: 'outlook', label: 'Outlook' }, { value: 'ics', label: 'Other (iCalendar)' }] },
    { key: 'url', label: 'Private iCalendar address', type: 'text', placeholder: 'https://…',
      hint: 'Google: Settings ▸ Settings for my calendars ▸ Integrate calendar ▸ Secret address in iCal format. Outlook: Settings ▸ Calendar ▸ Shared calendars ▸ Publish a calendar ▸ ICS.' },
    { key: 'name', label: 'Called', type: 'text', value: 'My calendar' },
    { key: 'resourceId', label: 'Whose hours these are', type: 'select', value: '',
      options: [{ value: '', label: 'Me / unassigned' }, ...store.project.resources.map((r) => ({ value: r.id, label: r.name }))] },
  ], 'Connect');
  if (!answer) return null;
  return connectCalendar(answer);
}

export function connectCalendar({ name, url, provider, resourceId }) {
  const feed = tryCommit('Connect a calendar', (p) => addFeed(p, { name, url, provider, resourceId }));
  if (feed) void refreshCalendar(feed.id);
  return feed;
}

export async function refreshCalendar(id) {
  const feed = getFeed(store.project, id);
  if (!feed) return false;
  set({ hint: `Reading ${feed.name}…` });
  try {
    const text = await fetchIcs(feed.url);
    const { parseIcs } = await import('../io/ics.js');
    const { events, name } = parseIcs(text);
    const kept = tryCommit('Read a calendar', (p) => {
      const n = setFeedEvents(p, id, events);
      if (name && getFeed(p, id).name === 'My calendar') setFeedField(p, id, 'name', name);
      return n;
    });
    set({ hint: kept === undefined ? store.ui.hint : `${feed.name}: ${kept} busy event${kept === 1 ? '' : 's'}.` });
    return kept !== undefined;
  } catch (err) {
    set({ hint: err.message });
    return false;
  }
}

export async function refreshAllCalendars() {
  for (const f of feeds(store.project)) await refreshCalendar(f.id);
}
export function editCalendar(id, field, value) { return attempt('Edit calendar', (p) => setFeedField(p, id, field, value)); }
export function disconnectCalendar(id) { return attempt('Disconnect a calendar', (p) => removeFeed(p, id)); }

// ---------------------------------------------------------------- phases

/** Say which phase the plan is in; '' means every phase at once. */
export function setCurrentPhase(id) {
  return attempt('Current stage', (p) => { p.currentPhaseId = id || null; });
}

// ---------------------------------------------------------------- time blocks

// Time blocks are hours in a week, not properties of a project, so these go to
// the shared set and are written back into every plan (state/sync.js).
/**
 * Pin a block where it was dragged. `index` moves a pin that is already there;
 * without it a computed block becomes a new pin. Either way it is one undoable
 * step, and the rest of the week re-lays around it on the next draw.
 */
export function pinBlock(taskId, pin, index = null) {
  return attempt(index === null ? 'Pin a block' : 'Move a pinned block', (p) => { setPin(p, taskId, pin, index); });
}
/**
 * Start a task now: a block from this minute, as long as asked, fixed there.
 * It comes out of the task's hours, so the time it was planned for later is
 * freed; anything laid where it now sits moves, because a fixed block is
 * booked first. A block that was itself fixed moves rather than doubling.
 * When the task has less left than asked for, it is given the time — someone
 * sitting down to it for an hour means it takes at least that.
 */
export function startTaskNow(taskId, minutes, { pinIndex = null } = {}) {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  const start = d.getHours() * 60 + d.getMinutes();
  const length = Math.max(5, Math.min(Math.round(minutes), 24 * 60 - start));
  const ok = attempt('Start now', (p) => {
    const t = getTask(p, taskId);
    if (!t) throw new Error('No such task.');
    if (!t.calendar?.show) setTaskField(p, t.id, 'calendarShow', true);
    const info = store.schedule.tasks[t.id];
    if (info && info.percent < 100) {
      const left = agendaModule.hoursLeft(p, info, t);
      const want = length / 60;
      if (left + 1e-6 < want) {
        const expected = agendaModule.expectedHours(p, info, t);
        const hours = Math.max(expected - left + want, want / (1 - info.percent / 100));
        setTaskField(p, t.id, 'work', String(Math.ceil(hours * 100) / 100));
      }
    }
    // One running block a task: starting again moves the one already running.
    const running = pinsOf(t).findIndex((x) => x.live);
    setPin(p, t.id, { day, start, minutes: length, live: true }, pinIndex ?? (running >= 0 ? running : null));
  });
  if (ok && length < minutes) hint(`Only ${length} minutes are left in today; the block stops at midnight.`);
  return ok;
}

/** An event made on the calendar: busy time the work is laid around. */
export function saveOwnEvent(ev) { return attempt(ev.id ? 'Edit the event' : 'New event', (p) => saveEvent(p, ev)); }
export function deleteOwnEvent(id) { return attempt('Delete the event', (p) => removeEvent(p, id)); }

// ---------------------------------------------------------------- the project and its stages

export const editProject = (field, value) => attempt(`Project ${field}`, (p) => setProjectField(p, field, value));
export const commentProject = (text) => attempt('Comment', (p) => commentOnProject(p, text));
export const extendStageTo = (id, iso) => attempt('Extend the stage', (p) => extendStage(p, id, iso));
export const fixStageTasks = (id, taskIds) => attempt('Fix tasks past the stage', (p) => { for (const t of taskIds) fixTaskToStage(p, t, id); });
export const completeStageNow = (id) => attempt('Complete the stage', (p) => completeStage(p, id));
export const cancelStageNow = (id) => attempt('Cancel the stage', (p) => cancelStage(p, id));
export const reopenStageNow = (id) => attempt('Reopen the stage', (p) => reopenStage(p, id));
export const goToStage = (id) => attempt('Change stage', (p) => setCurrentStage(p, id));
export const createStage = (opts) => attempt('Create a stage', (p) => { insertStage(p, opts); });
export function addStageAfter(afterId, name = 'New stage') {
  return attempt('Add a stage', (p) => {
    const ph = addPhase(p, { name });
    const list = phases(p);
    list.splice(list.indexOf(ph), 1);
    const at = afterId ? list.findIndex((x) => x.id === afterId) + 1 : list.length;
    list.splice(at, 0, ph);
    p.phases = list;
    logProject(p, { kind: 'change', field: 'stages', from: '', to: `added ${ph.name}` });
  });
}
export function quickTaskInStage(stageId, name) {
  let made = null;
  const ok = attempt('New task', (p) => {
    // At the end of the stage's tasks in the outline, or the end of the plan.
    const idxs = p.tasks.map((t, i) => (phaseOf(p, t.id) === stageId ? i : -1)).filter((i) => i >= 0);
    const at = idxs.length ? idxs[idxs.length - 1] + 1 : p.tasks.length;
    const t = insertTask(p, at, { name, duration: 1, level: idxs.length ? p.tasks[idxs[idxs.length - 1]].level : 1 });
    if (stageId) t.phaseId = stageId;
    setTaskField(p, t.id, 'work', '0.5');
    const who = p.resources.find((r) => r.type === 'work');
    if (who) assign(p, t.id, who.id, 1);
    const ph = getPhase(p, stageId);
    if (ph?.deadline) setTaskField(p, t.id, 'deadline', ph.deadline);
    t.activity = (t.activity || []).slice(0, 1);
    made = t;
  });
  return ok ? made : null;
}

/** A comment in a task's activity. */
export function commentOnTask(taskId, text) { return attempt('Comment', (p) => addComment(p, taskId, text)); }

/** Stop a started task: log what was worked, and say what it still needs. */
export function stopTask(taskId, { worked, more }) {
  return attempt(more > 0 ? 'Stop the task' : 'Stop and complete', (p) => { stopWork(p, taskId, { worked, more }); autoAdvance(p); });
}

/**
 * A calendar event made into project work: a task of the event's length,
 * fixed at its hour, in the open plan. The meeting stays in its calendar; the
 * task is what makes its time count toward the project and toward the day.
 */
export function newTaskFromEvent({ name, day, start, minutes, notes = '' }) {
  let made = null;
  const ok = attempt('Add an event to the project', (p) => {
    const t = insertTask(p, p.tasks.length, { name, duration: 1, level: 1 });
    const who = p.resources.find((r) => r.type === 'work');
    if (who) assign(p, t.id, who.id, 1);
    setTaskField(p, t.id, 'work', String(Math.round((minutes / 60) * 100) / 100));
    setTaskField(p, t.id, 'start', day);
    setTaskField(p, t.id, 'calendarShow', true);
    if (notes) setTaskField(p, t.id, 'notes', notes);
    setPin(p, t.id, { day, start, minutes });
    // Set up as it was made: its history starts at "created", not with each setting.
    t.activity = (t.activity || []).slice(0, 1);
    made = t;
  });
  return ok ? made : null;
}

/**
 * A task from the new-task panel, in the open plan: everything the panel
 * asked, set in one step so Undo takes it all back. `fixed` holds it at an
 * hour; without it the calendar places it (auto-scheduled).
 */
export function createTask(spec) {
  let made = null;
  const ok = attempt('New task', (p) => {
    const t = insertTask(p, p.tasks.length, { name: spec.name, duration: 1, level: 1 });
    if (spec.resourceId && getResource(p, spec.resourceId)) assign(p, t.id, spec.resourceId, 1);
    setTaskField(p, t.id, 'work', String(Math.round((spec.minutes / 60) * 100) / 100));
    if (spec.startDay) setTaskField(p, t.id, 'start', spec.startDay);
    if (spec.deadline) setTaskField(p, t.id, 'deadline', spec.deadline);
    if (spec.urgency) setTaskField(p, t.id, 'urgency', spec.urgency);
    if (spec.notes) setTaskField(p, t.id, 'notes', spec.notes);
    setTaskField(p, t.id, 'calendarShow', true);
    if (spec.blockHours) setTaskField(p, t.id, 'blockHours', spec.blockHours);
    if (spec.timeBlockId) setTaskField(p, t.id, 'timeBlock', spec.timeBlockId);
    if (spec.stageId) setStage(p, t.id, spec.stageId);
    if (spec.phaseId && getPhase(p, spec.phaseId)) t.phaseId = spec.phaseId;
    if (spec.hardDeadline) setTaskField(p, t.id, 'hardDeadline', true);
    if (spec.labels?.length) setTaskField(p, t.id, 'labels', spec.labels);
    if (spec.whole) setTaskField(p, t.id, 'wholeBlock', true);
    for (const [fieldId, value] of Object.entries(spec.fields || {})) setFieldValue(p, t.id, fieldId, value);
    if (spec.fixed) setPin(p, t.id, spec.fixed);
    // Set up as it was made: its history starts at "created", not with each setting.
    t.activity = (t.activity || []).slice(0, 1);
    made = t;
  });
  return ok ? made : null;
}

/**
 * A task that already happened: made on time that has gone, it is work done
 * then — logged at that hour, drawn there ticked, and complete as of its end.
 */
export function newTaskDoneAt({ name, day, start, minutes, notes = '' }) {
  let made = null;
  const ok = attempt('Log a task that happened', (p) => {
    const t = insertTask(p, p.tasks.length, { name, duration: 1, level: 1 });
    const who = p.resources.find((r) => r.type === 'work');
    if (who) assign(p, t.id, who.id, 1);
    setTaskField(p, t.id, 'work', String(Math.round((minutes / 60) * 100) / 100));
    setTaskField(p, t.id, 'start', day);
    setTaskField(p, t.id, 'calendarShow', true);
    if (notes) setTaskField(p, t.id, 'notes', notes);
    addTimesheet(p, { taskId: t.id, resourceId: who?.id || null, date: day, start, hours: minutes / 60, note: 'Worked' });
    setTaskField(p, t.id, 'percent', 100);
    const end = start + minutes;
    t.doneAt = `${day}T${String(Math.floor(end / 60) % 24).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
    // Set up as it was made: its history starts at "created", not with each setting.
    t.activity = (t.activity || []).slice(0, 1);
    made = t;
  });
  return ok ? made : null;
}

/** A copy of a task, just below it: same hours, links and people, no progress and no pins. */
export function duplicateTask(taskId) {
  let copy = null;
  attempt('Duplicate the task', (p) => {
    const i = taskIndex(p, taskId);
    if (i < 0) throw new Error('No such task.');
    const t = p.tasks[i];
    const props = structuredClone(t);
    delete props.id;                      // a copy gets an id of its own
    const made = insertTask(p, i + 1, { ...props, level: t.level, name: `${t.name} (copy)` });
    made.percent = 0;
    made.calendar = { ...(t.calendar || {}), pins: [] };
    made.archived = false;
    copy = made;
  });
  if (copy) selectTask(copy.id);
  return copy;
}

/**
 * A new task at the end of a phase — after the last task already in it, at the
 * same outline level — so "+ Task" under a week in the list lands in that week.
 */
export function newTaskInPhase(phaseId) {
  let made = null;
  attempt('New task', (p) => {
    let at = p.tasks.length;
    let level = 1;
    if (phaseId) {
      const inIt = p.tasks.map((t, i) => ({ t, i })).filter(({ t }) => phaseOf(p, t.id) === phaseId);
      if (inIt.length) { const last = inIt[inIt.length - 1]; at = last.i + 1; level = last.t.level; }
    }
    made = insertTask(p, at, { name: 'New task', level });
    made.phaseId = phaseId || null;
  });
  if (made) selectTask(made.id);
  return made;
}

export function unpinBlock(taskId, index) { return attempt('Unpin a block', (p) => removePin(p, taskId, index)); }
export function unpinAll(taskId) { return attempt('Unpin every block', (p) => clearPins(p, taskId)); }

export function newPhase(name) { return commit('New stage', (p) => addPhase(p, name ? { name } : {})); }
export function editPhase(id, name) { return attempt('Rename the stage', (p) => setPhaseField(p, id, 'name', name)); }
export function setPhaseDeadline(id, iso) { return attempt('Stage deadline', (p) => setPhaseField(p, id, 'deadline', iso || null)); }
export function deletePhase(id) { return attempt('Delete the stage', (p) => removePhase(p, id)); }
export function movePhaseBy(id, dir) { return attempt('Reorder the stages', (p) => { if (!movePhase(p, id, dir)) throw new Error('It is already at the end.'); }); }
/** Put a task in a phase. Everything under it inherits, unless it says otherwise. */
/** Replace the plan's custom fields; values for a field taken out go with it. */
export function setCustomFields(list) {
  return attempt('Custom fields', (p) => {
    const next = list.map(cleanField).filter(Boolean);
    const ids = new Set(next.map((f) => f.id));
    for (const f of fieldsOf(p)) if (!ids.has(f.id)) removeField(p, f.id);
    p.fields = next;
    // A value for an option that is no longer offered means nothing now.
    for (const t of p.tasks) for (const f of next) if (t.fields && f.id in t.fields) setFieldValue(p, t.id, f.id, t.fields[f.id]);
  });
}
export function setTaskFieldValue(taskId, fieldId, value) {
  return attempt(`Edit ${getField(store.project, fieldId)?.name || 'field'}`, (p) => setFieldValue(p, taskId, fieldId, value));
}

export function setTaskPhase(taskId, phaseId) {
  return attempt('Stage', (p) => {
    const t = getTask(p, taskId);
    if (!t) throw new Error('No such task.');
    if (phaseId && !getPhase(p, phaseId)) throw new Error('No such stage.');
    t.phaseId = phaseId || null;
  });
}

export async function newTimeBlock(props = {}) {
  const { saveTimeBlock } = await import('./sync.js');
  const made = await saveTimeBlock({ name: 'New block', from: '09:00', to: '17:00', days: [1, 2, 3, 4, 5], ...props });
  if (!made) hint('Time blocks need the record store; this one could not be saved.');
  set({});
  return made;
}
export async function editTimeBlock(id, field, value) {
  const { listTimeBlocks, saveTimeBlock } = await import('./sync.js');
  const block = (await listTimeBlocks()).find((b) => b.id === id);
  if (!block) { hint('No such time block.'); return false; }
  const next = { ...block };
  if (field === 'name') next.name = String(value).trim() || block.name;
  else if (field === 'from' || field === 'to') next[field] = String(value).trim();
  else if (field === 'days') next.days = [...new Set((value || []).map(Number).filter((d) => d >= 0 && d <= 6))].sort();
  try {
    checkBlock(next);
  } catch (err) { hint(err.message); return false; }
  await saveTimeBlock(next);
  set({});
  return true;
}
export async function deleteTimeBlock(id) {
  const { removeTimeBlockEverywhere } = await import('./sync.js');
  const ok = await removeTimeBlockEverywhere(id);
  if (!ok) hint('There has to be one time block left.');
  set({});
  return ok;
}

/** The same rules the model applied, now that the blocks live outside a plan. */
function checkBlock(b) {
  const { parseTime } = agendaModule;
  if (parseTime(b.from) === null || parseTime(b.to) === null) throw new Error('A time of day looks like 09:00.');
  if (parseTime(b.to) <= parseTime(b.from)) throw new Error('A time block has to end after it starts.');
  if (!Array.isArray(b.days) || !b.days.length) throw new Error('A time block needs at least one day.');
}
export function setTaskTimeBlock(taskId, blockId) { return editTask(taskId, 'timeBlock', blockId); }

// ---------------------------------------------------------------- calendar

/** Put every unfinished leaf task on the calendar, for a plan starting out. */
export function showAllInCalendar() {
  return attempt('Show in calendar', (p) => {
    p.tasks.forEach((t, i) => {
      if (isSummaryAt(p, i) || t.milestone || (t.percent ?? 0) === 100) return;
      t.calendar = { ...t.calendar, show: true };
    });
  });
}

/** Cut a task into parts. Asks how many, then names them after it. */
export async function breakUpDialog(taskId) {
  const t = getTask(store.project, taskId);
  if (!t) return;
  const { formDialog, showText } = await import('../ui/dialog.js');
  const answer = await formDialog('Break into subtasks', [
    { key: 'parts', label: 'How many parts', type: 'text', value: '3', hint: `“${t.name}” is ${t.duration} days; the parts divide that between them and run one after another.` },
    { key: 'names', label: 'Names (one per line, optional)', type: 'textarea', rows: 4, value: '' },
  ], 'Break up');
  if (!answer) return;
  const parts = parseInt(answer.parts, 10);
  if (!Number.isFinite(parts) || parts < 2) { hint('Two parts or more.'); return; }
  const names = String(answer.names || '').split('\n').map((x) => x.trim()).filter(Boolean);
  const made = tryCommit('Break into subtasks', (p) => breakIntoSubtasks(p, taskId, parts, names));
  if (made) { set({ selection: [made[0].id] }); revealTask(made[0].id); }
  else showText('That task could not be broken up', store.ui.hint || 'Unknown reason.');
}

// ---------------------------------------------------------------- timesheets

export function logTime({ taskId, resourceId, date, hours, note }) {
  return attempt('Log time', (p) => addTimesheet(p, { taskId, resourceId, date, hours, note }));
}
export function editTimeLine(id, field, value) { return attempt('Edit timesheet', (p) => setTimesheetField(p, id, field, value)); }
export function deleteTimeLine(id) { return attempt('Delete timesheet line', (p) => removeTimesheet(p, id)); }

// ---------------------------------------------------------------- stages

export function setTaskStage(taskId, stageId) { return attempt('Move task', (p) => { setStage(p, taskId, stageId); autoAdvance(p); }); }
export function newStageColumn(name) { return commit('New status', (p) => addStage(p, name)); }
export function renameStageColumn(id, name) { return attempt('Rename status', (p) => renameStage(p, id, name)); }
export function deleteStageColumn(id) { return attempt('Delete status', (p) => removeStage(p, id)); }
export function moveStageColumn(id, dir) { return attempt('Move status', (p) => { if (!moveStage(p, id, dir)) throw new Error('There is no column that way.'); }); }
export function setStageIsDone(id, done) { return attempt('Status means finished', (p) => setStageDone(p, id, done)); }

// ---------------------------------------------------------------- project

export function setProjectInfo(patch) {
  tryCommit('Project information', (p) => {
    if (patch.name !== undefined) p.name = String(patch.name).trim() || 'Untitled project';
    if (patch.start !== undefined) p.start = patch.start;
    if (patch.statusDate !== undefined) p.statusDate = patch.statusDate || null;
    if (patch.currency !== undefined) p.currency = patch.currency || '$';
    if (patch.colour !== undefined) p.colour = patch.colour === null ? null : ((Math.round(+patch.colour) % 360) + 360) % 360;
  });
}
export function setAgenda(patch) {
  return attempt('Working hours', (p) => {
    const next = { blockHours: 1, ...(p.agenda || {}), ...patch };
    const { BLOCK_CHOICES, GAP_CHOICES, LOAD_CHOICES, CAP_CHOICES, DEFAULT_AGENDA } = agendaModule;
    if (!BLOCK_CHOICES.includes(+next.blockHours)) throw new Error(`A block is one of ${BLOCK_CHOICES.join(', ')} hours.`);
    const gap = +(next.gapMinutes ?? 0);
    if (!GAP_CHOICES.includes(gap)) throw new Error(`A gap is one of ${GAP_CHOICES.join(', ')} minutes.`);
    const load = +(next.assumedLoad ?? DEFAULT_AGENDA.assumedLoad);
    if (!LOAD_CHOICES.includes(load)) throw new Error(`An assumed load is one of ${LOAD_CHOICES.join(', ')} per cent.`);
    const cap = +(next.dailyCap ?? DEFAULT_AGENDA.dailyCap);
    if (!CAP_CHOICES.includes(cap)) throw new Error(`A day's limit is one of ${CAP_CHOICES.join(', ')} hours.`);
    p.agenda = { blockHours: +next.blockHours, timeBlockId: next.timeBlockId || null, gapMinutes: gap, assumedLoad: load, dailyCap: cap };
  });
}

export function setCalendar(cal) {
  tryCommit('Working time', (p) => { p.calendar = { ...p.calendar, ...cal }; });
}
export { emit };
