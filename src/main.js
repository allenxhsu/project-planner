// Wires the store to the panels and owns the global keyboard shortcuts.

import { el, clear } from './util.js';
import { store, subscribe, set, undo, redo, loadProject, markSaved, readAutosave } from './state/store.js';
import * as act from './state/actions.js';
import { sampleProject } from './model/sample.js';
import { parse, serialize } from './io/json.js';
import { hosted, post, initHost } from './host.js';
import { saveOpenDialog } from './ui/dialog.js';
import { isHidden, setModeChoice } from './state/mode.js';
import { initSidebar, renderSidebar } from './ui/sidebar.js';
import { renderGantt, scrollToToday } from './ui/gantt.js';
import { renderTaskSheet, editActiveCell, moveActiveCol } from './ui/taskgrid.js';
import { renderResourceSheet, renderResourceUsage } from './ui/resources.js';
import { renderNetwork } from './ui/network.js';
import { renderProjects, reloadPlans } from './ui/projects.js';
import { renderPeople } from './ui/people.js';
import { renderSchedules } from './ui/schedules.js';
import { renderSettings } from './ui/settingspage.js';
import { renderDoc } from './ui/docs.js';
import { renderToday } from './ui/today.js';
import { renderKanban } from './ui/kanban.js';
import { renderAllTasks, renderProjectTabs } from './ui/alltasks.js';
import { renderTeamSchedule } from './ui/teamschedule.js';
import { renderCalendar, renderCalendarSide } from './ui/calendar.js';
import { renderRunning } from './ui/running.js';
import { renderPriority } from './ui/priority.js';
import { renderBottom, checkBadge } from './ui/bottom.js';
import { initHeader, renderHeader, renderToolbar, renderStatus, saveProject, saveProjectAs, openFile, loadText, COMMANDS, newMenu, findResults } from './ui/toolbar.js';
import { modalOpen } from './ui/dialog.js';
import { initSync, syncAfterSave, adoptRemoteSettings, readStoredAutosave, storeCounts, keepsEdits, APP_ID } from './state/sync.js';
import { SYNC_EVENTS } from '../sync-kit/js/events.js';
import { portalApp } from '../sync-kit/js/portal.js';

const $ = (id) => document.getElementById(id);

function tabs(root, key, items) {
  clear(root);
  for (const [id, label, badge] of items) {
    root.append(el('button', { class: `sc-tab${store.ui[key] === id ? ' is-active' : ''}`, onclick: () => set({ [key]: id }) }, label,
      badge ? el('span', { class: `sc-badge${badge.alert ? ' sc-badge--alert' : ''}`, title: badge.title, text: badge.text }) : null));
  }
}

const VIEW_RENDERERS = { today: renderToday, projects: renderProjects, people: renderPeople, gantt: renderGantt, kanban: renderKanban, alltasks: renderAllTasks, list: (root) => renderAllTasks(root, { scope: 'project' }), settings: renderSettings, doc: renderDoc, team: renderTeamSchedule, calendar: renderCalendar, running: renderRunning, priority: renderPriority, sheet: renderTaskSheet, resources: renderResourceSheet, usage: renderResourceUsage, network: renderNetwork, schedules: renderSchedules };

/** What a home project's page is, in work mode: a cover, with the ways out. */
function renderCovered(root) {
  clear(root);
  root.append(el('div', { class: 'mode-cover' },
    el('div', { class: 'mode-cover-icon', text: '🏠' }),
    el('h2', { text: 'A home project' }),
    el('p', { class: 'sc-muted', text: 'Work mode keeps home projects out of sight. Switch to home mode to see it, or go to a work project.' }),
    el('div', { class: 'mode-cover-actions' },
      el('button', { class: 'sc-button sc-button--sm', text: '🏠 Switch to home mode', onclick: () => setModeChoice('home') }),
      el('button', { class: 'sc-button sc-button--primary sc-button--sm', text: 'Projects & Tasks', onclick: () => set({ view: 'alltasks' }) }))));
}

