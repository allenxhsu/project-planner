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
import { promptText, confirmDialog, typedConfirm } from './dialog.js';

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

let wsTab = 'overview';

/**
 * Merge a workspace into another — a wizard, because two workspaces seldom
 * agree: which one it goes into; where each of its folders goes; what its
 * projects' statuses and labels that the other does not use become; then a
 * review. Nothing changes until Merge.
 */
export async function mergeWorkspaceDialog(fromId) {
  const sync = await import('../state/sync.js');
  const { parse } = await import('../io/json.js');
  const { stages } = await import('../model/model.js');
  const { open: openDialog, foot, button: dialogButton, showText } = await import('./dialog.js');
  const spaces = await sync.listWorkspaces();
  const from = spaces.find((w) => w.id === fromId);
  const others = spaces.filter((w) => w.id !== fromId);
  if (!from || !others.length) { act.hint('There is no other workspace to merge into.'); return; }
  const plansIn = {};
  for (const r of await sync.planRecords()) {
    try { const p = parse(r.body).project; (plansIn[p.workspaceId || ''] ||= []).push(p); } catch { /* unreadable */ }
  }
  const norm = (x) => String(x || '').trim().toLowerCase();
  const statusesOf = (ps) => [...new Set(ps.flatMap((p) => stages(p).map((st) => st.name)))];
  const labelsOf = (ps) => [...new Set(ps.flatMap((p) => p.tasks.flatMap((t) => t.labels || [])))].sort();
  const mine = plansIn[fromId] || [];

  const state = { step: 0, into: others[0].id, folders: {}, statuses: {}, labels: {} };
  const STEPS = ['Into', 'Folders', 'Statuses', 'Labels', 'Review'];
  const target = () => others.find((w) => w.id === state.into);
  const theirs = () => plansIn[state.into] || [];
  const newStatuses = () => statusesOf(mine).filter((n) => !statusesOf(theirs()).some((m) => norm(m) === norm(n)));
  const newLabels = () => labelsOf(mine).filter((n) => !labelsOf(theirs()).some((m) => norm(m) === norm(n)));

  const done = await openDialog(`Merge “${from.name}”`, (close) => {
    const body = el('div', { class: 'mw-body' });
    const footer = el('div');
    const pick = (value, options, onchange) => el('select', { class: 'sc-select', onchange: (e) => onchange(e.target.value) },
      ...options.map(([v, label]) => el('option', { value: v, text: label, selected: v === value })));
    const line = (label, control) => el('div', { class: 'mw-line' }, el('span', { class: 'mw-from', text: label }), el('span', { class: 'sc-faint', text: '→' }), control);
    const draw = () => {
      const t = target();
      const steps = el('div', { class: 'mw-steps' }, ...STEPS.map((name, i) => el('span', { class: `mw-step${i === state.step ? ' is-on' : ''}${i < state.step ? ' is-done' : ''}`, text: `${i + 1}. ${name}` })));
      let content;
      if (state.step === 0) {
        content = [el('p', { class: 'sc-muted small', text: `${mine.length} project${mine.length === 1 ? '' : 's'} and ${sync.foldersOf(from).length} folder${sync.foldersOf(from).length === 1 ? '' : 's'} will move, and “${from.name}” is removed.` }),
          line(from.name, pick(state.into, others.map((w) => [w.id, w.name]), (v) => { state.into = v; state.folders = {}; state.statuses = {}; state.labels = {}; }))];
      } else if (state.step === 1) {
        const folders = sync.foldersOf(from);
        const theirFolders = sync.foldersOf(t);
        content = folders.length ? [el('p', { class: 'sc-muted small', text: `Where each folder of ${from.name} goes in ${t.name}.` }),
          ...folders.map((f) => {
            const same = theirFolders.find((x) => norm(x.name) === norm(f.name));
            const value = state.folders[f.id] || (same ? same.id : 'new');
            return line(`▭ ${f.name} (${mine.filter((p) => p.folderId === f.id).length})`, pick(value, [
              ['new', `A new folder “${f.name}”`], ...theirFolders.map((x) => [x.id, `Join “${x.name}”`]), ['none', 'No folder — loose in the workspace']],
            (v) => { state.folders[f.id] = v; }));
          })] : [el('p', { class: 'sc-muted small', text: `${from.name} has no folders. Nothing to resolve here.` })];
      } else if (state.step === 2) {
        const extra = newStatuses();
        const theirStatuses = statusesOf(theirs()).length ? statusesOf(theirs()) : ['Backlog', 'Todo', 'In Progress', 'Blocked', 'Completed', 'Cancelled'];
        content = extra.length ? [el('p', { class: 'sc-muted small', text: `Statuses ${from.name}’s projects use that ${t.name}’s do not. Map each to one of theirs, or keep it.` }),
          ...extra.map((n) => line(n, pick(state.statuses[n] || '', [['', 'Keep it'], ...theirStatuses.map((m) => [m, `Becomes “${m}”`])], (v) => { state.statuses[n] = v; })))]
          : [el('p', { class: 'sc-muted small', text: 'Both workspaces use the same statuses. Nothing to resolve here.' })];
      } else if (state.step === 3) {
        const extra = newLabels();
        const theirLabels = labelsOf(theirs());
        content = extra.length ? [el('p', { class: 'sc-muted small', text: `Labels on ${from.name}’s tasks that ${t.name} does not use. Keep, rename to one of theirs, or take off.` }),
          ...extra.map((n) => line(`# ${n}`, pick(n in state.labels ? state.labels[n] : n, [[n, 'Keep it'], ...theirLabels.map((m) => [m, `Becomes “${m}”`]), ['', 'Take it off']], (v) => { state.labels[n] = v; })))]
          : [el('p', { class: 'sc-muted small', text: 'No labels to resolve.' })];
      } else {
        const folderLines = sync.foldersOf(from).map((f) => {
          const v = state.folders[f.id];
          const same = sync.foldersOf(t).find((x) => norm(x.name) === norm(f.name));
          const to = v === 'none' ? 'no folder' : v && v !== 'new' ? `“${sync.foldersOf(t).find((x) => x.id === v)?.name}”` : same && !v ? `“${same.name}”` : `new “${f.name}”`;
          return `Folder ${f.name} → ${to}`;
        });
        const statusLines = Object.entries(state.statuses).filter(([, b]) => b).map(([a, b]) => `Status ${a} → ${b}`);
        const labelLines = Object.entries(state.labels).filter(([a, b]) => a !== b).map(([a, b]) => (b ? `Label ${a} → ${b}` : `Label ${a} taken off`));
        content = [el('p', { text: `${mine.length} project${mine.length === 1 ? ' moves' : 's move'} from “${from.name}” into “${t.name}”, and “${from.name}” is removed.` }),
          el('ul', { class: 'mw-review' }, ...[...folderLines, ...statusLines, ...labelLines].map((x) => el('li', { text: x })),
            ...(folderLines.length + statusLines.length + labelLines.length ? [] : [el('li', { class: 'sc-faint', text: 'Nothing else changes.' })]))];
      }
      body.replaceChildren(steps, ...content);
      footer.replaceChildren(foot(
        state.step ? dialogButton('Back', () => { state.step--; draw(); }) : el('span'),
        el('span', { class: 'sc-spacer' }),
        dialogButton('Cancel', () => close(null)),
        state.step < STEPS.length - 1 ? dialogButton('Next', () => { state.step++; draw(); }, 'sc-button--primary') : dialogButton('Merge', () => close(true), 'sc-button--primary')));
    };
    draw();
    return [body, footer];
  }, { wide: true });
  if (!done) return;
  const moved = await sync.mergeWorkspaces(fromId, state.into, { folders: state.folders, statuses: state.statuses, labels: state.labels });
  const { refreshSidebar } = await import('./sidebar.js');
  await refreshSidebar();
  if (store.ui.view === 'settings') set({ settingsPage: `ws:${state.into}` }); else set({});
  showText('Merged', `${moved} project${moved === 1 ? '' : 's'} moved into ${target().name}.`);
}
const WS_TABS = [['overview', 'Overview'], ['statuses', 'Statuses'], ['templates', 'Project Templates'], ['fields', 'Custom Fields'], ['labels', 'Labels']];

