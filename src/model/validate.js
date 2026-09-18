// Live checks over the plan and its schedule. Each issue: { code, level, text, taskId?, resourceId? }.

import { computeSchedule, resourceLoad } from './schedule.js';
import { fromDay, toDay, formatDate, today } from './calendar.js';

export const RULES = {
  'cycle':            ['error',   'A chain of links leads back to where it started; the tasks in it cannot be scheduled.'],
  'negative-slack':   ['error',   'A constraint or deadline is earlier than the links allow: the task cannot make its late finish.'],
  'deadline-missed':  ['error',   'The task finishes after its deadline.'],
  'overallocated':    ['warning', 'A resource is assigned more than its maximum units on the same day.'],
  'no-predecessor':   ['warning', 'A task with no predecessor starts at the project start; it may be missing a link.'],
  'no-successor':     ['info',    'Nothing depends on this task; it does not drive the finish.'],
  'unassigned':       ['info',    'The task has no resource.'],
  'summary-assigned': ['warning', 'A resource is assigned to a summary task; assign work to its subtasks instead.'],
  'late':             ['warning', 'By the status date the task should have started (or finished) but has not.'],
  'empty-summary':    ['info',    'A summary task with no subtasks is just a task.'],
  'bad-date':         ['error',   'A date in the plan could not be read.'],
};

export function validate(p, sched = computeSchedule(p)) {
  const issues = [];
  const add = (code, text, extra = {}) => issues.push({ code, level: RULES[code][0], text, ...extra });
  const leaves = p.tasks.filter((t) => sched.tasks[t.id] && !sched.tasks[t.id].summary);
  const hasSucc = new Set();
  for (const t of p.tasks) for (const l of t.predecessors) hasSucc.add(l.id);
  const idx = (id) => sched.tasks[id]?.index;
  const label = (t) => `${idx(t.id)} ${t.name}`;
  const status = p.statusDate ? toDay(p.statusDate) : toDay(today());

  if (sched.cyclic.length) add('cycle', `Circular dependency among tasks ${sched.cyclic.map(idx).join(', ')}.`, { taskId: sched.cyclic[0] });

  p.tasks.forEach((t, i) => {
    const info = sched.tasks[t.id];
    if (info.cyclic) return;
    if (info.summary) {
      if (t.assignments.length) add('summary-assigned', `${label(t)} has resources assigned.`, { taskId: t.id });
    } else if (i === p.tasks.length - 1 && p.tasks.length > 1 && !hasSucc.has(t.id) && p.tasks.length === 1) {
      // single task: nothing to say
    }
    if (info.deadlineMissed) add('deadline-missed', `${label(t)} finishes ${formatDate(info.finishIso)}, after its deadline ${formatDate(t.deadline)}.`, { taskId: t.id });
    if (!info.summary && info.slack < 0) add('negative-slack', `${label(t)} has ${info.slack} days of slack.`, { taskId: t.id });
    if (t.constraint?.date && Number.isNaN(toDay(t.constraint.date))) add('bad-date', `${label(t)}: constraint date “${t.constraint.date}”.`, { taskId: t.id });
  });

  for (const t of leaves) {
    const info = sched.tasks[t.id];
    const i = info.index - 1;
    const bound = t.predecessors.length || ancestorsHavePreds(p, i);
    if (!bound && leaves.indexOf(t) > 0 && !info.milestone) add('no-predecessor', `${label(t)} has no predecessor.`, { taskId: t.id });
    if (!hasSucc.has(t.id) && !info.milestone && info.finish < sched.finish && leaves.length > 1 && !ancestorsHaveSuccs(p, i, hasSucc)) add('no-successor', `${label(t)} has no successor.`, { taskId: t.id });
    if (!t.assignments.length && !info.milestone) add('unassigned', `${label(t)} has no resource.`, { taskId: t.id });
    if (info.percent < 100 && info.finish < status) add('late', `${label(t)} should have finished by ${formatDate(fromDay(status))} (${info.percent}% done).`, { taskId: t.id });
    else if (info.percent === 0 && info.start < status) add('late', `${label(t)} should have started by ${formatDate(fromDay(status))}.`, { taskId: t.id });
  }

  const load = resourceLoad(p, sched);
  for (const r of p.resources) {
    const days = load.get(r.id);
    const over = [];
    for (const [d, items] of days) {
      const units = items.reduce((s, x) => s + x.units, 0);
      if (units > (r.maxUnits ?? 1) + 1e-9) over.push(d);
    }
    if (over.length) {
      over.sort((a, b) => a - b);
      add('overallocated', `${r.name} is over-allocated on ${over.length} day${over.length > 1 ? 's' : ''} (${formatDate(fromDay(over[0]), 'day')} – ${formatDate(fromDay(over[over.length - 1]), 'day')}).`, { resourceId: r.id, days: over });
    }
  }
  const rank = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => rank[a.level] - rank[b.level]);
}

function ancestorsHavePreds(p, i) {
  const lvl = p.tasks[i].level;
  let cur = lvl;
  for (let j = i - 1; j >= 0 && cur > 1; j--) if (p.tasks[j].level < cur) { cur = p.tasks[j].level; if (p.tasks[j].predecessors.length) return true; }
  return false;
}
function ancestorsHaveSuccs(p, i, hasSucc) {
  let cur = p.tasks[i].level;
  for (let j = i - 1; j >= 0 && cur > 1; j--) if (p.tasks[j].level < cur) { cur = p.tasks[j].level; if (hasSucc.has(p.tasks[j].id)) return true; }
  return false;
}
