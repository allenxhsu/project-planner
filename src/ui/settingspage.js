// Settings, as Motion lays them out: the sidebar turns into the list of
// settings (with ← Back to the planner) and each one is a page.
//
//   General     Calendars · Auto-scheduling · Task defaults · Theme ·
//               Timezone · Schedules · Custom fields · Desktop app ·
//               Integrations · Sync · Data
//   Team        People
//   Workspaces  one page each: its name, its folders, its projects
//
// Most pages draw what already exists elsewhere (the project's scheduling
// settings, the Schedules page); the rest are small forms of their own.

import { el, clear } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { URGENCIES } from '../model/model.js';
import { BLOCK_CHOICES } from '../model/agenda.js';
import { taskDefaults, setTaskDefaults, DEADLINE_RULES } from './taskdefaults.js';
import { icon } from './icons.js';
import { promptText, confirmDialog } from './dialog.js';

/** [id, label, icon, section] — the settings list in the sidebar. */
export const SETTINGS_PAGES = [
  ['calendars', 'Calendars', 'calendar', 'General'],
  ['scheduling', 'Auto-scheduling', 'clock', 'General'],
  ['taskDefaults', 'Task defaults', 'list', 'General'],
  ['theme', 'Theme', 'star', 'General'],
  ['timezone', 'Timezone', 'clock', 'General'],
  ['schedules', 'Schedules', 'timeline', 'General'],
  ['fields', 'Custom fields', 'sheet', 'General'],
  ['desktop', 'Desktop app', 'resources', 'General'],
  ['integrations', 'Integrations', 'network', 'General'],
  ['sync', 'Sync', 'usage', 'General'],
  ['data', 'Data', 'folder', 'General'],
  ['people', 'People', 'people', 'Team'],
];

let back = 'calendar';   // the view to go back to
/** Settings ▸ a page (the sidebar becomes the settings list). */
export function openSettings(page = null) {
  if (store.ui.view !== 'settings') back = store.ui.view;
  set({ view: 'settings', settingsPage: page || store.ui.settingsPage || 'calendars' });
}
export function leaveSettings() { set({ view: back || 'calendar' }); }

const page = (title, ...body) => el('div', { class: 'st-page' }, el('h2', { class: 'st-title', text: title }), el('div', { class: 'st-body' }, ...body.filter(Boolean)));
const section = (title, ...body) => el('section', { class: 'st-section' }, title ? el('h3', { text: title }) : null, ...body.filter(Boolean));
const note = (text) => el('p', { class: 'sc-muted small st-note', text });
const row = (label, control, hint = null) => el('label', { class: 'st-row' }, el('span', { class: 'st-label', text: label }), el('span', { class: 'st-control' }, control, hint ? el('span', { class: 'sc-faint small', text: hint }) : null));
const button = (text, run, cls = '') => el('button', { class: `sc-button sc-button--sm ${cls}`, text, onclick: run });
const select = (value, options, onchange) => el('select', { class: 'sc-select', onchange: (e) => onchange(e.target.value) },
  ...options.map(([v, label]) => el('option', { value: v, text: label, selected: String(v) === String(value) })));
const toggle = (checked, onchange) => el('input', { type: 'checkbox', class: 'sc-check', checked, onchange: (e) => onchange(e.target.checked) });
const card = (title, text, ...actions) => el('div', { class: 'st-card sc-card' }, el('strong', { text: title }), el('span', { class: 'sc-muted small', text }), el('div', { class: 'st-card-actions' }, ...actions));
const minText = (m) => (m < 60 ? `${m} min` : `${m / 60} hour${m === 60 ? '' : 's'}`);

async function command(id) { const { COMMANDS } = await import('./toolbar.js'); COMMANDS[id]?.(); }

