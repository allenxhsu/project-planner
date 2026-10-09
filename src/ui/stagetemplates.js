// Templates by the stage (model/templates.js), as two windows.
//
//   addStagesDialog   for a project that exists: pick a template, tick the
//                     stages and tasks wanted, and they are added — a stage
//                     the project already has gets only what it is missing.
//   templateWizard    from a project: name it, pick and tune the stages,
//                     pick and tune the tasks, review, save as a template.

import { el } from '../util.js';
import { store } from '../state/store.js';
import * as act from '../state/actions.js';
import { getTask, getResource } from '../model/model.js';
import { stageGroups, matchIn, hasTask, templateFrom } from '../model/templates.js';
import { open, foot, button } from './dialog.js';

const hrs = (h) => (h ? (h < 1 ? `${Math.round(h * 60)}m` : `${Math.round(h * 10) / 10}h`) : '');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** "4h", "90m", "1.5" (hours) → hours, or null. */
function hoursOf(text) {
  const s = String(text || '').trim().toLowerCase();
  if (!s) return null;
  const h = s.match(/(\d+(?:\.\d+)?)\s*h/);
  const m = s.match(/(\d+)\s*m/);
  if (h || m) return Math.round(((h ? parseFloat(h[1]) : 0) + (m ? +m[1] / 60 : 0)) * 100) / 100 || null;
  return /^\d+(\.\d+)?$/.test(s) ? parseFloat(s) : null;
}

// ------------------------------------------------------------------ add stages

export async function addStagesDialog() {
  const sync = await import('../state/sync.js');
  const [plans, stageSet] = await Promise.all([sync.listPlans(), sync.getStageSet()]);
  const templates = plans.filter((x) => x.ok && x.template && x.id !== store.project.id).sort((a, b) => a.name.localeCompare(b.name));
  const target = store.project;

  const picked = await open(`Add stages from a template — ${target.name}`, (close) => {
    if (!templates.length) {
      return [
        el('p', { class: 'sc-muted', text: 'No templates yet.' }),
        el('p', { class: 'sc-faint small', text: 'Make one from a project: its menu ▸ Create a template… — then its stages can be added to any project.' }),
        foot(el('span', { class: 'sc-spacer' }), button('Close', () => close(null), 'sc-button--primary')),
      ];
    }
    const choose = el('select', { class: 'sc-select' }, ...templates.map((t) => el('option', { value: t.id, text: t.name.replace(/\s*\(template\)\s*$/i, '') })));
    const list = el('div', { class: 'stt-list' });
    const addBtn = button('Add', () => {}, 'sc-button--primary');
    let template = null;
    /** group id → Set of ticked task ids (absent: the stage is not ticked). */
    let ticks = new Map();
    const count = () => {
      let stages = 0, tasks = 0;
      for (const [, ids] of ticks) { if (ids.size) { stages++; tasks += ids.size; } }
      addBtn.disabled = !tasks;
      addBtn.textContent = tasks ? `Add ${plural(stages, 'stage')}, ${plural(tasks, 'task')}` : 'Add';
    };
    const draw = () => {
      if (!template) { list.replaceChildren(el('p', { class: 'sc-faint small', text: 'That template could not be read.' })); count(); return; }
      const groups = stageGroups(template, stageSet);
      if (!groups.length) { list.replaceChildren(el('p', { class: 'sc-faint small', text: 'This template has no tasks.' })); count(); return; }
      list.replaceChildren(...groups.map((g) => {
        const match = matchIn(target, g, stageSet);
        const tasks = g.taskIds.map((id) => getTask(template, id));
        const missing = tasks.filter((t) => !hasTask(match, t.name));
        const on = ticks.has(g.id);
        const status = match.exists
          ? (missing.length ? `already here: adds ${missing.length} of ${tasks.length}` : 'already here, nothing to add')
          : g.kind === 'stage' ? `new stage, ${plural(tasks.length, 'task')}` : g.kind === 'group' ? `a group, not a stage · ${plural(tasks.length, 'task')}` : plural(tasks.length, 'task');
        const box = el('input', { type: 'checkbox', class: 'sc-check', checked: on, disabled: !missing.length,
          onclick: (e) => e.stopPropagation(),
          onchange: (e) => { if (e.target.checked) ticks.set(g.id, new Set(missing.map((t) => t.id))); else ticks.delete(g.id); draw(); } });
        return el('details', { class: 'stt-group', open: on },
          el('summary', {}, box, el('strong', { text: g.name }), el('span', { class: 'sc-faint small', text: ` · ${status}` })),
          ...tasks.map((t) => {
            const here = hasTask(match, t.name);
            return el('label', { class: `stt-task${here ? ' is-here' : ''}` },
              el('input', { type: 'checkbox', class: 'sc-check', disabled: here, checked: !here && !!ticks.get(g.id)?.has(t.id),
                onchange: (e) => {
                  const ids = ticks.get(g.id) || new Set();
                  if (e.target.checked) ids.add(t.id); else ids.delete(t.id);
                  if (ids.size) ticks.set(g.id, ids); else ticks.delete(g.id);
                  box.checked = ticks.has(g.id);
                  count();
                } }),
              el('span', { class: 'stt-name', text: t.name }),
              t.skill ? el('span', { class: 'sc-pill', text: t.skill }) : null,
              el('span', { class: 'sc-faint small sc-mono', text: here ? 'already here' : hrs(t.work) }));
          }));
      }));
      count();
    };
    const load = async () => {
      template = await sync.readPlan(choose.value);
      // Start with every stage ticked that has something to add; groups that are not stages are left for the person.
      ticks = new Map();
      if (template) for (const g of stageGroups(template, stageSet)) {
        if (g.kind !== 'stage') continue;
        const match = matchIn(target, g, stageSet);
        const missing = g.taskIds.filter((id) => !hasTask(match, getTask(template, id).name));
        if (missing.length) ticks.set(g.id, new Set(missing));
      }
      draw();
    };
    choose.addEventListener('change', () => { void load(); });
    addBtn.onclick = () => close({ template, picks: [...ticks.entries()].map(([id, ids]) => ({ id, taskIds: [...ids] })) });
    void load();
    return [
      el('div', { class: 'stt-pick' }, el('span', { class: 'sc-faint small', text: 'Template' }), choose),
      list,
      foot(el('span', { class: 'sc-faint small', text: 'Tasks come with their work, skill and links — no dates, progress or people.' }),
        el('span', { class: 'sc-spacer' }), button('Cancel', () => close(null)), addBtn),
    ];
  }, { wide: true });
  if (!picked || !picked.template) return;
  const result = act.addStages(picked.template, picked.picks, stageSet);
  if (!result) return;
  const parts = [result.stages ? `${plural(result.stages, 'stage')} added` : null, result.merged ? `${plural(result.merged, 'stage')} filled in` : null,
    `${plural(result.tasks, 'task')}`, result.skipped ? `${result.skipped} already here` : null].filter(Boolean);
  act.hint(`${parts.join(' · ')}.`);
}

