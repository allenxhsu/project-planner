// Header (brand, menus, find, undo/redo), view tabs, the action toolbar and the status line.

import { el, clear, downloadText, downloadBlob, slugify } from '../util.js';
import { store, set, undo, redo, canUndo, canRedo, loadProject, markSaved, VIEWS } from '../state/store.js';
import * as act from '../state/actions.js';
import { createProject } from '../model/model.js';
import { sampleProject } from '../model/sample.js';
import { serialize, parse, FILE_EXT } from '../io/json.js';
import { exportMspdi, importMspdi } from '../io/mspdi.js';
import { exportCsv, importCsv } from '../io/csv.js';
import { exportSvg, exportPng, exportPdf } from '../io/exportImage.js';
import { showMenu, confirmDialog, showText } from './dialog.js';
import { settingsDialog } from './settings.js';
import { reloadPlans } from './projects.js';
import { reloadPeople } from './people.js';
import { GROUPINGS } from './kanban.js';
import { reloadAllTasks } from './alltasks.js';
import { shiftWeek, showThisWeek, reloadCalendarPlans } from './calendar.js';
import { syncAfterSave, syncConfigured, syncStatus, saveToCloud, getSettings } from '../state/sync.js';
import { zoomGantt, scrollToToday, ZOOMS } from './gantt.js';
import { zoomNetwork } from './network.js';
import { RULES } from '../model/validate.js';
import { formatDate } from '../model/calendar.js';
import { hosted, post } from '../host.js';

// ---------------------------------------------------------------- file commands

async function guardDirty() {
  return !store.ui.dirty || confirmDialog('Discard unsaved changes?', 'The open plan has changes that were not saved to a file.', 'Discard');
}

// Hosted, documents belong to the macOS app: new, open and save are its to do.
export async function newProject() {
  if (hosted) { post({ type: 'new' }); return; }
  if (await guardDirty()) loadProject(createProject());
}
export async function openSample() { if (await guardDirty()) loadProject(sampleProject()); }

/**
 * `File ▸ Save` — to the cloud. A plan's home is the server it syncs with, so
 * this is the one that runs on ⌘S; with no server set up yet it says so and
 * opens the Sync settings rather than quietly writing a file instead.
 */
export async function saveProject() {
  const result = await saveToCloud();
  if (result.ok) { act.hint(`Saved to ${new URL(getSettings().url).host}.`); return; }
  if (result.reason === 'failed') { act.hint(`Could not save to the cloud: ${result.error || 'the server did not answer'}.`); return; }
  const set_up = await confirmDialog('No cloud to save to yet',
    'Save keeps this plan on a sync server, so it is on every device you use. Set one up now? (Save As… writes a file to this computer instead.)',
    'Set up sync');
  if (set_up) settingsDialog();
}

/** `File ▸ Save As…` — a copy on this computer, the file the format describes. */
export function saveProjectAs() {
  if (hosted) { post({ type: 'save' }); return; }
  const name = store.ui.fileName || `${slugify(store.project.name)}${FILE_EXT}`;
  downloadText(serialize(store.project), name, 'application/json');
  markSaved(name);
  syncAfterSave();
}

/** File name extensions the MPXJ converter reads (Microsoft Project and its neighbours). */
export const CONVERTER_EXTS = ['mpp', 'mpt', 'mpx', 'xer', 'pmxml', 'pod', 'gan', 'planner', 'pp', 'prx', 'sp', 'ppx', 'cdpx', 'cdpz', 'mdb', 'p3', 'stx', 'fts', 'pc', 'zip', 'pep', 'schedule_grid', 'gnt'];
const needsConverter = (name) => CONVERTER_EXTS.includes((name || '').toLowerCase().split('.').pop());
export const CONVERTER_EXPORTS = { mpx: 'Microsoft Project MPX', xer: 'Primavera P6 XER', pmxml: 'Primavera P6 PMXML', planner: 'GNOME Planner' };