const PAGES = {
  calendars() {
    const host = el('div');
    void import('./inspector.js').then((m) => m.renderProjectSettings(host, 'calendars'));
    return page('Calendars',
      note('Calendars connected to the open project. Their meetings are busy time: auto-scheduling works around them. Each can belong to a person on the project, and can reserve travel time around events that have a place.'),
      host);
  },
  scheduling() {
    const host = el('div');
    void import('./inspector.js').then((m) => m.renderProjectSettings(host, 'working'));
    return page(`Auto-scheduling — ${store.project.name}`,
      note('How the open project’s tasks are laid on the calendar: its working days and hours, the block a task is cut into, the break between blocks, and holidays.'),
      host);
  },
  taskDefaults() {
    const d = taskDefaults();
    const change = (k) => (v) => { setTaskDefaults({ [k]: v }); act.hint('Saved: new tasks start this way.'); };
    return page('Task defaults',
      note('These are used when a task is made with ＋ New task.'),
      section(null,
        row('Priority', select(d.urgency, Object.entries(URGENCIES).map(([k, u]) => [k, u.label]), change('urgency'))),
        row('Duration', select(d.minutes, [15, 30, 45, 60, 90, 120, 180, 240, 480].map((m) => [m, minText(m)]), (v) => change('minutes')(+v))),
        row('Min chunk duration', select(d.chunk, [['', 'The plan’s block size'], ...BLOCK_CHOICES.map((h) => [h, minText(h * 60)]), ['whole', 'No chunks']], change('chunk'))),
        row('Auto-scheduled', toggle(!!d.auto, change('auto'))),
        row('Deadline', select(d.deadline, Object.entries(DEADLINE_RULES), change('deadline'))),
        row('Hard deadline', toggle(!!d.hard, change('hard')))));
  },
  theme() {
    return page('Theme',
      note('Appearance is shared with the other toolkit apps.'),
      section(null, el('sc-theme-picker')));
  },
  timezone() {
    let zone = '';
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { zone = ''; }
    let short = '';
    try { short = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value || ''; } catch { short = ''; }
    return page('Timezone',
      section(null, row('Timezone', el('strong', { text: `${zone || 'This computer’s'}${short ? ` (${short})` : ''}` }), 'the calendar and the schedule use this computer’s time zone')));
  },
  schedules() {
    const host = el('div', { class: 'st-embed' });
    void import('./schedules.js').then((m) => m.renderSchedules(host));
    return page('Schedules', note('The hours each kind of work may use, shared by every project. A task (or a project’s default) names the schedule it is done in.'), host);
  },
  fields() {
    return page('Custom fields',
      note('Extra fields on the open project’s tasks — text, numbers, dates, choices — shown in the task window and the lists.'),
      section(null, button('Edit custom fields…', () => { void import('./newproject.js').then((m) => m.editFieldsDialog()); })));
  },
  desktop() {
    const keys = [['New task', 'Insert'], ['Task information', '⌘I'], ['Undo / Redo', '⌘Z / ⇧⌘Z'], ['Save to the cloud', '⌘S'], ['Link / Unlink tasks', '⌘L / ⇧⌘L'],
      ['Indent / Outdent', '⌥⇧→ / ⌥⇧←'], ['Move task up / down', '⌥⇧↑ / ⌥⇧↓'], ['Projects, Gantt, Kanban, All tasks, Calendar…', '⌘1 … ⌘9'], ['Zoom in / out', '⌘+ / ⌘−'], ['Today', '⌘0']];
    return page('Desktop app',
      note('Project Planner for the Mac is the same planner in its own window, with a menu bar, files you can open and save, and the same sync.'),
      section('Keyboard shortcuts', el('div', { class: 'st-keys' }, ...keys.flatMap(([what, k]) => [el('span', { text: what }), el('kbd', { class: 'sc-mono', text: k })]))));
  },
  integrations() {
    return page('Integrations', el('div', { class: 'st-cards' },
      card('Motion', 'Bring in your Motion projects and tasks from its export ZIP (Settings ▸ Export data).', button('Import from Motion…', () => { void import('./motionimport.js').then((m) => m.importMotion()); })),
      card('Microsoft Project', 'Open a Microsoft Project XML or MPX file, or save the open plan as one.', button('Open…', () => { void command('file.open'); }), button('Export XML…', () => { void command('file.exportXml'); })),
      card('Calendar (.ics)', 'Send this week’s blocks to any calendar app as an .ics file.', button('Export this week…', () => { void command('file.exportIcs'); })),
      card('Connected calendars', 'Google or Outlook meetings as busy time.', button('Calendars', () => openSettings('calendars')))));
  },
  sync() {
    return page('Sync',
      note('Plans, people, workspaces and schedules are kept on this device and, when sync is set up, in your workspace online — so the Mac app, this browser and the Portal show the same work.'),
      section(null, button('Sync settings…', () => { void command('view.sync'); })));
  },
  data() {
    return page('Data',
      section('Download your data', note('Every plan, person, workspace and schedule in one file.'), button('Export everything…', () => { void command('file.exportAll'); })),
      section('Bring data in', note('A file made by Export everything, added to what is here.'), button('Import everything…', () => { void command('file.importAll'); })));
  },
  people() {
    return page('People', note('Everyone who can be given work, across every project, with their hours.'), section(null, button('Open People', () => set({ view: 'people' }))));
  },
};