// ------------------------------------------------------------------ create a template

const STEPS = ['Name', 'Stages', 'Tasks', 'Review'];

export async function templateWizard() {
  const sync = await import('../state/sync.js');
  const stageSet = await sync.getStageSet();
  const p = store.project;
  const groups = stageGroups(p, stageSet);
  const role = (t) => t.skill || (t.assignments || []).map((a) => String(getResource(p, a.resourceId)?.group || '').trim()).find(Boolean) || '';
  // What the wizard decides (model/templates.js templateFrom).
  const state = {
    name: p.name.replace(/\s+(WO|SO)\s*#?\d[\w-]*/gi, '').trim() || p.name,
    description: p.description || '',
    groups: groups.map((g) => ({ id: g.id, include: g.kind !== 'loose', name: g.name, stageKey: g.stageKey, kind: g.kind, taskIds: g.taskIds })),
    tasks: Object.fromEntries(groups.flatMap((g) => g.taskIds).map((id) => { const t = getTask(p, id); return [id, { include: true, name: t.name, work: t.work ?? null, skill: role(t) }]; })),
  };
  const spec = () => ({
    name: state.name, description: state.description,
    groups: state.groups.map((g) => ({ id: g.id, include: g.include, name: g.name, stageKey: g.stageKey })),
    tasks: Object.fromEntries(Object.entries(state.tasks).map(([id, e]) => [id, { include: e.include, name: e.name, work: e.work, skill: e.skill }])),
  });
  const kept = (g) => g.taskIds.filter((id) => state.tasks[id].include);

  const saved = await open('Create a template', (close) => {
    let step = 0;
    let viewing = state.groups.find((g) => g.include)?.id || state.groups[0]?.id || null;
    const body = el('div', { class: 'tw-body' });
    const dots = el('div', { class: 'tw-steps' });
    const back = button('Back', () => { step--; draw(); });
    const next = button('Next', () => {}, 'sc-button--primary');
    const error = el('span', { class: 'tw-error small' });

    const pages = [
      // 1: the name, and what a template leaves behind.
      () => {
        const name = el('input', { class: 'sc-input', type: 'text', value: state.name, 'data-autofocus': '', onkeydown: (e) => e.stopPropagation(), oninput: (e) => { state.name = e.target.value; error.textContent = ''; } });
        const description = el('textarea', { class: 'sc-input', rows: 3, value: state.description, placeholder: 'What kind of project this is for', onkeydown: (e) => e.stopPropagation(), oninput: (e) => { state.description = e.target.value; } });
        description.value = state.description;
        return [
          el('label', { class: 'sc-field' }, el('span', { class: 'sc-label', text: 'Name' }), name),
          el('label', { class: 'sc-field' }, el('span', { class: 'sc-label', text: 'Description' }), description),
          el('p', { class: 'sc-muted small', text: `From ${p.name}. A template is the pattern, so these are cleared: dates and deadlines, progress, logged time, and people — whoever is on a task is kept as the skill it needs (their role), so each new project staffs it.` }),
          groups.length ? null : el('p', { class: 'tw-error small', text: 'This project has no tasks to make a template from.' }),
        ];
      },
      // 2: which stages, what they are called, which standard stage each is, in what order.
      () => [
        el('p', { class: 'sc-muted small', text: 'Tick the parts to keep. Rename one by typing over it; say which standard stage it is (or that it is just a group); the arrows set the order.' }),
        el('div', { class: 'tw-list' }, ...state.groups.map((g, i) => el('div', { class: `tw-row${g.include ? '' : ' is-off'}` },
          el('input', { type: 'checkbox', class: 'sc-check', checked: g.include, onchange: (e) => { g.include = e.target.checked; draw(); } }),
          g.kind === 'loose'
            ? el('span', { class: 'tw-name sc-faint', text: 'Tasks under no heading' })
            : el('input', { class: 'sc-input tw-name', type: 'text', value: g.name, onkeydown: (e) => e.stopPropagation(), oninput: (e) => { g.name = e.target.value; } }),
          g.kind === 'loose' ? el('span', { class: 'tw-stage' }) : el('select', { class: 'sc-select tw-stage', onchange: (e) => { g.stageKey = e.target.value || null; } },
            el('option', { value: '', text: 'Not a stage', selected: !g.stageKey }),
            ...stageSet.map((s) => el('option', { value: s.key, text: s.name, selected: g.stageKey === s.key }))),
          el('span', { class: 'sc-faint small tw-count', text: plural(kept(g).length, 'task') }),
          el('button', { class: 'ord-btn', text: '↑', title: 'Earlier', disabled: i === 0, onclick: () => { [state.groups[i - 1], state.groups[i]] = [state.groups[i], state.groups[i - 1]]; draw(); } }),
          el('button', { class: 'ord-btn', text: '↓', title: 'Later', disabled: i === state.groups.length - 1, onclick: () => { [state.groups[i + 1], state.groups[i]] = [state.groups[i], state.groups[i + 1]]; draw(); } })))),
      ],
      // 3: the tasks of each kept stage — keep, rename, how long, what skill.
      () => {
        const included = state.groups.filter((g) => g.include);
        if (!included.some((g) => g.id === viewing)) viewing = included[0]?.id || null;
        const g = included.find((x) => x.id === viewing);
        if (!g) return [el('p', { class: 'sc-faint', text: 'No part of the project is kept — go back and tick one.' })];
        const pick = el('select', { class: 'sc-select', onchange: (e) => { viewing = e.target.value; draw(); } },
          ...included.map((x) => el('option', { value: x.id, text: `${x.kind === 'loose' ? 'Tasks under no heading' : x.name} — ${kept(x).length} of ${x.taskIds.length}`, selected: x.id === viewing })));
        const all = (on) => { for (const id of g.taskIds) state.tasks[id].include = on; draw(); };
        // One-offs that are over: done, and not part of a process or a routine.
        const oneOffs = g.taskIds.filter((id) => { const t = getTask(p, id); return (t.percent ?? 0) === 100 && !t.fromModule && !t.repeat; });
        return [
          el('div', { class: 'tw-pick' }, el('span', { class: 'sc-faint small', text: 'Stage' }), pick),
          el('div', { class: 'tw-list' }, ...g.taskIds.map((id) => {
            const e = state.tasks[id];
            return el('div', { class: `tw-row${e.include ? '' : ' is-off'}` },
              el('input', { type: 'checkbox', class: 'sc-check', checked: e.include, onchange: (ev) => { e.include = ev.target.checked; draw(); } }),
              el('input', { class: 'sc-input tw-name', type: 'text', value: e.name, onkeydown: (ev) => ev.stopPropagation(), oninput: (ev) => { e.name = ev.target.value; } }),
              el('input', { class: 'sc-input tw-hours', type: 'text', value: hrs(e.work), placeholder: 'how long', title: 'How long it takes: 4h, 90m, 1.5 (hours)', onkeydown: (ev) => ev.stopPropagation(), onchange: (ev) => { e.work = hoursOf(ev.target.value); ev.target.value = hrs(e.work); } }),
              el('input', { class: 'sc-input tw-skill', type: 'text', value: e.skill, placeholder: 'skill', title: 'The skill it needs', onkeydown: (ev) => ev.stopPropagation(), oninput: (ev) => { e.skill = ev.target.value; } }));
          })),
          el('div', { class: 'tw-bulk' },
            el('button', { class: 'link', text: 'Tick all', onclick: () => all(true) }),
            el('button', { class: 'link', text: 'Untick all', onclick: () => all(false) }),
            oneOffs.length ? el('button', { class: 'link', text: `Untick finished one-offs (${oneOffs.length})`, title: 'Tasks that are done and belong to no process or routine', onclick: () => { for (const id of oneOffs) state.tasks[id].include = false; draw(); } }) : null),
        ];
      },
      // 4: what it comes to.
      () => {
        try { templateFrom(p, spec(), stageSet); } catch (err) { return [el('p', { class: 'tw-error', text: err.message })]; }
        const used = state.groups.filter((g) => g.include && kept(g).length);
        const hours = used.flatMap(kept).reduce((n, id) => n + (+state.tasks[id].work || 0), 0);
        const leftGroups = state.groups.length - used.length;
        const leftTasks = Object.keys(state.tasks).length - used.flatMap(kept).length;
        return [
          el('p', {}, el('strong', { text: state.name.trim() }), el('span', { class: 'sc-muted', text: ` — ${plural(used.filter((g) => g.kind !== 'loose').length, 'stage')}, ${plural(used.flatMap(kept).length, 'task')}${hours ? `, ${hrs(hours)}` : ''}` })),
          el('div', { class: 'tw-list' }, ...used.map((g) => el('div', { class: 'tw-row' },
            el('span', { class: 'tw-name', text: g.kind === 'loose' ? 'Tasks under no heading' : g.name.trim() || '(unnamed)' }),
            el('span', { class: 'sc-faint small tw-stage', text: g.kind === 'loose' ? '' : stageSet.find((s) => s.key === g.stageKey)?.name || 'a group' }),
            el('span', { class: 'sc-faint small tw-count', text: plural(kept(g).length, 'task') })))),
          leftGroups || leftTasks ? el('p', { class: 'sc-faint small', text: `Left out: ${[leftGroups ? plural(leftGroups, 'part') : null, leftTasks ? plural(leftTasks, 'task') : null].filter(Boolean).join(', ')}.` }) : null,
          used.length ? null : el('p', { class: 'tw-error small', text: 'Nothing is kept: go back and tick at least one task.' }),
        ];
      },
    ];

    const draw = () => {
      dots.replaceChildren(...STEPS.map((label, i) => el('span', { class: `tw-step${i === step ? ' is-on' : i < step ? ' is-done' : ''}`, text: `${i < step ? '●' : i === step ? '●' : '○'} ${label}` })));
      body.replaceChildren(...pages[step]().filter(Boolean));
      back.hidden = step === 0;
      next.textContent = step === STEPS.length - 1 ? 'Save template' : `Next: ${STEPS[step + 1]}`;
      next.disabled = !groups.length || (step === STEPS.length - 1 && !state.groups.some((g) => g.include && kept(g).length));
      setTimeout(() => body.querySelector('[data-autofocus]')?.focus(), 0);
    };
    next.onclick = () => {
      if (step === 0 && !state.name.trim()) { error.textContent = 'A template needs a name.'; return; }
      if (step < STEPS.length - 1) { step++; draw(); return; }
      try { close(templateFrom(p, spec(), stageSet)); } catch (err) { error.textContent = err.message; }
    };
    draw();
    return [
      el('div', { class: 'tw-head' }, dots),
      body,
      foot(error, el('span', { class: 'sc-spacer' }), button('Cancel', () => close(null)), back, next),
    ];
  }, { wide: true });
  if (!saved) return;
  const ok = await sync.saveTemplatePlan(saved);
  act.hint(ok ? `“${saved.name}” is a template — New project and Add stages offer it.` : 'The template could not be saved.');
}
