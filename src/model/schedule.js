// The scheduling engine: critical path method over the working calendar.
//
// Forward pass (early dates) in dependency order, backward pass (late dates)
// in reverse, then slack and the critical path. Summary tasks take their dates
// from their children; a summary's own predecessors and successors bound every
// task under it. Nothing here is stored: it is recomputed from the plan.

import { makeCalendar, toDay, fromDay } from './calendar.js';
import { dependencyGraph, topoOrder, isSummary, childrenOf, ancestors, wbsCodes, parentIndex, spentOn } from './model.js';

/**
 * @returns {{ tasks: Object<string, TaskInfo>, order: string[], start, finish, duration, work, cost, percent, cyclic: string[] }}
 * TaskInfo: { id, index, wbs, level, summary, parentId, children, start, finish, es, ef, ls, lf, slack, critical,
 *             duration, span, percent, work, cost, milestone, startIso, finishIso, deadlineMissed }
 */
export function computeSchedule(p) {
  const cal = makeCalendar(p.calendar);
  const hpd = cal.hoursPerDay;
  const projStart = cal.next(toDay(p.start));
  const wbs = wbsCodes(p);
  const infos = {};
  const byId = new Map(p.tasks.map((t, i) => [t.id, i]));
  const resById = new Map(p.resources.map((r) => [r.id, r]));

  p.tasks.forEach((t, i) => {
    const summary = isSummary(p, i);
    const dur = summary ? 0 : Math.max(0, Number(t.duration) || 0);
    infos[t.id] = {
      id: t.id, index: i + 1, wbs: wbs[i], level: t.level, summary, parentId: parentIndex(p, i) >= 0 ? p.tasks[parentIndex(p, i)].id : null,
      children: summary ? childrenOf(p, i).map((j) => p.tasks[j].id) : [],
      milestone: !summary && (t.milestone || dur === 0),
      duration: dur, span: summary ? 0 : Math.max(0, Math.ceil(dur) - 1),
      start: projStart, finish: projStart, ls: projStart, lf: projStart, slack: 0, critical: false,
      percent: t.percent || 0, work: 0, cost: 0, spent: 0, remaining: 0, deadlineMissed: false, cyclic: false,
    };
  });

  const deps = dependencyGraph(p);
  const { order, cyclic } = topoOrder(p, deps);
  for (const id of cyclic) infos[id].cyclic = true;

  // Every link that binds a task: its own, plus those of its ancestors.
  const boundBy = (id) => {
    const i = byId.get(id);
    const links = [...p.tasks[i].predecessors];
    for (const a of ancestors(p, i)) links.push(...p.tasks[a].predecessors);
    return links.filter((l) => infos[l.id] && !infos[l.id].cyclic);
  };
  // Successor links, keyed by predecessor id, with the successor's id.
  const succs = new Map(p.tasks.map((t) => [t.id, []]));
  for (const t of p.tasks) for (const l of t.predecessors) if (succs.has(l.id)) succs.get(l.id).push({ id: t.id, type: l.type, lag: l.lag || 0 });
  const boundAfter = (id) => {
    const i = byId.get(id);
    const links = [...succs.get(id)];
    for (const a of ancestors(p, i)) links.push(...succs.get(p.tasks[a].id));
    return links.filter((l) => infos[l.id] && !infos[l.id].cyclic);
  };

  // ---- forward pass
  for (const id of order) {
    const info = infos[id];
    const t = p.tasks[byId.get(id)];
    if (info.summary) {
      const kids = info.children.map((c) => infos[c]);
      info.start = Math.min(...kids.map((k) => k.start));
      info.finish = Math.max(...kids.map((k) => k.finish));
      info.duration = cal.between(info.start, info.finish);
      continue;
    }
    let es = projStart;
    for (const l of boundBy(id)) {
      const ps = infos[l.id].start, pf = infos[l.id].finish, lag = l.lag || 0;
      let cand;
      if (l.type === 'SS') cand = cal.add(ps, lag);
      else if (l.type === 'FF') cand = cal.add(cal.add(pf, lag), -info.span);
      else if (l.type === 'SF') cand = cal.add(cal.add(ps, lag), -info.span);
      else cand = cal.add(pf, 1 + lag);
      if (cand > es) es = cand;
    }
    es = cal.next(es);
    const c = t.constraint || { type: 'ASAP' };
    const cdate = c.date ? toDay(c.date) : null;
    if (cdate !== null) {
      if (c.type === 'SNET') es = Math.max(es, cal.next(cdate));
      else if (c.type === 'MSO') es = cal.next(cdate);
      else if (c.type === 'FNET') es = Math.max(es, cal.add(cal.prev(cdate), -info.span));
      else if (c.type === 'MFO') es = cal.add(cal.prev(cdate), -info.span);
    }
    info.start = es;
    info.finish = cal.add(es, info.span);
  }

  const all = Object.values(infos).filter((i) => !i.cyclic);
  const projFinish = all.length ? Math.max(...all.map((i) => i.finish)) : projStart;

  // ---- backward pass (leaves in reverse dependency order; summaries from their children after)
  for (const id of [...order].reverse()) {
    const info = infos[id];
    if (info.summary) continue;
    const t = p.tasks[byId.get(id)];
    let lf = projFinish;
    for (const l of boundAfter(id)) {
      const s = infos[l.id], lag = l.lag || 0;
      let cand;
      if (l.type === 'SS') cand = cal.add(cal.add(s.ls, -lag), info.span);
      else if (l.type === 'FF') cand = cal.add(s.lf, -lag);
      else if (l.type === 'SF') cand = cal.add(cal.add(s.lf, -lag), info.span);
      else cand = cal.add(s.ls, -(1 + lag));
      if (cand < lf) lf = cand;
    }
    const c = t.constraint || { type: 'ASAP' };
    const cdate = c.date ? toDay(c.date) : null;
    if (cdate !== null) {
      if (c.type === 'FNLT') lf = Math.min(lf, cal.prev(cdate));
      else if (c.type === 'MFO') lf = cal.prev(cdate);
      else if (c.type === 'SNLT') lf = Math.min(lf, cal.add(cal.prev(cdate), info.span));
      else if (c.type === 'MSO') lf = cal.add(cal.next(cdate), info.span);
    }
    if (t.deadline) {
      const d = toDay(t.deadline);
      lf = Math.min(lf, cal.prev(d));
      info.deadlineMissed = info.finish > d;
    }
    info.lf = lf;
    info.ls = cal.add(lf, -info.span);
    info.slack = cal.distance(info.finish, lf);
    info.critical = info.slack <= 0;
  }
  // Summaries: deepest first, so a summary's children (which may be summaries) are done.
  for (const info of [...all].filter((i) => i.summary).sort((a, b) => b.level - a.level)) {
    const kids = info.children.map((c) => infos[c]);
    info.ls = Math.min(...kids.map((k) => k.ls));
    info.lf = Math.max(...kids.map((k) => k.lf));
    info.slack = Math.min(...kids.map((k) => k.slack));
    info.critical = kids.some((k) => k.critical);
    const t = p.tasks[byId.get(info.id)];
    if (t.deadline) info.deadlineMissed = info.finish > toDay(t.deadline);
  }

  // ---- work, cost, progress (leaves, then rolled up)
  for (const info of all) {
    if (info.summary) continue;
    const t = p.tasks[byId.get(info.id)];
    let work = 0, cost = t.fixedCost || 0;
    for (const a of t.assignments) {
      const r = resById.get(a.resourceId);
      if (!r) continue;
      if (r.type === 'work') { const h = info.duration * hpd * (a.units || 0); work += h; cost += h * (r.rate || 0); }
      else if (r.type === 'material') cost += (a.units || 0) * (r.rate || 0);
      else cost += a.units || 0; // a cost resource: units is the amount
    }
    info.work = work;
    info.cost = cost;
    info.spent = spentOn(p, info.id);
    // What the plan still expects, after what has been logged. Never negative:
    // overrunning an estimate means nothing is left, not that time is owed back.
    info.remaining = Math.max(0, work - info.spent);
  }
  for (const info of [...all].filter((i) => i.summary).sort((a, b) => b.level - a.level)) {
    const kids = info.children.map((c) => infos[c]);
    const t = p.tasks[byId.get(info.id)];
    info.work = kids.reduce((s, k) => s + k.work, 0);
    info.cost = kids.reduce((s, k) => s + k.cost, 0) + (t.fixedCost || 0);
    info.spent = kids.reduce((s, k) => s + k.spent, 0) + spentOn(p, info.id);
    info.remaining = Math.max(0, info.work - info.spent);
    const wsum = kids.reduce((s, k) => s + Math.max(k.duration, 0.01), 0);
    info.percent = Math.round(kids.reduce((s, k) => s + k.percent * Math.max(k.duration, 0.01), 0) / wsum) || 0;
    info.duration = cal.between(info.start, info.finish);
  }
  for (const info of Object.values(infos)) { info.startIso = fromDay(info.start); info.finishIso = fromDay(info.finish); }

  const tops = all.filter((i) => i.level === 1);
  const leaves = all.filter((i) => !i.summary);
  const wsum = leaves.reduce((s, k) => s + Math.max(k.duration, 0.01), 0);
  return {
    tasks: infos, order: p.tasks.map((t) => t.id), cyclic,
    start: projStart, finish: projFinish, startIso: fromDay(projStart), finishIso: fromDay(projFinish),
    duration: all.length ? cal.between(projStart, projFinish) : 0,
    work: tops.reduce((s, k) => s + k.work, 0), cost: tops.reduce((s, k) => s + k.cost, 0),
    spent: (p.timesheets || []).reduce((s, x) => s + (Number(x.hours) || 0), 0),
    percent: leaves.length ? Math.round(leaves.reduce((s, k) => s + k.percent * Math.max(k.duration, 0.01), 0) / wsum) : 0,
    criticalCount: leaves.filter((l) => l.critical).length,
  };
}

