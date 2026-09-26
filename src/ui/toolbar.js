// Header (brand, menus, find, undo/redo), view tabs, the action toolbar and the status line.

import { el, clear, downloadText, downloadBlob, slugify } from '../util.js';
import { store, set, undo, redo, canUndo, canRedo, loadProject, markSaved, VIEWS } from '../state/store.js';
import * as act from '../state/actions.js';
import { createProject } from '../model/model.js';
import { newProjectWizard, editFieldsDialog } from './newproject.js';
import { sampleProject } from '../model/sample.js';
import { serialize, parse, FILE_EXT } from '../io/json.js';
import { exportMspdi, importMspdi } from '../io/mspdi.js';
import { exportCsv, importCsv } from '../io/csv.js';
import { exportSvg, exportPng, exportPdf } from '../io/exportImage.js';
import { showMenu, showPanel, confirmDialog, showText, promptText } from './dialog.js';
import { settingsDialog } from './settings.js';
import { reloadPlans } from './projects.js';
import { reloadPeople } from './people.js';
import { reloadUsage } from './resources.js';
import { GROUPINGS } from './kanban.js';
import { reloadAllTasks } from './alltasks.js';
import { shiftWeek, showThisWeek, reloadCalendarPlans, RANGES, rangeOf, currentLayout, calendarTitle, displayOptions } from './calendar.js';
import { formatClock } from '../model/agenda.js';
import { exportStore, importStore, syncAfterSave, syncConfigured, syncStatus, saveToCloud, getSettings, inPortal, persistence, lastCounts, storeCounts, listWorkspaces, createWorkspace, renameWorkspace, deleteWorkspace, activeWorkspace, setActiveWorkspace } from '../state/sync.js';
import { zoomGantt, scrollToToday, ZOOMS } from './gantt.js';
import { zoomNetwork } from './network.js';
import { RULES } from '../model/validate.js';
import { formatDate, fromDay, today } from '../model/calendar.js';
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
  if (result.ok) {
    const where = inPortal() ? location.host : (getSettings().url ? new URL(getSettings().url).host : 'the cloud');
    act.hint(`Saved to ${where}.`);
    return;
  }
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

/**
 * The week on the calendar, as a calendar.
 *
 * One event per block, with a UID made of the task, the day and the block's
 * place in it, so importing a newer export replaces rather than duplicates.
 * The week is the one on screen, across every project the calendar covers —
 * the same blocks the view draws, pins and all.
 */
async function exportWeekIcs() {
  const { currentLayout, daysOnScreen } = await import('./calendar.js');
  const { writeIcs, blocksToEvents } = await import('../io/ics.js');
  const { entries, all } = currentLayout();
  const { days } = daysOnScreen(store.project);
  // A month's grid shows the edges of its neighbours; the export is the
  // week (or day, or three days) on screen, and in month view the whole month.
  const shown = new Set(days);
  const blocks = all.blocks.filter((b) => shown.has(b.day));
  if (!blocks.length) { showText('Nothing to export', 'There are no blocks on the calendar in the days on screen. Put some tasks on the calendar, or move to a week that has work in it.'); return; }
  const describe = (taskId, planId) => {
    const e = entries.find((x) => x.project.id === planId);
    const t = e?.project.tasks.find((x) => x.id === taskId);
    return t ? { name: t.name, planName: e.project.name } : null;
  };
  const events = blocksToEvents(blocks, describe);
  const first = formatDate(fromDay(Math.min(...days)), 'day').replace(/\s+/g, '-');
  downloadText(writeIcs(events, { name: `Project Planner — week of ${formatDate(fromDay(Math.min(...days)), 'long')}` }),
    `planner-week-${fromDay(Math.min(...days))}.ics`, 'text/calendar');
  act.hint(`Exported ${events.length} block${events.length === 1 ? '' : 's'} as a calendar, ${first} onward.`);
}

/**
 * Every record this app holds, tombstones included, as one file.
 *
 * A plan file is one plan. This is the whole shelf — plans, people, time
 * blocks, workspaces — so a copy can live on a disk, or move to another
 * browser, without a server in the middle.
 */
async function exportEverything() {
  const doc = await exportStore();
  downloadText(JSON.stringify(doc, null, 2), `project-planner-${today()}.store.json`, 'application/json');
  act.hint(`Exported ${doc.counts.total} records (${doc.counts.live} live, ${doc.counts.deleted} deleted).`);
}

