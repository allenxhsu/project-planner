// Templates by the stage: take a project's shape without retyping it.
//
// A project's stages — and the groups of tasks that are not stages, and
// whatever is left over — are its parts (stageGroups). Two things are built
// from them:
//
//   addStagesFrom  copies picked stages, with their picked tasks, from a
//                  template into a project that already exists. A stage the
//                  project already has is not made twice: it gets the tasks
//                  it is missing.
//   templateFrom   makes a template out of a project: the stages and tasks
//                  that were kept, renamed and re-timed as the wizard said.
//
// Either way what comes across is the pattern: names, work, skills, links.
// Not the history — no dates, progress, logged time or people. Who did a task
// is kept as the skill it needs (their role), so the next project staffs it.

import { createProject, insertTask, getTask, getResource, descendants, isSummary, phases, link, linkError, setSummaryStage, taskIndex } from './model.js';
import { stageTasks } from './stages.js';
import { stageKeyOf } from './processes.js';

/**
 * The parts of a plan, in order: its stages (each with its tasks), then the
 * top-level groups that are not stages, then the tasks in neither.
 * [{ id, kind: 'stage'|'group'|'loose', name, stageKey, summaryId, taskIds }]
 */
export function stageGroups(p, stageSet) {
  const used = new Set();
  const out = [];
  const isWork = (t, i) => !isSummary(p, i) && !t.repeatOf;   // an occurrence is its routine's, not the pattern
  for (const ph of phases(p)) {
    const taskIds = stageTasks(p, ph.id, { archived: true }).filter((t) => !t.repeatOf).map((t) => t.id);
    for (const id of taskIds) used.add(id);
    const head = ph.summaryId ? getTask(p, ph.summaryId) : null;
    if (head) used.add(head.id);
    out.push({ id: ph.id, kind: 'stage', name: ph.name, stageKey: stageKeyOf(stageSet, ph), summaryId: head ? head.id : null, taskIds });
  }
  p.tasks.forEach((t, i) => {
    if (t.level !== 1 || !isSummary(p, i) || used.has(t.id)) return;
    const taskIds = descendants(p, i).filter((j) => isWork(p.tasks[j], j) && !used.has(p.tasks[j].id)).map((j) => p.tasks[j].id);
    used.add(t.id);
    for (const j of descendants(p, i)) used.add(p.tasks[j].id);
    if (taskIds.length) out.push({ id: t.id, kind: 'group', name: t.name, stageKey: null, summaryId: t.id, taskIds });
  });
  const loose = p.tasks.filter((t, i) => isWork(t, i) && !used.has(t.id)).map((t) => t.id);
  if (loose.length) out.push({ id: '_loose', kind: 'loose', name: 'Other tasks', stageKey: null, summaryId: null, taskIds: loose });
  return out;
}

/** The skill a task needs: its own, else the role of whoever is on it. */
function skillOf(p, t) {
  if (t.skill) return t.skill;
  for (const a of t.assignments || []) {
    const role = String(getResource(p, a.resourceId)?.group || '').trim();
    if (role) return role.slice(0, 40);
  }
  return null;
}

/** A task as a pattern: what it is and what it takes, none of what happened to it. */
function pattern(p, t, { show, edits = {} }) {
  const skill = edits.skill !== undefined ? String(edits.skill || '').trim() : skillOf(p, t);
  return {
    name: String(edits.name || '').trim() || t.name,
    duration: t.duration, milestone: !!t.milestone,
    work: edits.work !== undefined ? (Number.isFinite(+edits.work) && +edits.work > 0 ? Math.round(+edits.work * 100) / 100 : null) : (t.work ?? null),
    notes: t.notes || '', urgency: t.urgency || 'normal',
    ...(skill ? { skill } : {}),
    ...(t.energy ? { energy: t.energy } : {}),
    ...(t.attention === 'background' ? { attention: 'background', ...(t.checkEvery ? { checkEvery: t.checkEvery } : {}) } : {}),
    ...(t.labels?.length ? { labels: [...t.labels] } : {}),
    ...(t.fromModule ? { fromModule: { ...t.fromModule } } : {}),
    calendar: { show, timeBlockIds: [...(t.calendar?.timeBlockIds || [])], ...(t.calendar?.blockHours ? { blockHours: t.calendar.blockHours } : {}), ...(t.calendar?.whole ? { whole: true } : {}) },
  };
}

/** Put a pattern task under a heading (after what is already under it), or at the end. */
function place(q, head, props, phaseId = null) {
  let at = q.tasks.length;
  let level = 1;
  if (head) {
    const hi = taskIndex(q, head.id);
    at = hi + 1 + descendants(q, hi).length;
    level = head.level + 1;
  }
  const t = insertTask(q, at, { ...props, level });
  if (!head && phaseId) t.phaseId = phaseId;
  return t;
}

/**
 * Links into the tasks that came across, from tasks that came across or were
 * already there. `map` is source task id → the task it is here; only the ones
 * in `added` are given links — a task the plan already had keeps its own.
 */
function relink(q, source, map, added = null) {
  for (const [id, t] of map) {
    if (added && !added.has(t.id)) continue;
    for (const l of getTask(source, id)?.predecessors || []) {
      const before = map.get(l.id);
      if (before && before.id !== t.id && !linkError(q, before.id, t.id)) link(q, before.id, t.id, l.type, l.lag);
    }
  }
}