/** A workspace's page: its name, its folders, how many projects, and deleting it. */
async function workspacePage(id) {
  const sync = await import('../state/sync.js');
  const w = (await sync.listWorkspaces()).find((x) => x.id === id);
  if (!w) return page('Workspace', note('That workspace is gone.'));
  const plans = (await sync.listPlans()).filter((p) => p.workspaceId === id && !p.template);
  const folders = sync.foldersOf(w);
  const redraw = () => set({});
  return page(w.name,
    section('Name', el('div', { class: 'st-inline' }, el('strong', { text: w.name }), button('Rename…', async () => {
      const name = await promptText('Rename the workspace', '', w.name);
      if (name?.trim()) { await sync.renameWorkspace(id, name); const { refreshSidebar } = await import('./sidebar.js'); await refreshSidebar(); redraw(); }
    }))),
    section('Folders', ...(folders.length ? folders.map((f) => el('div', { class: 'st-inline' }, icon('folder'), el('span', { text: `${f.name} · ${plans.filter((p) => p.folderId === f.id).length} projects` }),
      button('Rename…', async () => { const n = await promptText('Rename the folder', '', f.name); if (n?.trim()) { await sync.renameFolder(id, f.id, n); redraw(); } }),
      button('Delete', async () => { if (await confirmDialog(`Delete the folder “${f.name}”?`, 'Its projects stay in the workspace.', 'Delete folder')) { await sync.deleteFolder(id, f.id); redraw(); } }, 'sc-button--ghost'))) : [note('No folders yet.')]),
    button('＋ New folder…', async () => { const n = await promptText('New folder', `A folder in ${w.name}.`, ''); if (n?.trim()) { await sync.createFolder(id, n); redraw(); } })),
    section('Projects', note(`${plans.filter((p) => !p.archived).length} open, ${plans.filter((p) => p.archived).length} archived.`)),
    section('Delete workspace', note('Its projects are kept and become unfiled — nothing is deleted but the workspace.'),
      button('Delete workspace…', async () => {
        if (!(await confirmDialog(`Delete the workspace “${w.name}”?`, 'Its projects are kept and become unfiled.', 'Delete workspace'))) return;
        await sync.deleteWorkspace(id);
        const { refreshSidebar } = await import('./sidebar.js');
        await refreshSidebar();
        set({ settingsPage: 'calendars' });
      }, 'sc-button--danger')));
}

export function renderSettings(root) {
  clear(root);
  const id = store.ui.settingsPage || 'calendars';
  const pane = el('div', { class: 'st-pane' });
  root.append(pane);
  if (id.startsWith('ws:')) { void workspacePage(id.slice(3)).then((node) => { if (pane.isConnected) pane.replaceChildren(node); }); return; }
  pane.append((PAGES[id] || PAGES.calendars)());
}