/**
 * Hours a resource works per day, over the schedule. Returns
 * Map<resourceId, Map<day, [{ taskId, hours, units }]>> — the basis of the
 * usage view and the over-allocation check.
 */
export function resourceLoad(p, sched) {
  const cal = makeCalendar(p.calendar);
  const load = new Map(p.resources.map((r) => [r.id, new Map()]));
  for (const t of p.tasks) {
    const info = sched.tasks[t.id];
    if (!info || info.summary || info.cyclic) continue;
    for (const a of t.assignments) {
      const days = load.get(a.resourceId);
      if (!days) continue;
      const r = p.resources.find((x) => x.id === a.resourceId);
      if (r.type !== 'work') continue;
      const perDay = info.milestone ? 0 : cal.hoursPerDay * (a.units || 0);
      for (let d = info.start; d <= info.finish; d++) {
        if (!cal.isWorking(d)) continue;
        if (!days.has(d)) days.set(d, []);
        days.get(d).push({ taskId: t.id, hours: perDay, units: a.units || 0 });
      }
    }
  }
  return load;
}

/** Longest-path rank of every leaf task, for the network diagram. */
export function networkRanks(p, sched) {
  const rank = new Map();
  const { order } = topoOrder(p);
  const byId = new Map(p.tasks.map((t, i) => [t.id, i]));
  for (const id of order) {
    const i = byId.get(id);
    const t = p.tasks[i];
    const links = [...t.predecessors];
    for (const a of ancestors(p, i)) links.push(...p.tasks[a].predecessors);
    let r = 0;
    for (const l of links) {
      const pi = sched.tasks[l.id];
      if (!pi) continue;
      // a link from a summary stands for its last leaf
      const pr = pi.summary ? Math.max(0, ...descendantLeaves(p, sched, l.id).map((x) => rank.get(x) ?? 0)) : (rank.get(l.id) ?? 0);
      r = Math.max(r, pr + 1);
    }
    rank.set(id, r);
  }
  return rank;
}
function descendantLeaves(p, sched, id) {
  const out = [];
  const walk = (x) => { const i = sched.tasks[x]; if (!i) return; if (i.summary) i.children.forEach(walk); else out.push(x); };
  walk(id);
  return out;
}