const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * Where a part of a template lands in a plan that may already have it: a
 * stage by its standard stage, else by name; a group by its name.
 * { exists, head, phaseId, have } — the heading and stage it goes under, and
 * the tasks already there (a task of the same name is not added again).
 */
export function matchIn(target, g, stageSet) {
  if (g.kind === 'stage') {
    const mine = phases(target).find((ph) => (g.stageKey && stageKeyOf(stageSet, ph) === g.stageKey) || same(ph.name, g.name));
    if (mine) return { exists: true, phaseId: mine.id, head: mine.summaryId ? getTask(target, mine.summaryId) : null, have: stageTasks(target, mine.id, { archived: true }) };
  } else if (g.kind === 'group') {
    const hi = target.tasks.findIndex((t, i) => t.level === 1 && isSummary(target, i) && same(t.name, g.name) && !phases(target).some((ph) => ph.summaryId === t.id));
    if (hi >= 0) return { exists: true, phaseId: null, head: target.tasks[hi], have: descendants(target, hi).map((j) => target.tasks[j]) };
  }
  return { exists: false, phaseId: null, head: null, have: [] };
}

/** Whether a plan already has this task of a template's part (by name). */
export const hasTask = (match, name) => match.have.some((t) => same(t.name, name));

/**
 * Copy picked stages from a template into a plan. `picks` is
 * [{ id, taskIds }] — a part of the template (stageGroups) and which of its
 * tasks. Returns { stages, merged, tasks, skipped }: headings made, stages
 * the plan already had, tasks added, and tasks it already had (by name).
 */
export function addStagesFrom(target, template, picks, stageSet) {
  const groups = stageGroups(template, stageSet);
  const result = { stages: 0, merged: 0, tasks: 0, skipped: 0 };
  const map = new Map();
  const added = new Set();
  for (const pick of picks || []) {
    const g = groups.find((x) => x.id === pick.id);
    if (!g) continue;
    const want = new Set(pick.taskIds || []);
    const sources = g.taskIds.filter((id) => want.has(id)).map((id) => getTask(template, id));
    if (!sources.length) continue;

    let { head, phaseId, have, exists } = matchIn(target, g, stageSet);
    if (exists) result.merged++;
    else if (g.kind !== 'loose') {
      head = insertTask(target, target.tasks.length, { name: g.name, level: 1 });
      if (g.kind === 'stage') phaseId = setSummaryStage(target, head.id, { key: g.stageKey, name: g.name }).id;
      result.stages++;
    }
    // What the plan already has of this part stands in for the template's task, so new tasks can wait for it.
    for (const id of g.taskIds) {
      const s = getTask(template, id);
      const already = have.find((t) => same(t.name, s.name));
      if (already) map.set(id, already);
    }
    for (const s of sources) {
      if (map.has(s.id)) { result.skipped++; continue; }
      const t = place(target, head, pattern(template, s, { show: true }), phaseId);
      map.set(s.id, t);
      added.add(t.id);
      result.tasks++;
    }
  }
  relink(target, template, map, added);
  return result;
}

/**
 * A template made from a plan. `spec` is what the wizard decided:
 *   { name, description?, groups: [{ id, include, name?, stageKey? }],   — in the order wanted
 *     tasks: { [taskId]: { include?: false, name?, work?, skill? } } }
 * A part with no task kept is left out. Returns the new plan (`template: true`).
 */
export function templateFrom(p, spec, stageSet) {
  const name = String(spec?.name || '').trim();
  if (!name) throw new Error('A template needs a name.');
  const q = createProject(name, p.start);
  q.template = true;
  q.description = String(spec.description || '');
  q.resources = [];
  q.timesheets = [];
  // The plan's own settings are part of its shape.
  for (const key of ['calendar', 'stages', 'timeBlocks', 'agenda', 'fields', 'energy', 'skill', 'processes', 'workspaceId', 'folderId', 'autoAdvance']) {
    if (p[key] !== undefined) q[key] = JSON.parse(JSON.stringify(p[key]));
  }
  const groups = stageGroups(p, stageSet);
  const edits = spec.tasks || {};
  const map = new Map();
  for (const choice of spec.groups || []) {
    const g = groups.find((x) => x.id === choice.id);
    if (!g || !choice.include) continue;
    const sources = g.taskIds.filter((id) => edits[id]?.include !== false).map((id) => getTask(p, id));
    if (!sources.length) continue;
    let head = null;
    if (g.kind !== 'loose') {
      head = insertTask(q, q.tasks.length, { name: String(choice.name || '').trim() || g.name, level: 1, calendar: { show: false, timeBlockIds: [] } });
      if (choice.stageKey && stageSet.some((s) => s.key === choice.stageKey)) setSummaryStage(q, head.id, { key: choice.stageKey });
    }
    for (const s of sources) map.set(s.id, place(q, head, pattern(p, s, { show: false, edits: edits[s.id] || {} })));
  }
  relink(q, p, map);
  // A template starts its own history.
  for (const t of q.tasks) delete t.activity;
  q.currentPhaseId = null;
  for (const ph of phases(q)) { ph.deadline = null; delete ph.status; }
  return q;
}

