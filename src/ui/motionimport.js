// File ▸ Import from Motion…: a Motion export onto the shelf.
//
// Pick the ZIP Motion's Settings ▸ Export data gives you (or its
// projects.json and tasks.json). A summary says what will come in; then
// every Motion workspace that is missing is made, and every project is put on
// the shelf under its workspace. A project imported before is replaced by
// the new copy — the same Motion project, read again — not doubled.

import { el } from '../util.js';
import { set } from '../state/store.js';
import * as act from '../state/actions.js';
import { open, foot, button } from './dialog.js';
import { readZip, zipText } from '../io/zip.js';
import { motionToPlans, motionSchedules } from '../io/motion.js';

function pickFiles() {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept: '.zip,.json,application/zip,application/json', multiple: true, hidden: true });
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

/** projects and tasks from whatever was picked: the export's ZIP, or its JSON files. */
async function readExport(files) {
  const out = { projects: null, tasks: null, settings: null };
  const take = (name, text) => {
    let data;
    try { data = JSON.parse(text); } catch { return; }
    if (/settings\.json$/i.test(name) || (data && typeof data === 'object' && data.schedules && !Array.isArray(data))) { out.settings = data; return; }
    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : null;
    if (!items) return;
    if (/tasks\.json$/i.test(name) && !/recurring/i.test(name)) out.tasks = items;
    else if (/projects\.json$/i.test(name)) out.projects = items;
    else if (items[0] && 'duration' in items[0] && 'dueDate' in items[0]) out.tasks = items;
    else if (items[0] && 'manager' in items[0]) out.projects = items;
  };
  for (const f of files) {
    if (/\.zip$/i.test(f.name) || f.type === 'application/zip') {
      const entries = await readZip(await f.arrayBuffer(), { only: (n) => /(^|\/)(projects|tasks)\/(projects|tasks)\.json$/i.test(n) || /(^|\/)user\/settings\.json$/i.test(n) });
      for (const [name, bytes] of entries) take(name, zipText(bytes));
    } else take(f.name, await f.text());
  }
  if (!out.tasks && !out.projects && !out.settings) throw new Error('No Motion projects or tasks were found. Choose the ZIP from Motion’s Settings ▸ Export data.');
  return { projects: out.projects || [], tasks: out.tasks || [], settings: out.settings };
}

/**
 * A first step with a button to choose the file: a file chooser opens only
 * from a click in the page (the Mac app's menu commands are not one).
 */
function chooseFiles() {
  return open('Import from Motion', (close) => [
    el('p', { text: 'Choose the ZIP from Motion’s Settings ▸ Export data (or its projects.json and tasks.json).' }),
    foot(el('span', { class: 'sc-spacer' }), button('Cancel', () => close(null)),
      button('Choose the export ZIP…', async () => close(await pickFiles()), 'sc-button--primary')),
  ]);
}

