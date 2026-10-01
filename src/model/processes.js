// Processes and stages: the shape of a kind of project, kept once and reused.
//
// A project moves through stages — quote, design, build, test, certify, ship
// — and the work in each is mostly the same kind of work from project to
// project. So the stages are one list shared by every project (a project may
// skip some), and the work is kept as process modules: "CE certification",
// "NFPA certification", "Design review" — a group of tasks, each with how
// long it takes, the skill it needs, what it waits for, and the stage it
// belongs to. A project says which processes it covers; then adding work is
// picking it: in the design stage, the design tasks of its processes.
//
// A stage in a project is a summary task: its subtasks are the stage's work,
// and moving the project to it releases them to the calendar (model.js
// inCurrentPhase). Modules come from a summary and its subtasks here, and —
// next — from an IDEF0 model, whose decomposed activities are processes.

import { uid } from '../util.js';

/** The stages a project goes through, when nobody has said otherwise. */
export const DEFAULT_STAGE_SET = [
  { key: 'quote', name: 'Quote' },
  { key: 'design', name: 'Design' },
  { key: 'build', name: 'Build' },
  { key: 'test', name: 'Test' },
  { key: 'certify', name: 'Certify' },
  { key: 'ship', name: 'Ship' },
];

const keyOf = (name) => String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || uid('st');

/** The shared stage list, cleaned: each { key, name }, keys unique, in order. */
export function cleanStageSet(list) {
  const seen = new Set();
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    const name = String(s?.name || '').trim().slice(0, 60);
    if (!name) continue;
    let key = String(s.key || keyOf(name)).trim().slice(0, 40) || keyOf(name);
    while (seen.has(key)) key = `${key}-2`;
    seen.add(key);
    out.push({ key, name });
  }
  return out.length ? out : DEFAULT_STAGE_SET.map((s) => ({ ...s }));
}

/** The standard stage a project stage (phase) stands for: by its key, else by name. */
export function stageKeyOf(stageSet, phase) {
  if (!phase) return null;
  if (phase.stageKey && stageSet.some((s) => s.key === phase.stageKey)) return phase.stageKey;
  const byName = stageSet.find((s) => s.name.trim().toLowerCase() === String(phase.name || '').trim().toLowerCase());
  return byName ? byName.key : null;
}

/**
 * A process module, cleaned: { id, name, description, tasks: [{ key, name,
 * work, stage, skill, after[], level }] }. `stage` is a standard stage key or
 * null (any stage); `after` names other tasks of the module by key.
 */
export function cleanModule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim().slice(0, 80);
  if (!name) return null;
  const keys = new Set();
  const tasks = (Array.isArray(raw.tasks) ? raw.tasks : []).map((t) => {
    const tn = String(t?.name || '').trim().slice(0, 200);
    if (!tn) return null;
    let key = String(t.key || keyOf(tn)).slice(0, 60);
    while (keys.has(key)) key = `${key}-2`;
    keys.add(key);
    return {
      key, name: tn,
      work: Number.isFinite(+t.work) && +t.work > 0 ? Math.round(+t.work * 100) / 100 : null,
      stage: typeof t.stage === 'string' && t.stage ? t.stage : null,
      skill: typeof t.skill === 'string' && t.skill.trim() ? t.skill.trim().slice(0, 40) : null,
      after: Array.isArray(t.after) ? t.after.map(String) : [],
      level: Math.max(1, Math.min(6, Math.round(+t.level) || 1)),
    };
  }).filter(Boolean);
  for (const t of tasks) t.after = t.after.filter((k) => keys.has(k) && k !== t.key);
  return {
    id: String(raw.id || uid('mod')), name,
    description: String(raw.description || '').slice(0, 2000),
    tasks,
    ...(raw.source && typeof raw.source === 'object' ? { source: raw.source } : {}),
  };
}

/** The module tasks a project still has to take in a stage: [{ module, task, added }]. */
export function choicesFor(p, modules, stageKey) {
  const have = new Set(p.tasks.filter((t) => t.fromModule).map((t) => `${t.fromModule.id}:${t.fromModule.key}`));
  const out = [];
  for (const m of modules) {
    for (const task of m.tasks) {
      if (stageKey && task.stage && task.stage !== stageKey) continue;
      out.push({ module: m, task, added: have.has(`${m.id}:${task.key}`) });
    }
  }
  return out;
}

export const moduleTag = (m, key) => ({ id: m.id, key, name: m.name });
