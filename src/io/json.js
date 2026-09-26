// The native file: the plan as JSON. Loading repairs what it can and reports it.

import { FORMAT, VERSION, createProject, newTask, newResource, normalizeLevels, LINK_TYPES, CONSTRAINTS, RESOURCE_TYPES, DEFAULT_STAGES, OLD_DEFAULT_STAGES, newTimesheet, URGENCIES, BUFFER_CHOICES, DEFAULT_BUFFER_MINUTES, mergeSlots, cleanField, fieldValue, cleanEvent } from '../model/model.js';
import { isoValid } from '../model/calendar.js';
import { uid } from '../util.js';
import { BLOCK_CHOICES, GAP_CHOICES, LOAD_CHOICES, CAP_CHOICES, DEFAULT_AGENDA, parseTime } from '../model/agenda.js';

export const FILE_EXT = '.project.json';

export function serialize(p) {
  return JSON.stringify({ ...p, format: FORMAT, version: VERSION }, null, 2);
}

/** @returns {{ project, repairs: string[] }} */
export function parse(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error('The file is not JSON.'); }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tasks)) throw new Error('The file is not a Project Planner plan (no task list).');
  const repairs = [];
  const p = createProject(String(raw.name || 'Untitled project'), isoValid(raw.start) ? raw.start : undefined);
  // A plan written before ids existed gets one now; it keeps it from here on.
  if (typeof raw.id === 'string' && raw.id) p.id = raw.id;
  if (!isoValid(raw.start)) repairs.push('The project start date was missing or unreadable; today is used.');
  p.statusDate = isoValid(raw.statusDate) ? raw.statusDate : null;
  p.currency = typeof raw.currency === 'string' ? raw.currency : '$';
  if (raw.calendar && typeof raw.calendar === 'object') {
    const c = raw.calendar;
    p.calendar.workDays = Array.isArray(c.workDays) ? c.workDays.map(Number).filter((d) => d >= 0 && d <= 6) : p.calendar.workDays;
    p.calendar.hoursPerDay = Number(c.hoursPerDay) > 0 ? Number(c.hoursPerDay) : 8;
    p.calendar.holidays = Array.isArray(c.holidays) ? c.holidays.filter(isoValid) : [];
  }
  // Stages, when the file has them. A plan written before stages existed keeps
  // the defaults, and every task falls into them by its percent.
  if (Array.isArray(raw.stages) && raw.stages.length) {
    const seen = new Set();
    const list = raw.stages
      .filter((st) => st && typeof st === 'object' && typeof st.id === 'string' && st.id && !seen.has(st.id) && seen.add(st.id))
      .map((st) => ({ id: st.id, name: String(st.name || 'Stage'), done: !!st.done, ...(st.cancelled ? { cancelled: true } : {}) }));
    // Still the three columns every plan used to start with: those were a
    // default, not a choice, so the plan moves onto Motion's statuses. Their
    // ids are kept in the new set, so no task changes column.
    const oldDefault = list.length === OLD_DEFAULT_STAGES.length && list.every((st, i) => st.id === OLD_DEFAULT_STAGES[i][0] && st.name === OLD_DEFAULT_STAGES[i][1]);
    if (oldDefault) list.splice(0, list.length, ...DEFAULT_STAGES.map((st) => ({ ...st })));
    if (list.length) {
      if (!list.some((st) => st.done)) { list[list.length - 1].done = true; repairs.push('No stage meant “finished”; the last one now does.'); }
      p.stages = list;
    } else repairs.push('The stage list could not be read; the default columns are used.');
  }
  const stageIds = new Set(p.stages.map((st) => st.id));

  // Named time blocks: the hours of the week that are for a kind of work.
  if (Array.isArray(raw.timeBlocks) && raw.timeBlocks.length) {
    const seen = new Set();
    const list = raw.timeBlocks
      .filter((b) => b && typeof b === 'object' && typeof b.id === 'string' && b.id && !seen.has(b.id) && seen.add(b.id))
      .map((b) => ({
        id: b.id, name: String(b.name || 'Block'),
        from: parseTime(b.from) !== null ? b.from : '09:00',
        to: parseTime(b.to) !== null ? b.to : '17:00',
        days: Array.isArray(b.days) ? [...new Set(b.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : [1, 2, 3, 4, 5],
        // Ranges per day, when the block was drawn as a schedule.
        ...(Array.isArray(b.slots) && b.slots.length ? { slots: mergeSlots(b.slots.filter((r) => r && parseTime(r.from) !== null && parseTime(r.to) !== null)) } : {}),
      }))
      .filter((b) => (b.slots?.length) || (b.days.length && parseTime(b.to) > parseTime(b.from)));
    if (list.length) p.timeBlocks = list;
    else repairs.push('The time blocks could not be read; the defaults are used.');
  }
  const blockIds = new Set(p.timeBlocks.map((b) => b.id));

  // `+null` is 0 and 0 is a finite hue, so a plan with no colour of its own
  // would read as red. It has to be asked whether there is a value at all.
  p.colour = raw.colour === null || raw.colour === undefined || !Number.isFinite(+raw.colour)
    ? null : ((Math.round(+raw.colour) % 360) + 360) % 360;
  p.workspaceId = typeof raw.workspaceId === 'string' && raw.workspaceId ? raw.workspaceId : null;
  p.pinned = raw.pinned === true;
  p.template = raw.template === true;
  p.archived = raw.archived === true;
  p.archivedAt = typeof raw.archivedAt === 'string' ? raw.archivedAt : null;


  // The plan's calendar defaults, which every task inherits.
  if (raw.agenda && typeof raw.agenda === 'object') {
    const a = raw.agenda;
    p.agenda = {
      blockHours: BLOCK_CHOICES.includes(+a.blockHours) ? +a.blockHours : 1,
      timeBlockId: blockIds.has(a.timeBlockId) ? a.timeBlockId : p.timeBlocks[0].id,
      gapMinutes: GAP_CHOICES.includes(+a.gapMinutes) ? +a.gapMinutes : 0,
      assumedLoad: LOAD_CHOICES.includes(+a.assumedLoad) ? +a.assumedLoad : DEFAULT_AGENDA.assumedLoad,
      dailyCap: CAP_CHOICES.includes(+a.dailyCap) ? +a.dailyCap : DEFAULT_AGENDA.dailyCap,
    };
  }

  const resIds = new Set();
  for (const r of Array.isArray(raw.resources) ? raw.resources : []) {
    if (!r || typeof r !== 'object') continue;
    const res = newResource({
      id: String(r.id || ''), personId: typeof r.personId === 'string' && r.personId ? r.personId : null,
      name: String(r.name || 'Unnamed'), initials: String(r.initials || ''), type: RESOURCE_TYPES[r.type] ? r.type : 'work',
      maxUnits: Number.isFinite(+r.maxUnits) ? +r.maxUnits : 1, rate: Number.isFinite(+r.rate) ? +r.rate : 0, group: String(r.group || ''),
    });
    if (!res.id || resIds.has(res.id)) { res.id = newResource().id; repairs.push(`Resource “${res.name}” had no unique id; one was given.`); }
    resIds.add(res.id);
    p.resources.push(res);
  }
  const ids = new Set();
  for (const t of raw.tasks) {
    if (!t || typeof t !== 'object') continue;
    const task = newTask({
      id: String(t.id || ''), name: String(t.name ?? 'Untitled task'), level: Number(t.level) || 1,
      duration: Number.isFinite(+t.duration) && +t.duration >= 0 ? +t.duration : 1, milestone: !!t.milestone,
      // `+null` is 0, which would quietly turn "as much as the assignment says" into "no work at all".
      work: t.work !== null && t.work !== undefined && Number.isFinite(+t.work) && +t.work >= 0 ? +t.work : null,
      percent: Math.max(0, Math.min(100, Math.round(+t.percent) || 0)), notes: String(t.notes || ''), fixedCost: Number(t.fixedCost) || 0,
      deadline: isoValid(t.deadline) ? t.deadline : null,
      stageId: typeof t.stageId === 'string' && stageIds.has(t.stageId) ? t.stageId : null,
      // Checked against the plan's phases once those are read, below.
      phaseId: typeof t.phaseId === 'string' && t.phaseId ? t.phaseId : null,
      archived: t.archived === true,
      ...(t.hardDeadline === true ? { hardDeadline: true } : {}),
      // The task's history: kept as long as each line is a dated entry.
      ...(Array.isArray(t.activity) ? { activity: t.activity
        .filter((x) => x && typeof x === 'object' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(x.at)) && typeof x.kind === 'string')
        .slice(-200)
        .map((x) => Object.fromEntries(['at', 'kind', 'field', 'from', 'to', 'text'].filter((k) => x[k] !== undefined && x[k] !== null).map((k) => [k, String(x[k]).slice(0, 4000)]))) } : {}),
      ...(Array.isArray(t.labels) && t.labels.some((x) => String(x).trim()) ? { labels: [...new Set(t.labels.map((x) => String(x).trim()).filter(Boolean))] } : {}),
      ...(typeof t.doneAt === 'string' && isoValid(t.doneAt.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(t.doneAt) && Math.round(+t.percent) === 100 ? { doneAt: t.doneAt } : {}),
      urgency: URGENCIES[t.urgency] ? t.urgency : 'normal',
      calendar: t.calendar && typeof t.calendar === 'object'
        ? { show: !!t.calendar.show,
            timeBlockIds: (Array.isArray(t.calendar.timeBlockIds)
              ? t.calendar.timeBlockIds
              : (t.calendar.timeBlockId ? [t.calendar.timeBlockId] : [])).filter((id) => blockIds.has(id)),
            ...(BLOCK_CHOICES.includes(+t.calendar.blockHours) ? { blockHours: +t.calendar.blockHours } : {}),
            ...(t.calendar.whole === true ? { whole: true } : {}),
            ...(parseTime(t.calendar.from) !== null ? { from: t.calendar.from } : {}),
            ...(parseTime(t.calendar.to) !== null ? { to: t.calendar.to } : {}),
            // Only well-formed pins come back; a malformed one is not a
            // decision anyone made, and keeping it would be a ghost.
            ...(Array.isArray(t.calendar.pins) && t.calendar.pins.length ? { pins: t.calendar.pins
              .filter((q) => q && /^\d{4}-\d{2}-\d{2}$/.test(String(q.day)) && Number.isFinite(+q.start) && Number.isFinite(+q.minutes)
                && +q.start >= 0 && +q.minutes >= 5 && +q.start + +q.minutes <= 24 * 60)
              .map((q) => ({ day: q.day, start: Math.round(+q.start), minutes: Math.round(+q.minutes), ...(q.live ? { live: true } : {}) })) } : {}) }
        : { show: false, timeBlockIds: [] },
      constraint: t.constraint && CONSTRAINTS[t.constraint.type] ? { type: t.constraint.type, date: isoValid(t.constraint.date) ? t.constraint.date : null } : { type: 'ASAP', date: null },
      predecessors: Array.isArray(t.predecessors) ? t.predecessors.filter((l) => l && l.id).map((l) => ({ id: String(l.id), type: LINK_TYPES[l.type] ? l.type : 'FS', lag: Number(l.lag) || 0 })) : [],
      assignments: Array.isArray(t.assignments) ? t.assignments.filter((a) => a && resIds.has(a.resourceId)).map((a) => ({ resourceId: a.resourceId, units: Number.isFinite(+a.units) ? +a.units : 1 })) : [],
    });
    if (task.constraint.type !== 'ASAP' && !task.constraint.date && CONSTRAINTS[task.constraint.type].dated) task.constraint = { type: 'ASAP', date: null };
    if (task.milestone) task.duration = 0;
    if (!task.id || ids.has(task.id)) { task.id = newTask().id; repairs.push(`Task “${task.name}” had no unique id; one was given.`); }
    ids.add(task.id);
    p.tasks.push(task);
  }
  for (const t of p.tasks) {
    const before = t.predecessors.length;
    t.predecessors = t.predecessors.filter((l) => ids.has(l.id) && l.id !== t.id);
    if (t.predecessors.length !== before) repairs.push(`Task “${t.name}”: ${before - t.predecessors.length} link(s) to missing tasks were dropped.`);
  }
  // Timesheet lines, once the tasks and resources they point at are known.
  const taskIds = new Set(p.tasks.map((t) => t.id));
  if (Array.isArray(raw.timesheets)) {
    const before = raw.timesheets.length;
    p.timesheets = raw.timesheets
      .filter((x) => x && typeof x === 'object' && taskIds.has(x.taskId) && Number.isFinite(+x.hours) && +x.hours >= 0)
      .map((x) => ({
        id: typeof x.id === 'string' && x.id ? x.id : newTimesheet().id,
        taskId: x.taskId, resourceId: resIds.has(x.resourceId) ? x.resourceId : null,
        date: isoValid(x.date) ? x.date : null, hours: Math.round(+x.hours * 100) / 100, note: String(x.note || ''),
        // The minute the work began, when it was logged by stopping a started task.
        ...(Number.isInteger(+x.start) && x.start !== null && +x.start >= 0 && +x.start < 24 * 60 ? { start: +x.start } : {}),
      }));
    if (p.timesheets.length !== before) repairs.push(`${before - p.timesheets.length} timesheet line(s) pointing at missing tasks were dropped.`);
  }

  // Connected calendars, and the events last read from them.
  if (Array.isArray(raw.feeds)) {
    p.feeds = raw.feeds
      .filter((f) => f && typeof f === 'object' && typeof f.url === 'string' && /^https?:\/\//i.test(f.url))
      .map((f) => ({
        id: typeof f.id === 'string' && f.id ? f.id : `feed_${Math.random().toString(36).slice(2, 10)}`,
        name: String(f.name || 'My calendar'), url: f.url,
        provider: ['google', 'outlook', 'ics'].includes(f.provider) ? f.provider : 'ics',
        resourceId: resIds.has(f.resourceId) ? f.resourceId : null,
        fetchedAt: Number.isFinite(+f.fetchedAt) ? +f.fetchedAt : null,
        bufferMinutes: BUFFER_CHOICES.includes(+f.bufferMinutes) ? +f.bufferMinutes : DEFAULT_BUFFER_MINUTES,
        events: Array.isArray(f.events) ? f.events
          .filter((e) => e && Number.isFinite(+e.start) && Number.isFinite(+e.end) && +e.end > +e.start)
          .map((e) => ({ uid: String(e.uid || ''), title: String(e.title || '(no title)'), start: +e.start, end: +e.end, allDay: !!e.allDay,
            ...(typeof e.location === 'string' && e.location.trim() ? { location: e.location.trim() } : {}),
            ...(typeof e.description === 'string' && e.description.trim() ? { description: e.description.slice(0, 2000) } : {}) }))
          : [],
      }));
  }

  // The phase the plan is in, once the tasks it might name are known.
  // Phases are named on the plan. A file written before that carries a task id
  // in currentPhaseId, which means nothing now, so it is dropped rather than
  // silently gating the calendar on something that is not a phase.
  p.phases = (Array.isArray(raw.phases) ? raw.phases : [])
    .filter((ph) => ph && typeof ph === 'object' && String(ph.name || '').trim())
    .map((ph) => ({ id: typeof ph.id === 'string' && ph.id ? ph.id : uid('ph'), name: String(ph.name).trim(), deadline: isoValid(ph.deadline) ? ph.deadline : null }));
  const phaseIds = new Set(p.phases.map((ph) => ph.id));
  for (const t of p.tasks) if (t.phaseId && !phaseIds.has(t.phaseId)) t.phaseId = null;
  p.currentPhaseId = typeof raw.currentPhaseId === 'string' && phaseIds.has(raw.currentPhaseId) ? raw.currentPhaseId : null;

  // Custom fields, then each task's values checked against them: a value for
  // a field that is gone, or that no longer fits it, is dropped.
  const seenFields = new Set();
  p.fields = (Array.isArray(raw.fields) ? raw.fields : []).map(cleanField)
    .filter((f) => f && !seenFields.has(f.id) && seenFields.add(f.id));
  const rawTasks = new Map(raw.tasks.filter((t) => t && typeof t === 'object').map((t) => [String(t.id || ''), t]));
  for (const t of p.tasks) {
    const values = rawTasks.get(t.id)?.fields;
    if (!values || typeof values !== 'object') continue;
    const kept = {};
    for (const f of p.fields) {
      const v = fieldValue(p, f, values[f.id]);
      if (v !== null) kept[f.id] = v;
    }
    if (Object.keys(kept).length) t.fields = kept;
  }

  p.events = (Array.isArray(raw.events) ? raw.events : []).map((e) => cleanEvent(p, e)).filter(Boolean);

  repairs.push(...normalizeLevels(p));
  return { project: p, repairs };
}