export async function importMotion(picked = null) {
  const files = picked || await chooseFiles();
  if (!files?.length) return;
  let data;
  try { data = await readExport(files); } catch (err) { act.hint(err.message); return; }
  const result = motionToPlans(data);
  const schedules = motionSchedules(data.settings);
  const sync = await import('../state/sync.js');
  const shelf = await sync.planRecords().catch(() => []);
  const known = new Map();
  // A project imported before keeps its id, and where it was put since: its folder, place, colour, favourite.
  const kept = new Map();
  for (const r of shelf) {
    try {
      const b = JSON.parse(r.body);
      if (!b.motionId) continue;
      known.set(b.motionId, r.id);
      kept.set(b.motionId, { workspaceId: b.workspaceId || null, folderId: b.folderId || null, sortOrder: b.sortOrder ?? null, colour: b.colour ?? null, pinned: b.pinned === true });
    } catch { /* not ours to read */ }
  }
  const again = result.plans.filter((p) => p.motionId && known.has(p.motionId)).length;
  const { counts } = result;

  const choice = await open('Import from Motion', (close) => {
    const history = el('input', { type: 'checkbox', class: 'sc-check', checked: true });
    return [
      el('div', { class: 'mi-summary' },
        el('p', {}, el('strong', { text: `${counts.projects} projects and ${counts.tasks} tasks` }), ` in ${result.workspaces.length} workspaces.`),
        el('ul', { class: 'mi-list' },
          el('li', { text: `${counts.open} open task${counts.open === 1 ? '' : 's'} — they come in auto-scheduled as they were in Motion` }),
          el('li', { text: `${counts.completed} completed, with when they were done` }),
          el('li', { text: `${counts.worked} stretches of time worked, drawn on the calendar where they happened` }),
          el('li', { text: `${result.plans.filter((p) => p.archived).length} completed projects go to the archive` }),
          schedules.blocks.length ? el('li', { text: `${schedules.blocks.length} schedules (${schedules.blocks.map((b) => b.name).join(', ')})` }) : null,
        again ? el('li', { text: `${again} project${again === 1 ? ' was' : 's were'} imported before and will be replaced by this copy` }) : null),
        el('p', { class: 'sc-faint small', text: `Workspaces: ${result.workspaces.join(', ')}.` }),
        el('label', { class: 'np-check' }, history, el('span', { text: `Bring the archived history too (${counts.archived} tasks)` })),
        el('p', { class: 'sc-faint small', text: 'Motion’s export has no stages or statuses for tasks, so tasks arrive in Todo or Completed and in no stage. Notes, docs and booking links are not imported.' })),
      foot(el('span', { class: 'sc-spacer' }), button('Cancel', () => close(null)), button('Import', () => close({ history: history.checked }), 'sc-button--primary')),
    ];
  }, { wide: true });
  if (!choice) return;

  // Workspaces by name: the ones that exist are used, the rest are made.
  const spaces = await sync.listWorkspaces();
  const idFor = new Map(spaces.map((w) => [w.name.trim().toLowerCase(), w.id]));
  for (const name of result.workspaces) {
    if (idFor.has(name.toLowerCase())) continue;
    const made = await sync.createWorkspace(name);
    if (made?.id) idFor.set(name.toLowerCase(), made.id);
  }
  // Motion's export does not say which folder a project was in. Its completed
  // projects go in a "Completed Projects" folder of their workspace (made if
  // missing), which is how Motion keeps them; anything else is loose in its
  // workspace, to be dragged where it belongs.
  const completedFolder = new Map();
  const folderFor = async (workspaceId) => {
    if (completedFolder.has(workspaceId)) return completedFolder.get(workspaceId);
    const w = (await sync.listWorkspaces()).find((x) => x.id === workspaceId);
    const existing = sync.foldersOf(w).find((f) => /^complete/i.test(f.name.trim()));
    const folder = existing || await sync.createFolder(workspaceId, 'Completed Projects');
    completedFolder.set(workspaceId, folder?.id || null);
    return folder?.id || null;
  };
  // Motion's schedules, shared by every project; Motion's default is the imported projects' default.
  if (schedules.blocks.length) await sync.saveTimeBlocks(schedules.blocks);
  const shared = schedules.blocks.length ? await sync.listTimeBlocks() : [];
  // The people, once each, into the directory.
  const personIds = new Map();
  let stored = 0;
  for (const p of result.plans) {
    if (!choice.history) {
      const dropped = new Set(p.tasks.filter((t) => t.archived).map((t) => t.id));
      p.tasks = p.tasks.filter((t) => !dropped.has(t.id));
      p.timesheets = p.timesheets.filter((x) => !dropped.has(x.taskId));
      if (!p.tasks.length && p.archived) continue;
    }
    p.workspaceId = p.workspaceName ? idFor.get(p.workspaceName.toLowerCase()) || null : null;
    delete p.workspaceName;
    const before = p.motionId ? kept.get(p.motionId) : null;
    if (before && before.workspaceId === p.workspaceId) {
      Object.assign(p, { folderId: before.folderId, sortOrder: before.sortOrder, colour: before.colour, pinned: before.pinned });
    } else if (p.archived && p.workspaceId) p.folderId = await folderFor(p.workspaceId);
    for (const r of p.resources) {
      const key = r.name.toLowerCase();
      if (!personIds.has(key)) personIds.set(key, (await sync.rememberPerson({ name: r.name }).catch(() => null))?.id || null);
      r.personId = personIds.get(key);
    }
    if (shared.length) {
      sync.applyTimeBlocks(p, shared);
      // A task that names no schedule uses Any, as everywhere else.
      if (shared.some((b) => b.id === 'tb_any')) p.agenda = { ...p.agenda, timeBlockId: 'tb_any' };
    }
    if (p.motionId && known.has(p.motionId)) p.id = known.get(p.motionId);
    if (await sync.storePlan(p)) stored++;
  }
  act.hint(`Imported ${stored} project${stored === 1 ? '' : 's'} from Motion into ${result.workspaces.length} workspaces.`);
  const { reloadPlans } = await import('./projects.js');
  await reloadPlans();
  const { reloadCalendarPlans } = await import('./calendar.js');
  void reloadCalendarPlans();
  set({ view: 'projects' });
}

/**
 * Settings ▸ Schedules ▸ Import from Motion…: only the schedules, from the
 * export's user/settings.json. Offers to make Motion's default the default of
 * every project, which is what Motion does with a task that names none.
 */
export async function importMotionSchedules(picked = null) {
  const files = picked || await chooseFiles();
  if (!files?.length) return;
  let data;
  try { data = await readExport(files); } catch (err) { act.hint(err.message); return; }
  const { blocks, defaultId } = motionSchedules(data.settings);
  if (!blocks.length) { act.hint('No schedules were found in that export — it needs user/settings.json.'); return; }
  const main = blocks.find((b) => b.id === defaultId);
  const choice = await open('Import Motion’s schedules', (close) => {
    const everywhere = el('input', { type: 'checkbox', class: 'sc-check', checked: false });
    return [
      el('p', {}, el('strong', { text: `${blocks.length} schedules: ` }), blocks.map((b) => b.name).join(', '), '.'),
      el('p', { class: 'sc-faint small', text: 'Imported again, they are updated rather than doubled.' }),
      main ? el('label', { class: 'np-check' }, everywhere, el('span', { text: `Make “${main.name}”, Motion’s default, every project’s default schedule` })) : null,
      foot(el('span', { class: 'sc-spacer' }), button('Cancel', () => close(null)), button('Import', () => close({ everywhere: everywhere.checked }), 'sc-button--primary')),
    ];
  });
  if (!choice) return;
  const sync = await import('../state/sync.js');
  await sync.saveTimeBlocks(blocks);
  const moved = choice.everywhere && main ? await sync.setDefaultScheduleEverywhere(main.id) : 0;
  act.hint(`Imported ${blocks.length} schedules from Motion${choice.everywhere && main ? `; “${main.name}” is now every project’s default` : ''}.`);
  void moved;
  const { reloadCalendarPlans } = await import('./calendar.js');
  void reloadCalendarPlans();
  set({});
}