function render() {
  const { ui } = store;
  renderHeader();
  renderSidebar();
  renderToolbar($('toolbar'));
  // The right-hand panel is the calendar's (mini month and calendars) and
  // nothing else's: a task's and a project's details open in their windows.
  $('app').classList.toggle('no-right', !ui.rightOpen || ui.view !== 'calendar');
  $('app').classList.toggle('no-bottom', !ui.bottomOpen);
  // A Microsoft Project view is a view of the open project: its tabs sit above it.
  const mspView = ['gantt', 'sheet', 'kanban', 'network', 'resources', 'usage', 'priority'].includes(ui.view);
  // At work, a home project's own pages are covered rather than shown (state/mode.js).
  const covered = (mspView || ['list', 'doc'].includes(ui.view)) && isHidden(store.project.workspaceId);
  $('app').classList.toggle('has-project-tabs', mspView && !covered);
  if (mspView && !covered) renderProjectTabs($('view-tabs'));
  if (covered) renderCovered($('stage'));
  else VIEW_RENDERERS[ui.view]($('stage'));
  renderStatus($('statusbar'));
  tabs($('bottom-tabs'), 'bottomTab', [['checks', 'Checks', checkBadge()], ['stats', 'Statistics']]);
  if (ui.bottomOpen) renderBottom($('bottom-body'));
  // On the calendar the right-hand panel is the month and the calendars, as
  // in Motion; everywhere else it is the details of what is selected.
  const calSide = ui.view === 'calendar';
  $('app').classList.toggle('view-calendar', calSide);
  for (const v of ['team', 'today', 'alltasks', 'list', 'settings', 'doc']) $('app').classList.toggle(`view-${v}`, ui.view === v);
  // One place for each thing: the task's and the project's own windows hold
  // what they are; this panel holds how they are scheduled. The resource tab
  // is only where resources are the subject.
  if (ui.rightOpen && calSide) renderCalendarSide($('inspector'));
}

function onKey(e) {
  if (modalOpen()) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  const { ui } = store;
  const taskView = ['gantt', 'sheet'].includes(ui.view);
  if (mod && k === 's') { e.preventDefault(); if (e.shiftKey) saveProjectAs(); else saveProject(); return; }
  if (mod && k === 'o') { e.preventDefault(); openFile(); return; }
  if (typing) return;
  if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 'a') { e.preventDefault(); act.selectAll(); return; }
  if (mod && k === 'f') { e.preventDefault(); $('find').focus(); return; }
  if (mod && k === 'l') { e.preventDefault(); if (e.shiftKey) act.unlinkSelection(); else act.linkSelection(); return; }
  if (mod && k === 'i') { e.preventDefault(); COMMANDS['task.info'](); return; }
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); COMMANDS['view.zoomIn'](); return; }
  if (mod && k === '-') { e.preventDefault(); COMMANDS['view.zoomOut'](); return; }
  if (mod && k === '0') { e.preventDefault(); scrollToToday(); return; }
  if (mod) return;
  if (e.key === 'Escape') { set({ editing: null, hint: '' }); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); COMMANDS['edit.delete'](); return; }
  if (e.key === 'Insert') { e.preventDefault(); act.newTaskBelow(); return; }
  if (e.altKey && e.shiftKey && taskView) {
    const map = { ArrowRight: act.indentSelection, ArrowLeft: act.outdentSelection, ArrowUp: () => act.moveSelection(-1), ArrowDown: () => act.moveSelection(1) };
    if (map[e.key]) { e.preventDefault(); map[e.key](); return; }
  }
  if (taskView) {
    if (e.key === 'ArrowDown') { e.preventDefault(); act.moveCursor(1, { extend: e.shiftKey }); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); act.moveCursor(-1, { extend: e.shiftKey }); return; }
    if (e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); moveActiveCol(1); return; }
    if (e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey)) { e.preventDefault(); moveActiveCol(-1); return; }
    if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); if (!editActiveCell()) act.newTaskBelow(); return; }
    if (e.key === ' ') { const t = act.activeTask(); if (t && store.schedule.tasks[t.id].summary) { e.preventDefault(); act.toggleCollapse(t.id); } return; }
    if (e.key.length === 1 && !e.altKey) { if (editActiveCell(e.key)) e.preventDefault(); }
  }
}

// The macOS app keeps the document: tell it about every plan change, and let
// its menu bar run the same commands the web menu bar does.
function initHosting() {
  initHost({
    name: 'project',
    load: (text, name) => loadText(text, name),
    // ⌘S is the menu bar's on the Mac; with a dialog open that saves, it is the dialog's.
    command: (id) => { if (id === 'file.save' && saveOpenDialog()) return; COMMANDS[id]?.(); },
    saved: (name) => { markSaved(name); syncAfterSave(); },
    // The Mac app can pair with the toolkit Portal and keep the device token in
    // the Keychain; when it does, it hands the page the same two values the Sync
    // dialog holds. Two empty strings mean signed out, which is clearing them.
    remote: ({ url, token }) => { void adoptRemoteSettings({ url, token }); },
  });
  if (!hosted) return;
  let lastRev = -1, lastDirty = null;
  subscribe(() => {
    if (store._rev === lastRev && store.ui.dirty === lastDirty) return;
    lastRev = store._rev; lastDirty = store.ui.dirty;
    // The Mac app marks the window edited — and asks to save on close — for a
    // change reported dirty. Once the store is open every edit is kept there
    // within a second, so there is nothing to ask about; only a plan the store
    // cannot keep is reported unsaved.
    post({ type: 'changed', json: serialize(store.project), dirty: store.ui.dirty && !keepsEdits(), name: store.project.name });
  });
}

