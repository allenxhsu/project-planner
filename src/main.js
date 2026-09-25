// Wires the store to the panels and owns the global keyboard shortcuts.

import { el, clear } from './util.js';
import { store, subscribe, set, undo, redo, loadProject, markSaved, readAutosave, revision } from './state/store.js';
import * as act from './state/actions.js';
import { sampleProject } from './model/sample.js';
import { parse, serialize } from './io/json.js';
import { hosted, post, initHost } from './host.js';
import { renderGantt, zoomGantt, scrollToToday } from './ui/gantt.js';
import { renderTaskSheet, editActiveCell, moveActiveCol } from './ui/taskgrid.js';
import { renderResourceSheet, renderResourceUsage } from './ui/resources.js';
import { renderNetwork, zoomNetwork } from './ui/network.js';
import { renderProjects, reloadPlans } from './ui/projects.js';
import { renderPeople } from './ui/people.js';
import { renderKanban } from './ui/kanban.js';
import { renderAllTasks, reloadAllTasks } from './ui/alltasks.js';
import { renderCalendar, shiftWeek, showThisWeek } from './ui/calendar.js';
import { renderPriority } from './ui/priority.js';
import { renderInspector } from './ui/inspector.js';
import { renderBottom, checkBadge } from './ui/bottom.js';
import { initHeader, renderHeader, refreshWorkspaceLabel, renderViewTabs, renderToolbar, renderStatus, saveProject, saveProjectAs, openFile, loadText, COMMANDS } from './ui/toolbar.js';
import { modalOpen } from './ui/dialog.js';
import { initSync, syncAfterSave, adoptRemoteSettings } from './state/sync.js';
import { SYNC_EVENTS } from '../sync-kit/js/events.js';

const $ = (id) => document.getElementById(id);

function tabs(root, key, items) {
  clear(root);
  for (const [id, label, badge] of items) {
    root.append(el('button', { class: `sc-tab${store.ui[key] === id ? ' is-active' : ''}`, onclick: () => set({ [key]: id }) }, label,
      badge ? el('span', { class: `sc-badge${badge.alert ? ' sc-badge--alert' : ''}`, title: badge.title, text: badge.text }) : null));
  }
}

const VIEW_RENDERERS = { projects: renderProjects, people: renderPeople, gantt: renderGantt, kanban: renderKanban, alltasks: renderAllTasks, calendar: renderCalendar, priority: renderPriority, sheet: renderTaskSheet, resources: renderResourceSheet, usage: renderResourceUsage, network: renderNetwork };

function render() {
  const { ui } = store;
  renderHeader();
  renderViewTabs($('view-tabs'));
  renderToolbar($('toolbar'));
  $('app').classList.toggle('no-right', !ui.rightOpen);
  $('app').classList.toggle('no-bottom', !ui.bottomOpen);
  VIEW_RENDERERS[ui.view]($('stage'));
  renderStatus($('statusbar'));
  tabs($('bottom-tabs'), 'bottomTab', [['checks', 'Checks', checkBadge()], ['stats', 'Statistics']]);
  if (ui.bottomOpen) renderBottom($('bottom-body'));
  tabs($('right-tabs'), 'rightTab', [['task', 'Task'], ['resource', 'Resource'], ['project', 'Project']]);
  if (ui.rightOpen) renderInspector($('inspector'));
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
    command: (id) => { COMMANDS[id]?.(); },
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
    post({ type: 'changed', json: serialize(store.project), dirty: store.ui.dirty, name: store.project.name });
  });
}

initHeader($('header'));
subscribe(render);
document.addEventListener('keydown', onKey);
initHosting();
// The status line carries the sync indicator, so a status event redraws it.
window.addEventListener(SYNC_EVENTS.status, () => renderStatus($('statusbar')));

if (!hosted) {
  const saved = readAutosave();
  if (saved) {
    try { loadProject(parse(JSON.stringify(saved)).project); } catch { loadProject(sampleProject()); }
  } else loadProject(sampleProject());
} else render();

// After the first plan is on screen: the record store, the engine and the timer.
initSync().then(() => Promise.all([reloadPlans(), refreshWorkspaceLabel()])).catch((err) => console.error('sync could not start', err));
