// Quick add: put work into a project by picking it (model/processes.js).
//
// The project is in a stage, and covers some processes — CE certification,
// NFPA certification. Each process knows its tasks for each stage, so what
// is offered is this stage's tasks of this project's processes: tick and add,
// and they land under the stage's summary with their links, work and skill.
// Anything else is typed on one line.

import { el } from '../util.js';
import { store } from '../state/store.js';
import * as act from '../state/actions.js';
import { phases, getPhase } from '../model/model.js';
import { stageKeyOf, choicesFor } from '../model/processes.js';
import { open, foot, button } from './dialog.js';

const hrs = (h) => (h ? (h < 1 ? `${Math.round(h * 60)}m` : `${Math.round(h * 10) / 10}h`) : '');

export async function quickAddDialog() {
  const sync = await import('../state/sync.js');
  const [stageSet, modules] = await Promise.all([sync.getStageSet(), sync.listModules()]);
  let added = 0;
  await open(`Quick add — ${store.project.name}`, (close) => {
    const p = () => store.project;
    const stagePick = el('select', { class: 'sc-select' },
      el('option', { value: '', text: phases(p()).length ? 'No stage' : 'No stages yet — mark a summary as a stage' }),
      ...phases(p()).map((ph) => {
        const std = stageSet.find((s) => s.key === stageKeyOf(stageSet, ph));
        return el('option', { value: ph.id, text: `${ph.name}${std && std.name !== ph.name ? ` (${std.name})` : ''}${ph.id === p().currentPhaseId ? ' — current' : ''}`, selected: ph.id === p().currentPhaseId });
      }));
    const covered = () => modules.filter((m) => (p().processes || []).includes(m.id));
    const processRow = el('div', { class: 'qa-processes' });
    const list = el('div', { class: 'qa-list' });
    const ticked = new Set();
    const addBtn = button('Add', () => {}, 'sc-button--primary');
    const syncAdd = () => { addBtn.textContent = ticked.size ? `Add ${ticked.size} task${ticked.size === 1 ? '' : 's'}` : 'Add'; addBtn.disabled = !ticked.size; };

    const drawProcesses = () => {
      const have = covered();
      const others = modules.filter((m) => !have.includes(m));
      processRow.replaceChildren(
        el('span', { class: 'sc-faint small', text: 'Covers' }),
        ...(have.length ? have.map((m) => el('span', { class: 'qa-chip' }, m.name,
          el('button', { class: 'qa-chip-x', title: `Not ${m.name}`, text: '×', onclick: () => { act.setProcesses((p().processes || []).filter((id) => id !== m.id)); drawProcesses(); draw(); } }))) : [el('span', { class: 'sc-faint small', text: 'no processes yet' })]),
        others.length ? el('select', { class: 'sc-select qa-add-process', onchange: (e) => { if (!e.target.value) return; act.setProcesses([...(p().processes || []), e.target.value]); drawProcesses(); draw(); } },
          el('option', { value: '', text: '＋ Add a process' }), ...others.map((m) => el('option', { value: m.id, text: m.name }))) : el('span'));
    };

    const draw = () => {
      ticked.clear();
      const ph = getPhase(p(), stagePick.value);
      const key = ph ? stageKeyOf(stageSet, ph) : null;
      const choices = choicesFor(p(), covered(), key);
      const groups = new Map();
      for (const c of choices) { if (!groups.has(c.module.id)) groups.set(c.module.id, []); groups.get(c.module.id).push(c); }
      const rows = [];
      for (const [, items] of groups) {
        rows.push(el('div', { class: 'qa-group sc-faint small', text: items[0].module.name }));
        for (const c of items) {
          const id = `${c.module.id}:${c.task.key}`;
          const box = el('input', { type: 'checkbox', class: 'sc-check', disabled: c.added, checked: false,
            onchange: (e) => { if (e.target.checked) ticked.add(id); else ticked.delete(id); syncAdd(); } });
          rows.push(el('label', { class: `qa-row${c.added ? ' is-added' : ''}` }, box,
            el('span', { class: 'qa-name', text: c.task.name }),
            c.task.skill ? el('span', { class: 'sc-pill', text: c.task.skill }) : null,
            el('span', { class: 'sc-faint small sc-mono', text: c.added ? 'added' : hrs(c.task.work) })));
        }
      }
      if (!rows.length) {
        rows.push(el('p', { class: 'sc-faint small', text: !covered().length
          ? 'This project covers no processes yet. Add one above — or make one: open a summary and Save as process….'
          : `Its processes have nothing for ${ph ? `the ${ph.name} stage` : 'this stage'}.` }));
      }
      list.replaceChildren(...rows);
      syncAdd();
    };
    stagePick.addEventListener('change', draw);
    addBtn.onclick = () => {
      const picks = choicesFor(p(), covered(), null).filter((c) => ticked.has(`${c.module.id}:${c.task.key}`));
      added += act.addFromModules(picks, stagePick.value || null);
      draw();
      act.hint(`Added ${added} task${added === 1 ? '' : 's'} to ${p().name}.`);
    };

    // One line for anything else: a name, and how long.
    const line = el('input', { class: 'sc-input', type: 'text', placeholder: 'Type a task and press Enter', onkeydown: (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter' || !line.value.trim()) return;
      const t = act.quickAddTask(line.value, +minutes.value, stagePick.value || null);
      if (t) { added++; act.hint(`Added “${t.name}”.`); line.value = ''; }
    } });
    const minutes = el('select', { class: 'sc-select qa-minutes' }, ...[[15, '15m'], [30, '30m'], [60, '1h'], [120, '2h'], [240, '4h'], [480, '1 day']].map(([m, label]) => el('option', { value: m, text: label, selected: m === 60 })));

    drawProcesses();
    draw();
    return [
      el('div', { class: 'qa-stage' }, el('span', { class: 'sc-faint small', text: 'Stage' }), stagePick),
      processRow,
      list,
      el('div', { class: 'qa-line' }, line, minutes),
      foot(el('button', { class: 'link', text: 'Add stages from a template…', onclick: () => { close(null); void import('./stagetemplates.js').then((m) => m.addStagesDialog()); } }),
        el('span', { class: 'sc-spacer' }), button('Done', () => close(null)), addBtn),
    ];
  }, { wide: true });
}
