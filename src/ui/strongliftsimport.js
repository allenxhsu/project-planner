// Settings ▸ Connections ▸ StrongLifts: pick the CSV the app exported, and
// every training day lands in the Lifting plan for its year — in the Personal
// workspace, archived unless the year is this one — labelled with the
// Lifting skill. The same file can be imported twice: days already there are
// left alone.

import { el } from '../util.js';
import * as act from '../state/actions.js';
import { createProject } from '../model/model.js';
import { parse, serialize } from '../io/json.js';
import { parseStrongLifts, dayTasks, planNameFor, mergeLifting } from '../io/stronglifts.js';
import { open, foot, button } from './dialog.js';

const pickFile = () => new Promise((resolve) => {
  const input = el('input', { type: 'file', accept: '.csv,text/csv' });
  input.onchange = () => resolve(input.files?.[0] || null);
  input.click();
});

export async function importStrongLifts() {
  const sync = await import('../state/sync.js');
  const file = await pickFile();
  if (!file) return;
  let sessions;
  try { sessions = parseStrongLifts(await file.text()); } catch (err) { act.hint(err.message); return; }
  if (!sessions.length) { act.hint('That file has no workouts.'); return; }
  const tasks = dayTasks(sessions);
  const years = [...new Set(tasks.map((t) => t.date.slice(0, 4)))].sort();
  const workspaces = await sync.listWorkspaces();
  const people = await sync.listPeople();
  const wsSel = el('select', { class: 'sc-select' }, ...workspaces.map((w) => el('option', { value: w.id, text: w.name, selected: /personal/i.test(w.name) })));
  const whoSel = el('select', { class: 'sc-select' }, el('option', { value: '', text: 'Me (first person in People)' }), ...people.map((p) => el('option', { value: p.id, text: p.name })));
  const go = await open('Import StrongLifts', (close) => [
    el('p', { class: 'sc-muted', text: `${sessions.length} workouts on ${tasks.length} days, ${years[0]}–${years[years.length - 1]}. One task per day, a timesheet line per workout, skill “Lifting”.` }),
    el('label', { class: 'sc-field' }, el('span', { text: 'Workspace' }), wsSel),
    el('label', { class: 'sc-field' }, el('span', { text: 'Whose hours' }), whoSel),
    foot(button('Cancel', () => close(null)), button('Import', () => close('go'), 'sc-button--primary')),
  ]);
  if (go !== 'go') return;
  const who = people.find((p) => p.id === whoSel.value) || people[0] || { id: null, name: 'Me', initials: 'ME' };
  const person = { personId: who.id, name: who.name, initials: who.initials || who.name.slice(0, 2).toUpperCase() };
  const thisYear = String(new Date().getFullYear());
  const plans = await sync.listPlans();
  const names = plans.map((p) => p.name);
  let added = 0, skipped = 0, plansTouched = 0;
  for (const year of years) {
    const mine = tasks.filter((t) => t.date.startsWith(year));
    const name = planNameFor(Number(year), names);
    const summary = plans.find((p) => p.name === name);
    let project;
    if (summary) {
      const r = await sync.readPlan(summary.id);
      project = r?.project || r;
    } else {
      project = createProject(name, mine[0].date);
      project.workspaceId = wsSel.value;
      project.archived = year !== thisYear;
      project.archivedAt = project.archived ? new Date().toISOString().slice(0, 10) : null;
      names.push(name);
    }
    const r = mergeLifting(project, mine, person);
    added += r.added; skipped += r.skipped;
    if (r.added) {
      const { project: clean } = parse(serialize(project));
      clean.id = project.id;
      await sync.storePlan(clean);
      plansTouched++;
    }
  }
  act.hint(added ? `Imported ${added} training day${added === 1 ? '' : 's'} into ${plansTouched} plan${plansTouched === 1 ? '' : 's'}${skipped ? `; ${skipped} already there` : ''}.` : `Nothing new: all ${skipped} days were already there.`);
}