/** Merge one back, by the rule sync already uses: the newer record wins. */
async function importEverything() {
  const input = document.getElementById('file-input');
  const previous = input.accept;
  input.value = ''; input.accept = '.json,application/json';
  input.onchange = async () => {
    input.accept = previous;
    const file = input.files[0];
    if (!file) return;
    try {
      const result = await importStore(await file.text());
      const { reloadPlans: reload } = await import('./projects.js');
      await reload();
      showText('Imported', [
        `${result.added} record${result.added === 1 ? '' : 's'} added.`,
        `${result.replaced} replaced by a newer copy.`,
        `${result.kept} already newer here, so kept.`,
        '',
        'Nothing was deleted: what is here and not in the file was left alone.',
      ].join('\n'));
    } catch (err) {
      showText('That file could not be imported', err.message);
    }
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

const goView = (view) => () => { set({ view, editing: null }); if (view === 'projects') void reloadPlans(); if (view === 'alltasks' || view === 'list') void reloadAllTasks(); if (view === 'calendar' || view === 'today') void reloadCalendarPlans(); if (view === 'people') void reloadPeople(); if (view === 'usage') void reloadUsage(); };
const zoomIn = () => (store.ui.view === 'network' ? zoomNetwork(1) : zoomGantt(1));
const zoomOut = () => (store.ui.view === 'network' ? zoomNetwork(-1) : zoomGantt(-1));

/** Every menu command by id. The web menu bar and the macOS menu bar both run these. */
export const COMMANDS = {
  'file.new': newProject, 'file.open': openFile, 'file.sample': openSample, 'file.save': saveProject, 'file.saveAs': saveProjectAs,
  'file.exportXml': guarded(exportXml), 'file.exportCsv': guarded(exportCsvFile),
  'file.exportAll': guarded(exportEverything), 'file.importAll': importEverything,
  'file.exportIcs': guarded(exportWeekIcs),
  'file.exportMpx': guarded(() => exportVia('mpx')), 'file.exportXer': guarded(() => exportVia('xer')), 'file.exportPmxml': guarded(() => exportVia('pmxml')), 'file.exportPlanner': guarded(() => exportVia('planner')),
  'edit.undo': undo, 'edit.redo': redo, 'edit.selectAll': act.selectAll, 'edit.delete': () => (['resources', 'usage'].includes(store.ui.view) ? act.deleteResource() : act.deleteSelection()),
  'task.new': act.newTaskBelow, 'task.newAbove': act.newTaskAbove, 'task.milestone': act.newMilestone, 'task.toggleMilestone': act.toggleMilestone,
  'task.indent': act.indentSelection, 'task.outdent': act.outdentSelection, 'task.up': () => act.moveSelection(-1), 'task.down': () => act.moveSelection(1),
  'task.link': act.linkSelection, 'task.unlink': act.unlinkSelection, 'task.info': () => { const id = act.activeId(); if (id) void import('./blockmenu.js').then((m) => m.taskSheet({ taskId: id })); else act.hint('Select a task first.'); },
  'task.complete': () => { const id = act.activeId(); if (id) act.setPercent(id, 100); },
  'resource.new': act.newResource, 'resource.delete': () => act.deleteResource(), 'resource.info': () => set({ view: 'resources' }),
  'view.projects': goView('projects'), 'view.kanban': goView('kanban'), 'view.alltasks': goView('alltasks'), 'view.list': goView('list'), 'view.team': goView('team'),
  'view.calendar': goView('calendar'), 'view.priority': goView('priority'),
  'view.weekBack': () => shiftWeek(-1), 'view.weekOn': () => shiftWeek(1), 'view.thisWeek': showThisWeek,
  'task.breakUp': () => { const id = act.activeId(); if (id) void act.breakUpDialog(id); },
  'task.calendar': () => { const id = act.activeId(); if (!id) return; const t = store.project.tasks.find((x) => x.id === id); act.editTask(id, 'calendarShow', !(t?.calendar?.show)); },
  'view.refreshPlans': () => { void reloadPlans({ pull: true }); },
  'view.today': goView('today'), 'view.people': goView('people'), 'view.schedules': goView('schedules'), 'view.gantt': goView('gantt'), 'view.sheet': goView('sheet'), 'view.resources': goView('resources'), 'view.usage': goView('usage'), 'view.network': goView('network'),
  'view.zoomIn': zoomIn, 'view.zoomOut': zoomOut, 'view.today': scrollToToday,
  'view.expandAll': () => act.collapseAll(false), 'view.collapseAll': () => act.collapseAll(true),
  'view.inspector': () => set({ rightOpen: !store.ui.rightOpen }), 'view.checks': () => set({ bottomOpen: !store.ui.bottomOpen }),
  'view.appearance': appearance, 'view.sync': settingsDialog,
  'project.archive': async () => {
    const { setPlanArchived } = await import('../state/sync.js');
    const on = !store.project.archived;
    if (on && !(await confirmDialog('Archive this project?',
      'It keeps every task and every logged hour, and stays on the shelf. It stops counting as work in hand: off the calendar, out of All Tasks, and out of what anyone is carrying.', 'Archive'))) return;
    await setPlanArchived(store.project.id, on);
    reloadPlans();
  },
  'project.info': () => { void import('./inspector.js').then((m) => m.projectSettingsDialog()); }, 'project.stats': () => set({ bottomOpen: true, bottomTab: 'stats' }),
  'export.svg': guarded(exportSvg), 'export.png': guarded(exportPng), 'export.pdf': guarded(exportPdf),
  'file.importMotion': () => { void import('./motionimport.js').then((m) => m.importMotion()); },
  'file.newProject': () => { void newProjectWizard(); },
  'project.sheet': () => { void import('./projectsheet.js').then((m) => m.projectSheet()); },
  'project.fields': () => { void editFieldsDialog(); },
  'help.guide': help,
};
const run = (id) => COMMANDS[id];

const MENUS = {
  File: () => [
    { label: 'New project…', run: () => { void newProjectWizard(); } }, { label: 'New empty plan', run: run('file.new') }, { label: 'Open…', key: '⌘O', run: run('file.open') }, { label: 'Open the sample plan', run: run('file.sample') }, '-',
    { label: 'Save to the cloud', key: '⌘S', run: run('file.save') },
    { label: 'Save As… (a file on this computer)', key: '⇧⌘S', run: run('file.saveAs') }, '-',
    { label: 'Open Microsoft Project file (.mpp, .mpx, XML)…', run: run('file.open') },
    { label: 'Save for Microsoft Project (XML)', run: run('file.exportXml') }, '-',
    { label: 'Export Microsoft Project MPX', run: run('file.exportMpx') },
    { label: 'Export Primavera XER', run: run('file.exportXer') },
    { label: 'Export Primavera PMXML', run: run('file.exportPmxml') },
    { label: 'Export GNOME Planner', run: run('file.exportPlanner') },
    { label: 'Export task list as CSV', run: run('file.exportCsv') },
    { label: 'Export week as calendar (.ics)', run: run('file.exportIcs') }, '-',
    { label: 'Export everything (every project, person and setting)…', run: run('file.exportAll') },
    { label: 'Import everything…', run: run('file.importAll') },
    { label: 'Import from Motion (export ZIP)…', run: run('file.importMotion') },
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
    { label: 'Auto-schedule', run: run('task.calendar') },
    { label: 'Break into subtasks…', run: run('task.breakUp') },
  ],
  Resource: () => [
    { label: 'People (shared by every plan)…', run: run('view.people') }, '-',
    { label: 'Resource information…', run: run('resource.info') }, '-',
    { label: 'New resource', run: run('resource.new') }, { label: 'Delete resource', danger: true, run: run('resource.delete') },
  ],
  View: () => [
    ...Object.entries(VIEWS).map(([id, v]) => ({ label: v.label, checked: store.ui.view === id, run: run(`view.${id}`) })), '-',
    ...(store.ui.view === 'calendar' ? [{ note: 'Calendar shows' }, ...Object.entries(RANGES).map(([id, r]) => ({ label: `  ${r.label}`, checked: rangeOf() === id, run: () => set({ calendarRange: id }) })), '-'] : []),
    { label: 'Zoom in', key: '⌘+', run: run('view.zoomIn') }, { label: 'Zoom out', key: '⌘−', run: run('view.zoomOut') }, { label: 'Go to today', key: '⌘0', run: run('view.today') }, '-',
    { label: 'Expand all', run: run('view.expandAll') }, { label: 'Collapse all', run: run('view.collapseAll') }, '-',
{ label: 'Checks panel', checked: store.ui.bottomOpen, run: run('view.checks') }, '-',
    { label: 'Appearance…', run: run('view.appearance') },
    { label: 'Sync…', run: run('view.sync') },
  ],
  Project: () => [
    { label: 'Project…', run: () => { void import('./projectsheet.js').then((m) => m.projectSheet()); } }, { label: 'Project settings — working time & scheduling…', run: run('project.info') }, { label: 'Statistics', run: run('project.stats') }, '-',
    { label: 'Custom fields…', run: () => { void editFieldsDialog(); } }, '-',
    { label: store.project.archived ? 'Bring back from the archive' : 'Archive this project', run: run('project.archive') },
  ],
  Export: () => [
    { label: 'Gantt chart as SVG', run: run('export.svg') }, { label: 'Gantt chart as PNG', run: run('export.png') }, { label: 'Gantt chart as PDF…', run: run('export.pdf') },
  ],
  Help: () => [{ label: 'Working with the planner', run: run('help.guide') }],
};

// ---------------------------------------------------------------- header

/** + New: the things a person starts, wherever they are. */
export function newMenu(x, y) {
  showMenu(x, y, [
    { icon: '☐', label: 'New task…', run: () => { void import('./taskpanel.js').then((m) => m.newTaskPanel()); } },
    { icon: '▦', label: 'New event…', run: () => {
      const d = new Date();
      const start = Math.min(23 * 60, Math.ceil((d.getHours() * 60 + d.getMinutes()) / 30) * 30);
      void import('./blockmenu.js').then((m) => m.eventDialog({ day: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, start, end: Math.min(24 * 60, start + 30) }));
    } },
    { icon: '▢', label: 'New project…', run: () => { void newProjectWizard(); } },
    { icon: '◷', label: 'New schedule…', run: () => { void import('./schedules.js').then((m) => m.editSchedule(null)); } },
    { icon: '◆', label: 'New milestone', run: () => { if (!['gantt', 'sheet'].includes(store.ui.view)) set({ view: 'gantt' }); act.newMilestone(); } },
  ]);
}

export function initHeader(root) {
  const menubar = el('nav', { class: 'menubar' }, ...Object.keys(MENUS).map((name) => el('button', {
    class: 'sc-button sc-button--ghost sc-button--sm', text: name,
    onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(r.left, r.bottom + 4, MENUS[name]()); },
  })));
  // New, search, undo, the workspaces and what is on now live in the sidebar
  // (ui/sidebar.js). A plan is saved as it is edited and its counts are in the
  // status line, so the header is the menus alone — and on the Mac, which has
  // its own menu bar, it is not drawn at all.
  root.append(menubar);
}

/**
 * Which workspace is in front, and the making of new ones.
 *
 * Work, personal and school are different lives sharing one tool. Switching
 * here changes what every screen counts: the projects on the shelf, the tasks
 * in All Tasks, the hours on the calendar and what each person is carrying.
 */
export async function workspaceMenu(x, y) {
  const spaces = await listWorkspaces();
  const active = activeWorkspace();
  const { reloadPlans: reload } = await import('./projects.js');
  const refresh = async () => {
    const { reloadCalendarPlans: rc } = await import('./calendar.js');
    const { reloadAllTasks: ra } = await import('./alltasks.js');
    const { reloadPeople: rp } = await import('./people.js');
    // The button's own label is read from a record, so it has to be re-read
    // too — otherwise the shelf changes and the header keeps the old name.
    await Promise.all([refreshWorkspaceLabel(), reload(), rc(), ra(), rp()]);
  };
  const items = [
    { note: 'Workspace' },
    { label: 'All workspaces', checked: !active, run: async () => { setActiveWorkspace(''); await refresh(); } },
    ...spaces.map((w) => ({ label: w.name, checked: active === w.id, run: async () => { setActiveWorkspace(w.id); await refresh(); } })),
    '-',
    { label: 'New workspace…', run: async () => {
      const name = await promptText('New workspace', 'Work, personal, school — whatever the projects in it have in common.', '');
      if (!name?.trim()) return;
      const made = await createWorkspace(name.trim());
      if (made) { setActiveWorkspace(made.id); await refresh(); }
    } },
  ];
  if (active) {
    const here = spaces.find((w) => w.id === active);
    items.push(
      { label: `Rename “${here?.name || 'this workspace'}”…`, run: async () => {
        const name = await promptText('Rename this workspace', 'What should it be called?', here?.name || '');
        if (name?.trim()) { await renameWorkspace(active, name.trim()); await refresh(); }
      } },
      { label: `Delete “${here?.name || 'this workspace'}”`, danger: true, run: async () => {
        const yes = await confirmDialog('Delete this workspace?', 'The projects in it are kept. They become unfiled and show up wherever you are.');
        if (!yes) return;
        await deleteWorkspace(active);
        await refresh();
      } },
    );
  }
  showMenu(x, y, items);
}

export function findResults(input) {
  const q = input.value.trim().toLowerCase();
  if (!q) return;
  const { project, schedule } = store;
  const hits = project.tasks.filter((t) => `${t.name} ${t.notes || ''}`.toLowerCase().includes(q)).slice(0, 14);
  const r = input.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, hits.length
    ? hits.map((t) => ({ label: `${schedule.tasks[t.id].index}  ${t.name}  ·  ${formatDate(schedule.tasks[t.id].startIso, 'day')}`, run: () => { if (!['gantt', 'sheet', 'network'].includes(store.ui.view)) set({ view: 'gantt' }); act.revealTask(t.id); act.selectTask(t.id); } }))
    : [{ note: 'No task matches.' }]);
  input.focus();
}