/** A workspace's settings, in Motion's tabs: its name, people, folders; the statuses, templates, fields and labels its projects use. */
async function workspacePage(id) {
  const sync = await import('../state/sync.js');
  const { parse } = await import('../io/json.js');
  const { stages, stageOf, fieldsOf } = await import('../model/model.js');
  const w = (await sync.listWorkspaces()).find((x) => x.id === id);
  if (!w) return page('Workspace', note('That workspace is gone.'));
  const projects = [];
  for (const r of await sync.planRecords()) {
    try { const p = parse(r.body).project; if (p.workspaceId === id) projects.push(p); } catch { /* unreadable */ }
  }
  const open = projects.filter((p) => !p.template);
  const folders = sync.foldersOf(w);
  const redraw = () => set({});
  const refresh = async () => { const { refreshSidebar } = await import('./sidebar.js'); await refreshSidebar(); redraw(); };

  const tabs = el('div', { class: 'st-tabs' }, ...WS_TABS.map(([k, label]) => el('button', { class: `pt-tab${wsTab === k ? ' is-on' : ''}`, text: label, onclick: () => { wsTab = k; redraw(); } })));
  let body;
  if (wsTab === 'statuses') {
    const counts = new Map();
    for (const p of open) {
      for (const st of stages(p)) if (!counts.has(st.name)) counts.set(st.name, 0);
      for (const t of p.tasks) { const n = stageOf(p, t).name; counts.set(n, (counts.get(n) || 0) + 1); }
    }
    body = section(null, note('The statuses tasks move through. Each project keeps its own list (a new project starts with Backlog, Todo, In Progress, Blocked, Completed, Cancelled); these are the ones used here.'),
      ...[...counts].map(([name, n]) => el('div', { class: 'st-inline st-line' }, el('span', { class: 'tl-ring' }), el('span', { text: name }), el('span', { class: 'sc-faint small', text: `${n} task${n === 1 ? '' : 's'}` }))));
  } else if (wsTab === 'templates') {
    const templates = projects.filter((p) => p.template);
    body = section(null, note('Templates filed in this workspace. Any project can become one: its menu ▸ Save as template.'),
      ...(templates.length ? templates.map((p) => el('div', { class: 'st-inline st-line' }, icon('project'), el('span', { text: p.name }), el('span', { class: 'sc-faint small', text: `${p.tasks.length} tasks` }),
        button('New project from it…', () => { void import('./newproject.js').then((m) => m.newProjectWizard({ workspaceId: id })); }))) : [note('No templates in this workspace yet.')]));
  } else if (wsTab === 'fields') {
    const byName = new Map();
    for (const p of open) for (const f of fieldsOf(p)) { if (!byName.has(f.name)) byName.set(f.name, { type: f.type, projects: [] }); byName.get(f.name).projects.push(p.name); }
    body = section(null, note('Custom fields are defined per project (Settings ▸ Custom fields, for the open one). These are the ones this workspace’s projects have.'),
      ...(byName.size ? [...byName].map(([name, f]) => el('div', { class: 'st-inline st-line' }, el('strong', { text: name }), el('span', { class: 'sc-faint small', text: `${f.type} · ${f.projects.join(', ')}` }))) : [note('None yet.')]));
  } else if (wsTab === 'labels') {
    const counts = new Map();
    for (const p of open) for (const t of p.tasks) for (const l of t.labels || []) counts.set(l, (counts.get(l) || 0) + 1);
    body = section(null, note('Labels on this workspace’s tasks. Add them in a task’s window or on its card.'),
      ...(counts.size ? [...counts].sort((a, b) => b[1] - a[1]).map(([l, n]) => el('div', { class: 'st-inline st-line' }, el('span', { class: 'ps-chip', text: l }), el('span', { class: 'sc-faint small', text: `${n} task${n === 1 ? '' : 's'}` }))) : [note('No labels yet.')]));
  } else {
    const name = el('input', { class: 'sc-input st-wide', type: 'text', value: w.name, onchange: async (e) => { if (e.target.value.trim()) { await sync.renameWorkspace(id, e.target.value); await refresh(); } } });
    const members = new Map();
    for (const p of open) for (const r of p.resources.filter((x) => x.type !== 'material' && x.type !== 'cost')) members.set(r.personId || r.name.toLowerCase(), r.name);
    body = el('div', { class: 'st-body' },
      section('Workspace name', name),
      section('Members', note('Everyone given work in this workspace’s projects.'),
        ...(members.size ? [...members.values()].map((m) => el('div', { class: 'st-inline st-line' }, el('span', { class: 'tl-avatar', text: m[0] }), el('span', { text: m }))) : [note('Nobody yet.')])),
      section('Folders', ...(folders.length ? folders.map((f) => el('div', { class: 'st-inline st-line' }, icon('folder'), el('span', { text: `${f.name} · ${open.filter((p) => p.folderId === f.id).length} projects` }),
        button('Rename…', async () => { const n = await promptText('Rename the folder', '', f.name); if (n?.trim()) { await sync.renameFolder(id, f.id, n); await refresh(); } }),
        button('Delete', async () => { if (await confirmDialog(`Delete the folder “${f.name}”?`, 'Its projects stay in the workspace.', 'Delete folder')) { await sync.deleteFolder(id, f.id); await refresh(); } }, 'sc-button--ghost'))) : [note('No folders yet.')]),
      button('＋ New folder…', async () => { const n = await promptText('New folder', `A folder in ${w.name}.`, ''); if (n?.trim()) { await sync.createFolder(id, n); await refresh(); } })),
      section('Projects', note(`${open.filter((p) => !p.archived).length} open, ${open.filter((p) => p.archived).length} archived.`),
        button('Archived tasks', () => { void import('./alltasks.js').then((m) => m.showArchived(id)); })),
      section('Merge workspace', note('Move all of this workspace’s projects and folders into another workspace, and remove this one.'),
        button('Merge into another workspace…', () => { void mergeWorkspaceDialog(id); })),
      section(null, button('Delete workspace', async () => {
        const n = open.length;
        const ok = await typedConfirm('Are you sure you want to delete this workspace?',
          `The workspace “${w.name}” and its ${folders.length} folder${folders.length === 1 ? '' : 's'} are deleted on every device. Its ${n} project${n === 1 ? '' : 's'} and their tasks are kept, unfiled, under No workspace.`,
          w.name, 'Delete workspace');
        if (!ok) return;
        await sync.deleteWorkspace(id);
        const { refreshSidebar } = await import('./sidebar.js');
        await refreshSidebar();
        set({ settingsPage: 'calendars' });
      }, 'sc-button--danger')));
  }
  return el('div', { class: 'st-page' }, el('h2', { class: 'st-title', text: w.name }), tabs, body);
}

export function renderSettings(root) {
  clear(root);
  const id = store.ui.settingsPage || 'calendars';
  const pane = el('div', { class: 'st-pane' });
  root.append(pane);
  if (id.startsWith('ws:')) { void workspacePage(id.slice(3)).then((node) => { if (pane.isConnected) pane.replaceChildren(node); }); return; }
  pane.append((PAGES[id] || PAGES.calendars)());
}