initHeader($('header'));
initSidebar($('sidebar'), {
  newMenu, findResults,
  settings: () => { void import('./ui/settingspage.js').then((m) => m.openSettings()); },
});
// The right panel's left edge drags to resize it, between a minimum and a
// maximum width, kept on this device; a double-click puts it back.
(() => {
  const KEY = 'project-planner:right-width';
  const MIN = 240;
  const MAX = 480;
  const app = $('app');
  const apply = (w) => (w ? app.style.setProperty('--right-w', `${w}px`) : app.style.removeProperty('--right-w'));
  let width = null;
  try { width = +localStorage.getItem(KEY) || null; } catch { width = null; }
  apply(width);
  const handle = document.createElement('div');
  handle.className = 'right-resize';
  handle.title = 'Drag to resize · double-click to reset';
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('is-on');
    document.body.classList.add('is-resizing');
    const right = $('right').getBoundingClientRect().right;
    const move = (ev) => { width = Math.round(Math.max(MIN, Math.min(MAX, right - ev.clientX))); apply(width); };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.classList.remove('is-on');
      document.body.classList.remove('is-resizing');
      try { localStorage.setItem(KEY, String(width || '')); } catch { /* private mode */ }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });
  handle.addEventListener('dblclick', () => { width = null; apply(null); try { localStorage.removeItem(KEY); } catch { /* private mode */ } });
  $('right').append(handle);
})();
subscribe(render);
document.addEventListener('keydown', onKey);
initHosting();
// The status line carries the sync indicator, so a status event redraws it.
window.addEventListener(SYNC_EVENTS.status, () => renderStatus($('statusbar')));

let startedOnFallback = false;
if (!hosted) {
  // Whatever localStorage still holds gets the first plan on screen without a
  // wait; the store's own copy, which is the newer one once the move has
  // happened, replaces it as soon as the database is open.
  const saved = readAutosave();
  // Nothing in localStorage is the usual case once the autosave has moved to
  // the database: the sample goes up for now, and is replaced by the stored
  // plan the moment the database is open (below).
  startedOnFallback = !saved;
  if (saved) {
    try { loadProject(parse(JSON.stringify(saved)).project); } catch { loadProject(sampleProject()); }
  } else loadProject(sampleProject());
} else render();

// After the first plan is on screen: the record store, the engine and the timer.
/**
 * #plan=…&task=… — what Copy link on a calendar block hands out. Opening it
 * opens that plan and lands on that task, in whichever copy of the app
 * follows the link.
 */
async function followLink() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  // #view=… — a saved view of Projects & Tasks or of a project (Copy link on a view).
  if (h.get('view')) { const { openViewLink } = await import('./ui/alltasks.js'); await openViewLink(h.get('view')); return; }
  const planId = h.get('plan');
  const taskId = h.get('task');
  if (!planId) return;
  const { openPlan } = await import('./state/sync.js');
  if (planId !== store.project.id && !(await openPlan(planId))) return;
  if (taskId && store.project.tasks.some((t) => t.id === taskId)) {
    set({ view: 'gantt' });
    act.revealTask(taskId); act.selectTask(taskId);
    void import('./ui/blockmenu.js').then((m) => m.taskSheet({ taskId }));
  }
}
window.addEventListener('hashchange', () => { void followLink(); });

// On the Portal the page carries the Portal's bar: the app switcher, the
// account, and Sign in when the session is gone.
function mountPortalBar() {
  if (portalApp() !== APP_ID) return;
  document.getElementById('app').prepend(el('sc-portal-bar', { app: APP_ID }));
}
mountPortalBar();

initSync({ preferStored: !hosted && startedOnFallback })
  .then(async () => {
    if (!hosted && !store.ui.dirty && !startedOnFallback && store.project.tasks.length === 0) {
      // An empty plan came out of localStorage: if the store holds another
      // plan, that is the one to show. (A start on the sample is restored
      // inside initSync, before anything can edit the sample.)
      const stored = await readStoredAutosave();
      if (stored && stored.id !== store.project.id) {
        try { loadProject(parse(JSON.stringify(stored)).project); } catch { /* keep what is on screen */ }
      }
    }
    void storeCounts();
    void followLink();
    // Home or work: which workspaces show, dim or hide depends on where this is.
    const { listWorkspaces, workspaceNow } = await import('./state/sync.js');
    await listWorkspaces();
    const mode = await import('./state/mode.js');
    mode.useWorkspaces(workspaceNow);
    mode.watchMode();
    window.addEventListener('planner-mode', () => { void import('./ui/resources.js').then((m) => m.reloadUsage?.()); });
    return reloadPlans();
  })
  .catch((err) => console.error('sync could not start', err));