let workspaceLabel = 'All workspaces';
/** Keep the header's workspace button in step with the records. */
export async function refreshWorkspaceLabel() {
  const active = activeWorkspace();
  if (!active) { workspaceLabel = 'All workspaces'; }
  else {
    const here = (await listWorkspaces()).find((w) => w.id === active);
    workspaceLabel = here ? here.name : 'All workspaces';
  }
  const btn = document.getElementById('workspace-pick');
  if (btn) btn.textContent = workspaceLabel;
}

export function renderHeader() {
  const { project, ui } = store;
  const btn = document.getElementById('workspace-pick');
  if (btn) btn.textContent = workspaceLabel;
  for (const [id, can] of [['btn-undo', canUndo()], ['btn-redo', canRedo()]]) { const n = document.getElementById(id); if (n) n.disabled = !can; }
  void slugify; void FILE_EXT; void ui;
  document.title = `${project.name} — Project Planner`;
  // What is on now is drawn by the sidebar (ui/sidebar.js).
}
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ---------------------------------------------------------------- view tabs, toolbar, status

export function renderViewTabs(root) {
  clear(root);
  for (const [id, v] of Object.entries(VIEWS)) {
    root.append(el('button', { class: `sc-tab${store.ui.view === id ? ' is-active' : ''}`, title: v.label, onclick: goView(id) }, el('span', { class: 'tab-glyph', text: v.glyph }), el('span', { text: v.short || v.label })));
  }
}