/** Run a file through MPXJ (tools/mpp2xml.sh) and get the result's bytes. */
async function convertViaServer(bytes, name, to) {
  let res;
  try { res = await fetch(`/api/convert?name=${encodeURIComponent(name)}&to=${to}`, { method: 'POST', body: bytes }); }
  catch { throw new Error('The converter needs the app to be served by ./serve.sh (it runs MPXJ for the browser).'); }
  if (!res.ok) {
    let msg = `The converter answered ${res.status}.`;
    try { const j = await res.json(); msg = j.detail ? `${j.error}\n\n${j.detail}` : j.error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return res.arrayBuffer();
}

/** Open a Microsoft Project (or other MPXJ-readable) file: convert it to Project XML, then import. */
export async function loadProjectFile(file) {
  try {
    const xml = new TextDecoder().decode(await convertViaServer(await file.arrayBuffer(), file.name, 'xml'));
    return loadText(xml, file.name.replace(/\.[^.]+$/, '.xml'));
  } catch (err) {
    showText('The file could not be opened', err.message);
    return false;
  }
}

/** Export through the converter: our Project XML → MPX, XER, PMXML or Planner. */
async function exportVia(ext) {
  const xml = exportMspdi(store.project, store.schedule);
  const name = `${slugify(store.project.name)}.${ext}`;
  if (hosted) { post({ type: 'convertExport', name, xml }); return; }
  const bytes = await convertViaServer(new Blob([xml], { type: 'application/xml' }), 'plan.xml', ext);
  downloadBlob(new Blob([bytes]), name);
}

/** Put a file's text into this window: a native plan, MS Project XML, or CSV. */
export function loadText(text, fileName) {
  try {
    const lower = (fileName || '').toLowerCase();
    if (lower.endsWith('.xml') || text.trimStart().startsWith('<')) {
      const { project, report } = importMspdi(text);
      loadProject(project, null);
      showText('Microsoft Project XML imported', [`${report.tasks} tasks, ${report.resources} resources, ${report.links} links.`, '', report.skipped.length ? `Left out or changed:\n${report.skipped.map((s) => `  ${s}`).join('\n')}` : 'Nothing was left out.'].join('\n'));
    } else if (lower.endsWith('.csv') || (!text.trimStart().startsWith('{') && text.includes(','))) {
      const { project, skipped } = importCsv(text, (fileName || 'Imported plan').replace(/\.csv$/i, ''));
      loadProject(project, null);
      if (skipped.length) showText('Some links could not be read', skipped.join('\n'));
    } else {
      const { project, repairs } = parse(text);
      loadProject(project, fileName);
      if (repairs.length) showText('The file was repaired while loading', repairs.join('\n'));
    }
    return true;
  } catch (err) {
    showText('The file could not be opened', err.message);
    return false;
  }
}

export async function openFile() {
  if (hosted) { post({ type: 'open' }); return; }
  if (!(await guardDirty())) return;
  const input = document.getElementById('file-input');
  input.value = '';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    if (needsConverter(file.name)) loadProjectFile(file); else loadText(await file.text(), file.name);
  };
  input.click();
}

const exportXml = () => downloadText(exportMspdi(store.project, store.schedule), `${slugify(store.project.name)}.xml`, 'application/xml');
const exportCsvFile = () => downloadText(exportCsv(store.project, store.schedule), `${slugify(store.project.name)}-tasks.csv`, 'text/csv');
const guarded = (fn) => () => Promise.resolve().then(fn).catch((err) => showText('Export failed', err.message));

function appearance() {
  showMenu(window.innerWidth - 340, 56, [{ note: 'Appearance is shared with the other toolkit apps.' }]);
  document.querySelector('.pop-menu').append(el('sc-theme-picker'));
}

function help() {
  showText('Working with the planner', [
    'TASKS',
    'Click a cell twice (or press Enter / F2, or just start typing) to edit it. Tab moves along the row,',
    'Enter moves down. Insert adds a task below; Delete removes the selection. ⌥⇧→ and ⌥⇧← indent',
    'and outdent (an indented task makes the one above it a summary); ⌥⇧↑ ⌥⇧↓ move a task.',
    '',
    'LINKS',
    'Type predecessors as row numbers: 3, 3FS+2d, 5SS-1d, 7FF. Or select tasks and press ⌘L to link',
    'them in order; ⇧⌘L unlinks. In the chart, drag from the dot at the end of a bar onto another bar.',
    'Right-click an arrow to remove it.',
    '',
    'THE CHART',
    'Drag a bar to move it (this pins it with a Start No Earlier Than constraint); drag its right edge to',
    'change the duration. ⌘ + scroll or the toolbar zooms between days, weeks and months.',
    'Red bars are on the critical path; the dashed line is today; ▽ marks a deadline.',
    '',
    'MICROSOFT PROJECT FILES',
    'Open reads .mpp / .mpt (every Project version), .mpx, Project XML, Primavera XER and PMXML,',
    'GanttProject, ProjectLibre and Planner files. Nothing outside Microsoft Project can write .mpp,',
    'so “Save for Microsoft Project” writes Project XML: open it in Project (File ▸ Open) and Project',
    'saves it as .mpp. Older tools take the MPX export instead.',
    '',
    'DATES',
    'Typing a Start date pins the task. Typing a Finish date changes its duration. Summary tasks take',
    'their dates from their subtasks. Working days, hours and holidays are under Project ▸ Information.',
    '',
    'KEYS',
    '⌘Z / ⇧⌘Z undo, redo · ⌘S save · ⌘O open · ⌘A select all · ⌘I task details · ⌘F find · ⌘L link',
    '',
    'CHECKS',
    ...Object.entries(RULES).map(([code, [level, text]]) => `${code.padEnd(18)}${level.padEnd(9)}${text}`),
  ].join('\n'));
}

const goView = (view) => () => { set({ view, editing: null }); if (view === 'projects') void reloadPlans(); if (view === 'alltasks') void reloadAllTasks(); if (view === 'calendar') void reloadCalendarPlans(); if (view === 'people') void reloadPeople(); };
const zoomIn = () => (store.ui.view === 'network' ? zoomNetwork(1) : zoomGantt(1));
const zoomOut = () => (store.ui.view === 'network' ? zoomNetwork(-1) : zoomGantt(-1));

/** Every menu command by id. The web menu bar and the macOS menu bar both run these. */
export const COMMANDS = {
  'file.new': newProject, 'file.open': openFile, 'file.sample': openSample, 'file.save': saveProject, 'file.saveAs': saveProjectAs,
  'file.exportXml': guarded(exportXml), 'file.exportCsv': guarded(exportCsvFile),
  'file.exportMpx': guarded(() => exportVia('mpx')), 'file.exportXer': guarded(() => exportVia('xer')), 'file.exportPmxml': guarded(() => exportVia('pmxml')), 'file.exportPlanner': guarded(() => exportVia('planner')),
  'edit.undo': undo, 'edit.redo': redo, 'edit.selectAll': act.selectAll, 'edit.delete': () => (['resources', 'usage'].includes(store.ui.view) ? act.deleteResource() : act.deleteSelection()),
  'task.new': act.newTaskBelow, 'task.newAbove': act.newTaskAbove, 'task.milestone': act.newMilestone, 'task.toggleMilestone': act.toggleMilestone,
  'task.indent': act.indentSelection, 'task.outdent': act.outdentSelection, 'task.up': () => act.moveSelection(-1), 'task.down': () => act.moveSelection(1),
  'task.link': act.linkSelection, 'task.unlink': act.unlinkSelection, 'task.info': () => set({ rightOpen: true, rightTab: 'task' }),
  'task.complete': () => { const id = act.activeId(); if (id) act.setPercent(id, 100); },
  'resource.new': act.newResource, 'resource.delete': () => act.deleteResource(), 'resource.info': () => set({ rightOpen: true, rightTab: 'resource' }),
  'view.projects': goView('projects'), 'view.kanban': goView('kanban'), 'view.alltasks': goView('alltasks'),
  'view.calendar': goView('calendar'), 'view.priority': goView('priority'),
  'view.weekBack': () => shiftWeek(-1), 'view.weekOn': () => shiftWeek(1), 'view.thisWeek': showThisWeek,
  'task.breakUp': () => { const id = act.activeId(); if (id) void act.breakUpDialog(id); },
  'task.calendar': () => { const id = act.activeId(); if (!id) return; const t = store.project.tasks.find((x) => x.id === id); act.editTask(id, 'calendarShow', !(t?.calendar?.show)); },
  'view.refreshPlans': () => { void reloadPlans({ pull: true }); },
  'view.people': goView('people'), 'view.gantt': goView('gantt'), 'view.sheet': goView('sheet'), 'view.resources': goView('resources'), 'view.usage': goView('usage'), 'view.network': goView('network'),
  'view.zoomIn': zoomIn, 'view.zoomOut': zoomOut, 'view.today': scrollToToday,
  'view.expandAll': () => act.collapseAll(false), 'view.collapseAll': () => act.collapseAll(true),
  'view.inspector': () => set({ rightOpen: !store.ui.rightOpen }), 'view.checks': () => set({ bottomOpen: !store.ui.bottomOpen }),
  'view.appearance': appearance, 'view.sync': settingsDialog,
  'project.info': () => set({ rightOpen: true, rightTab: 'project' }), 'project.stats': () => set({ bottomOpen: true, bottomTab: 'stats' }),
  'export.svg': guarded(exportSvg), 'export.png': guarded(exportPng), 'export.pdf': guarded(exportPdf),
  'help.guide': help,
};
const run = (id) => COMMANDS[id];

const MENUS = {
  File: () => [
    { label: 'New plan', run: run('file.new') }, { label: 'Open…', key: '⌘O', run: run('file.open') }, { label: 'Open the sample plan', run: run('file.sample') }, '-',
    { label: 'Save to the cloud', key: '⌘S', run: run('file.save') },
    { label: 'Save As… (a file on this computer)', key: '⇧⌘S', run: run('file.saveAs') }, '-',
    { label: 'Open Microsoft Project file (.mpp, .mpx, XML)…', run: run('file.open') },
    { label: 'Save for Microsoft Project (XML)', run: run('file.exportXml') }, '-',
    { label: 'Export Microsoft Project MPX', run: run('file.exportMpx') },
    { label: 'Export Primavera XER', run: run('file.exportXer') },
    { label: 'Export Primavera PMXML', run: run('file.exportPmxml') },
    { label: 'Export GNOME Planner', run: run('file.exportPlanner') },
    { label: 'Export task list as CSV', run: run('file.exportCsv') },
  ],
  Edit: () => [
    { label: `Undo${canUndo() ? ` ${store._undo[store._undo.length - 1].label.toLowerCase()}` : ''}`, key: '⌘Z', disabled: !canUndo(), run: undo },
    { label: `Redo${canRedo() ? ` ${store._redo[store._redo.length - 1].label.toLowerCase()}` : ''}`, key: '⇧⌘Z', disabled: !canRedo(), run: redo }, '-',
    { label: 'Select all tasks', key: '⌘A', run: run('edit.selectAll') },
    { label: 'Delete', key: 'Del', danger: true, run: run('edit.delete') },
  ],
  Task: () => [
    { label: 'Task information…', key: '⌘I', run: run('task.info') }, '-',
    { label: 'New task below', key: 'Ins', run: run('task.new') }, { label: 'New task above', run: run('task.newAbove') }, { label: 'New milestone', run: run('task.milestone') }, '-',
    { label: 'Indent', key: '⌥⇧→', run: run('task.indent') }, { label: 'Outdent', key: '⌥⇧←', run: run('task.outdent') },
    { label: 'Move up', key: '⌥⇧↑', run: run('task.up') }, { label: 'Move down', key: '⌥⇧↓', run: run('task.down') }, '-',
    { label: 'Link selected tasks', key: '⌘L', run: run('task.link') }, { label: 'Unlink selected tasks', key: '⇧⌘L', run: run('task.unlink') }, '-',
    { label: 'Toggle milestone', run: run('task.toggleMilestone') }, { label: 'Mark 100% complete', run: run('task.complete') }, '-',
    { label: 'Show in calendar', run: run('task.calendar') },
    { label: 'Break into subtasks…', run: run('task.breakUp') },
  ],
  Resource: () => [
    { label: 'People (shared by every plan)…', run: run('view.people') }, '-',
    { label: 'Resource information…', run: run('resource.info') }, '-',
    { label: 'New resource', run: run('resource.new') }, { label: 'Delete resource', danger: true, run: run('resource.delete') },
  ],
  View: () => [
    ...Object.entries(VIEWS).map(([id, v]) => ({ label: v.label, checked: store.ui.view === id, run: run(`view.${id}`) })), '-',
    { label: 'Zoom in', key: '⌘+', run: run('view.zoomIn') }, { label: 'Zoom out', key: '⌘−', run: run('view.zoomOut') }, { label: 'Go to today', key: '⌘0', run: run('view.today') }, '-',
    { label: 'Expand all', run: run('view.expandAll') }, { label: 'Collapse all', run: run('view.collapseAll') }, '-',
    { label: 'Details panel', checked: store.ui.rightOpen, run: run('view.inspector') }, { label: 'Checks panel', checked: store.ui.bottomOpen, run: run('view.checks') }, '-',
    { label: 'Appearance…', run: run('view.appearance') },
    { label: 'Sync…', run: run('view.sync') },
  ],
  Project: () => [
    { label: 'Project information & working time…', run: run('project.info') }, { label: 'Statistics', run: run('project.stats') },
  ],
  Export: () => [
    { label: 'Gantt chart as SVG', run: run('export.svg') }, { label: 'Gantt chart as PNG', run: run('export.png') }, { label: 'Gantt chart as PDF…', run: run('export.pdf') },
  ],
  Help: () => [{ label: 'Working with the planner', run: run('help.guide') }],
};

// ---------------------------------------------------------------- header

export function initHeader(root) {
  const menubar = el('nav', { class: 'menubar' }, ...Object.keys(MENUS).map((name) => el('button', {
    class: 'sc-button sc-button--ghost sc-button--sm', text: name,
    onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(r.left, r.bottom + 4, MENUS[name]()); },
  })));
  const find = el('input', { class: 'sc-input find', placeholder: 'Find task', id: 'find', oninput: (e) => findResults(e.target), onkeydown: (e) => { if (e.key === 'Escape') { e.target.value = ''; e.target.blur(); } e.stopPropagation(); } });
  root.append(
    el('span', { class: 'sc-brand-mark', text: 'PJ' }), el('h1', { class: 'sc-header-title', text: 'Project Planner' }), menubar, el('span', { class: 'sc-spacer' }),
    el('span', { class: 'sc-mono sc-muted', id: 'file-name' }),
    el('span', { class: 'sc-resource', title: 'Tasks' }, el('span', { class: 'sc-resource-icon' }), el('span', { id: 'count-tasks' })),
    el('span', { class: 'sc-resource sc-resource--alt', title: 'Resources' }, el('span', { class: 'sc-resource-icon' }), el('span', { id: 'count-resources' })),
    el('button', { class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', id: 'btn-undo', title: 'Undo', text: '↶', onclick: undo }),
    el('button', { class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', id: 'btn-redo', title: 'Redo', text: '↷', onclick: redo }),
    find);
}

function findResults(input) {
  const q = input.value.trim().toLowerCase();
  if (!q) return;
  const { project, schedule } = store;
  const hits = project.tasks.filter((t) => `${t.name} ${t.notes || ''}`.toLowerCase().includes(q)).slice(0, 14);
  const r = input.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, hits.length
    ? hits.map((t) => ({ label: `${schedule.tasks[t.id].index}  ${t.name}  ·  ${formatDate(schedule.tasks[t.id].startIso, 'day')}`, run: () => { if (!['gantt', 'sheet', 'network'].includes(store.ui.view)) set({ view: 'gantt' }); act.revealTask(t.id); act.selectTask(t.id); set({ rightTab: 'task' }); } }))
    : [{ note: 'No task matches.' }]);
  input.focus();
}

export function renderHeader() {
  const { project, ui } = store;
  document.getElementById('file-name').textContent = `${ui.fileName || `${slugify(project.name)}${FILE_EXT}`}${ui.dirty ? ' •' : ''}`;
  document.getElementById('count-tasks').textContent = project.tasks.length;
  document.getElementById('count-resources').textContent = project.resources.length;
  document.getElementById('btn-undo').disabled = !canUndo();
  document.getElementById('btn-redo').disabled = !canRedo();
  document.title = `${project.name} — Project Planner`;
}

// ---------------------------------------------------------------- view tabs, toolbar, status

export function renderViewTabs(root) {
  clear(root);
  for (const [id, v] of Object.entries(VIEWS)) {
    root.append(el('button', { class: `sc-tab${store.ui.view === id ? ' is-active' : ''}`, title: v.label, onclick: goView(id) }, el('span', { class: 'tab-glyph', text: v.glyph }), el('span', { text: v.short || v.label })));
  }
}

export function renderToolbar(root) {
  clear(root);
  const { ui } = store;
  const taskView = ['gantt', 'sheet'].includes(ui.view);
  const resView = ['resources', 'usage'].includes(ui.view);
  const planView = ui.view === 'projects';
  const peopleView = ui.view === 'people';
  const b = (text, title, run, { on = false, disabled = false, primary = false } = {}) => el('button', { class: `sc-button sc-button--sm${primary ? ' sc-button--primary' : ''}${on ? ' is-on' : ''}`, text, title, disabled, onclick: run });
  const sep = () => el('span', { class: 'tb-sep' });
  const sel = ui.selection.length;
  if (planView) {
    root.append(
      b('+ Project', 'Start a new plan', () => { COMMANDS['file.new'](); }, { primary: true }),
      b('↻ Refresh', 'Sync, then re-read the shelf', COMMANDS['view.refreshPlans']),
      b('Sync…', 'Where plans are kept online', settingsDialog));
  } else if (ui.view === 'calendar') {
    root.append(b('‹ Week', 'The week before', () => shiftWeek(-1)), b('Today', 'Back to this week', showThisWeek), b('Week ›', 'The week after', () => shiftWeek(1)), sep(),
      b('↻ Plans', 'Re-read every plan on the shelf', () => { void reloadCalendarPlans(); }),
      b('+ Task', 'New task below the selection', act.newTaskBelow),
      b('Break up…', 'Cut the selected task into subtasks', () => { const id = act.activeId(); if (id) void act.breakUpDialog(id); }, { disabled: !sel }),
      b('Put on calendar', 'Show every unfinished task on the calendar', act.showAllInCalendar));
  } else if (ui.view === 'priority') {
    root.append(b('+ Task', 'New task below the selection', act.newTaskBelow, { primary: true }),
      b('Break up…', 'Cut the selected task into subtasks', () => { const id = act.activeId(); if (id) void act.breakUpDialog(id); }, { disabled: !sel }),
      b('✓ 100%', 'Mark the active task complete', COMMANDS['task.complete'], { disabled: !sel }));
  } else if (ui.view === 'alltasks') {
    root.append(b('↻ Refresh', 'Sync, then re-read every plan', () => { void reloadPlans({ pull: true }).then(() => reloadAllTasks()); }),
      b('Sync…', 'Where plans are kept online', settingsDialog));
  } else if (ui.view === 'kanban') {
    root.append(b('+ Task', 'New task below the selection', act.newTaskBelow, { primary: true }),
      b('Delete', 'Delete the selected tasks', act.deleteSelection, { disabled: !sel }), sep(),
      el('span', { class: 'sc-label tb-label', text: 'Group by' }),
      ...Object.entries(GROUPINGS).map(([id, label]) => b(label, `Column by ${label.toLowerCase()}`, () => set({ kanbanGroup: id }), { on: (ui.kanbanGroup || 'stage') === id })));
  } else if (taskView || ui.view === 'network') {
    root.append(
      b('+ Task', 'New task below the selection (Insert)', act.newTaskBelow, { primary: true }), b('◆ Milestone', 'New milestone', act.newMilestone),
      b('Delete', 'Delete the selected tasks (Del)', act.deleteSelection, { disabled: !sel }), sep(),
      b('⇥ Indent', 'Indent (⌥⇧→)', act.indentSelection, { disabled: !sel }), b('⇤ Outdent', 'Outdent (⌥⇧←)', act.outdentSelection, { disabled: !sel }),
      b('↑', 'Move up (⌥⇧↑)', () => act.moveSelection(-1), { disabled: !sel }), b('↓', 'Move down (⌥⇧↓)', () => act.moveSelection(1), { disabled: !sel }), sep(),
      b('⛓ Link', 'Link the selected tasks in order (⌘L)', act.linkSelection, { disabled: sel < 2 }), b('Unlink', 'Remove links from the selected tasks (⇧⌘L)', act.unlinkSelection, { disabled: !sel }), sep(),
      b('✓ 100%', 'Mark the active task complete', COMMANDS['task.complete'], { disabled: !sel }));
  } else if (resView) {
    root.append(b('+ Resource', 'New resource', act.newResource, { primary: true }), b('Delete', 'Delete the selected resource', () => act.deleteResource(), { disabled: !ui.resourceId }), sep(),
      b('People…', 'Everyone, shared by every plan', COMMANDS['view.people']));
  } else if (peopleView) {
    root.append(b('↻ Refresh', 'Sync, then re-read the directory and every plan', () => { void reloadPlans({ pull: true }).then(() => reloadPeople()); }),
      b('Resource Sheet', 'Who is on the open plan', COMMANDS['view.resources']));
  }
  root.append(el('span', { class: 'sc-spacer' }));
  if (ui.view === 'gantt') {
    root.append(el('span', { class: 'sc-label tb-label', text: 'Scale' }),
      ...Object.entries(ZOOMS).map(([z, m]) => b(m.label, `Show ${m.label.toLowerCase()}`, () => set({ zoom: z }), { on: ui.zoom === z })),
      b('Today', 'Scroll to today (⌘0)', scrollToToday), sep());
  } else if (ui.view === 'network') {
    root.append(b('−', 'Zoom out', () => zoomNetwork(-1)), b('+', 'Zoom in', () => zoomNetwork(1)), sep());
  }
  if (taskView) root.append(b('Collapse all', 'Hide every subtask', () => act.collapseAll(true)), b('Expand all', 'Show every subtask', () => act.collapseAll(false)), sep());
  root.append(b('ⓘ Details', 'Show or hide the details panel', () => set({ rightOpen: !ui.rightOpen }), { on: ui.rightOpen }),
    b('Checks', 'Show or hide the checks panel', () => set({ bottomOpen: !ui.bottomOpen }), { on: ui.bottomOpen }));
}

export function renderStatus(root) {
  clear(root);
  const { ui, project, schedule, issues } = store;
  const n = ui.selection.length;
  root.append(el('span', { class: 'status-tool', text: VIEWS[ui.view].label }), el('span', { class: 'status-hint', text: ui.hint || '' }), el('span', { class: 'sc-spacer' }));
  root.append(el('span', { text: n ? `${n} selected` : `${project.tasks.length} tasks` }));
  root.append(el('span', { text: `${formatDate(schedule.startIso, 'day')} – ${formatDate(schedule.finishIso, 'day')} · ${schedule.duration}d · ${schedule.percent}%` }));
  const errs = issues.filter((i) => i.level === 'error').length, warns = issues.filter((i) => i.level === 'warning').length;
  root.append(el('span', { class: errs ? 'warn' : '', text: errs || warns ? `${errs ? `${errs} error${errs > 1 ? 's' : ''}` : ''}${errs && warns ? ', ' : ''}${warns ? `${warns} warning${warns > 1 ? 's' : ''}` : ''}` : 'no issues' }));
  root.append(el('span', { class: ui.dirty ? 'warn' : 'ok', text: ui.dirty ? '● unsaved' : '● saved' }));
  if (syncConfigured()) {
    const s = syncStatus();
    const glyph = s.phase === 'syncing' ? '⟳' : s.phase === 'error' ? '⚠' : '⇅';
    root.append(el('button', {
      class: `link status-sync${s.phase === 'error' ? ' warn' : ''}`, text: `${glyph} sync`,
      title: s.phase === 'error' ? `Last sync failed: ${s.lastError}` : s.lastSyncAt ? `Last sync ${new Date(s.lastSyncAt).toLocaleTimeString()}` : 'Not synced yet',
      onclick: settingsDialog,
    }));
  }
}