export function renderToolbar(root) {
  clear(root);
  root.classList.remove('is-cal');
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
      b('+ Project', 'Start a project — from scratch or from a template', () => { void newProjectWizard(); }, { primary: true }),
      b('↻ Refresh', 'Sync, then re-read the shelf', COMMANDS['view.refreshPlans']),
      b('Sync…', 'Where plans are kept online', settingsDialog));
  } else if (ui.view === 'calendar') {
    // Motion's bar: Today ‹ › and the month, then the options on the right.
    const r = RANGES[rangeOf()];
    const unit = r.step === 3 ? '3 days' : r.unit;
    const title = calendarTitle();
    root.classList.add('is-cal');
    root.append(
      b('Today', 'Back to today', showThisWeek),
      el('button', { class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', text: '‹', title: `The ${unit} before`, onclick: () => shiftWeek(-1) }),
      el('button', { class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', text: '›', title: `The ${unit} after`, onclick: () => shiftWeek(1) }),
      el('span', { class: 'cal-title' }, el('strong', { text: title.month }), ' ', el('span', { text: title.year })),
      el('span', { class: 'sc-spacer' }),
      b('⚙ Display options', 'Who and what the calendar shows', (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        showPanel(rect.left, rect.bottom + 4, (close) => displayOptions(close));
      }),
      b('↻ Refresh all tasks', 'Re-read every plan and lay the week again', () => { void reloadCalendarPlans(); }),
      b('＋', 'A new task', () => { void import('./taskpanel.js').then((m) => m.newTaskPanel()); }),
      el('select', { class: 'sc-select sc-select--sm cal-range', title: 'How much of the calendar to show', onchange: (e) => set({ calendarRange: e.target.value }) },
        ...Object.entries(RANGES).map(([id, rr]) => el('option', { value: id, text: rr.label, selected: rangeOf() === id }))),
      b(ui.rightOpen ? 'Close »' : '« Calendars', ui.rightOpen ? 'Hide the right-hand panel' : 'Show the month and the calendars', () => set({ rightOpen: !ui.rightOpen })));
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
  } else if (ui.view === 'today') {
    root.append(b('↻ Refresh', 'Sync, then re-read every plan', () => { void reloadPlans({ pull: true }).then(() => reloadCalendarPlans()); }),
      b('Calendar', 'The week', COMMANDS['view.calendar']), b('Priority', 'Everything, ranked', COMMANDS['view.priority']));
  } else if (ui.view === 'schedules') {
    root.append(b('+ Schedule', 'Draw a new set of hours', () => { void import('./schedules.js').then((m) => m.editSchedule(null)); }, { primary: true }),
      b('Calendar', 'Back to the week', COMMANDS['view.calendar']));
  } else if (ui.view === 'usage') {
    root.append(b('↻ Refresh', 'Sync, then re-read every plan', () => { void reloadPlans({ pull: true }).then(() => reloadUsage()); }),
      b('People…', 'Everyone, shared by every plan', COMMANDS['view.people']),
      b('Resource Sheet', 'Who is on the open plan', COMMANDS['view.resources']));
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
  root.append(b('Checks', 'Show or hide the checks panel', () => set({ bottomOpen: !ui.bottomOpen }), { on: ui.bottomOpen }));
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
  root.append(syncChip());
}

/**
 * The sync readout: where this copy stands, in one chip.
 *
 * Four things decide whether the data is safe, and each was somewhere else or
 * nowhere: is sync on at all, did the last run work, how many records are here
 * against how many the server holds, and has the browser agreed to keep the
 * local copy. A chip that only appeared when sync was configured could never
 * say the most important thing — that it is not.
 */
function syncChip() {
  const s = syncStatus();
  const { local, server } = lastCounts();
  const p = persistence();
  const where = inPortal() ? location.host : (getSettings().url ? hostOf(getSettings().url) : null);

  if (!syncConfigured()) {
    return el('button', {
      class: 'link status-sync warn', text: '○ not syncing',
      title: [
        'This copy is on this device only.',
        local ? `${local} record${local === 1 ? '' : 's'} here, none on a server.` : '',
        p.state === 'persisted' ? 'The browser has agreed to keep it.' : 'The browser has not agreed to keep it, so it could be cleared.',
        '',
        'Click to set up sync.',
      ].filter(Boolean).join('\n'),
      onclick: settingsDialog,
    });
  }

  const glyph = s.phase === 'syncing' ? '⟳' : s.phase === 'error' ? '⚠' : '⇅';
  const when = s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  const text = s.phase === 'syncing' ? `${glyph} syncing…`
    : s.phase === 'error' ? `${glyph} sync failed`
      : when ? `${glyph} ${when}` : `${glyph} not synced yet`;
  const agree = server === null ? null : (server === local);

  return el('button', {
    class: `link status-sync${s.phase === 'error' ? ' warn' : agree === false ? ' pending' : ' ok'}`,
    text: `${text}${server === null ? '' : `  ${local}/${server}`}`,
    title: [
      s.phase === 'error' ? `The last sync failed: ${s.lastError || 'no reason given'}` : null,
      where ? `Syncing with ${where}${inPortal() ? ' as the account you are signed in as' : ''}.` : null,
      when ? `Last sync at ${when}.` : 'No sync has finished yet.',
      server === null ? `${local} record${local === 1 ? '' : 's'} here; the server was not reachable when last asked.`
        : agree ? `${local} records here and ${server} on the server — the same.`
          : `${local} here, ${server} on the server. They differ until the next sync finishes.`,
      p.state === 'persisted' ? 'The browser keeps this copy on the device.'
        : p.state === 'at-risk' ? 'The browser has not agreed to keep the local copy: install the app to fix that.' : null,
      '',
      'Click for sync settings.',
    ].filter(Boolean).join('\n'),
    onclick: settingsDialog,
  });
}

const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };
