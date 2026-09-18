// Microsoft Project XML (MSPDI) interchange. Project, ProjectLibre and most
// planners read and write it. Export writes what they need to rebuild the
// plan; import takes tasks, outline, links, resources and assignments and
// leaves the rest (baselines, custom fields, timephased data) behind.

import { escapeXml, parseXml, child, childText, children } from '../util.js';
import { createProject, newTask, newResource, normalizeLevels, LINK_TYPES, CONSTRAINTS } from '../model/model.js';
import { isoValid, weekday } from '../model/calendar.js';

const LINK_CODE = { FF: 0, FS: 1, SF: 2, SS: 3 };
const LINK_FROM = { 0: 'FF', 1: 'FS', 2: 'SF', 3: 'SS' };
const CONSTRAINT_CODE = { ASAP: 0, ALAP: 1, MSO: 2, MFO: 3, SNET: 4, SNLT: 5, FNET: 6, FNLT: 7 };
const CONSTRAINT_FROM = Object.fromEntries(Object.entries(CONSTRAINT_CODE).map(([k, v]) => [v, k]));
const RESOURCE_CODE = { material: 0, work: 1, cost: 2 };
const RESOURCE_FROM = { 0: 'material', 1: 'work', 2: 'cost' };

const tag = (name, value) => (value === null || value === undefined || value === '' ? '' : `<${name}>${escapeXml(value)}</${name}>`);
const startOf = (iso) => `${iso}T08:00:00`;
const finishOf = (iso) => `${iso}T17:00:00`;
const hours = (days, hpd) => `PT${Math.round(days * hpd)}H0M0S`;

export function exportMspdi(p, sched) {
  const hpd = p.calendar.hoursPerDay || 8;
  const uidOf = new Map(p.tasks.map((t, i) => [t.id, i + 1]));
  const ruid = new Map(p.resources.map((r, i) => [r.id, i + 1]));
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  out.push('<Project xmlns="http://schemas.microsoft.com/project">');
  out.push(tag('SaveVersion', 14), tag('Name', p.name), tag('Title', p.name), tag('Author', 'Project Planner'), tag('CreationDate', startOf(sched.startIso)));
  out.push(tag('ScheduleFromStart', 1), tag('StartDate', startOf(sched.startIso)), tag('FinishDate', finishOf(sched.finishIso)));
  if (p.statusDate) out.push(tag('StatusDate', startOf(p.statusDate)));
  out.push(tag('CurrencySymbol', p.currency), tag('CurrencySymbolPosition', 0), tag('CalendarUID', 1));
  out.push(tag('DefaultStartTime', '08:00:00'), tag('DefaultFinishTime', '17:00:00'), tag('MinutesPerDay', hpd * 60), tag('MinutesPerWeek', hpd * 60 * (p.calendar.workDays.length || 5)), tag('DaysPerMonth', 20));
  out.push(tag('DurationFormat', 7), tag('WorkFormat', 2), tag('NewTasksAreManual', 0), tag('CriticalSlackLimit', 0));

  // The calendar: weekdays, then holidays as non-working exceptions.
  out.push('<Calendars><Calendar>', tag('UID', 1), tag('Name', 'Standard'), tag('IsBaseCalendar', 1), tag('BaseCalendarUID', -1), '<WeekDays>');
  for (let d = 0; d < 7; d++) {
    const working = p.calendar.workDays.includes(d);
    out.push('<WeekDay>', tag('DayType', d + 1), tag('DayWorking', working ? 1 : 0));
    if (working) out.push('<WorkingTimes><WorkingTime><FromTime>08:00:00</FromTime><ToTime>12:00:00</ToTime></WorkingTime><WorkingTime><FromTime>13:00:00</FromTime><ToTime>17:00:00</ToTime></WorkingTime></WorkingTimes>');
    out.push('</WeekDay>');
  }
  for (const h of p.calendar.holidays) {
    out.push('<WeekDay>', tag('DayType', 0), tag('DayWorking', 0), `<TimePeriod><FromDate>${h}T00:00:00</FromDate><ToDate>${h}T23:59:00</ToDate></TimePeriod>`, '</WeekDay>');
  }
  out.push('</WeekDays></Calendar></Calendars>');

  out.push('<Tasks>');
  // Task 0 is the project summary, as Project itself writes it.
  out.push('<Task>', tag('UID', 0), tag('ID', 0), tag('Name', p.name), tag('Type', 1), tag('IsNull', 0), tag('OutlineNumber', 0), tag('OutlineLevel', 0),
    tag('Start', startOf(sched.startIso)), tag('Finish', finishOf(sched.finishIso)), tag('Duration', hours(sched.duration, hpd)), tag('DurationFormat', 7),
    tag('Summary', 1), tag('PercentComplete', sched.percent), tag('Work', hours(sched.work / hpd, hpd)), tag('Cost', Math.round(sched.cost * 100)), '</Task>');
  p.tasks.forEach((t, i) => {
    const s = sched.tasks[t.id];
    out.push('<Task>', tag('UID', i + 1), tag('ID', i + 1), tag('Name', t.name), tag('Type', 0), tag('IsNull', 0), tag('CreateDate', startOf(sched.startIso)),
      tag('WBS', s.wbs), tag('OutlineNumber', s.wbs), tag('OutlineLevel', t.level), tag('Priority', 500),
      tag('Start', startOf(s.startIso)), tag('Finish', finishOf(s.finishIso)), tag('Duration', hours(s.duration, hpd)), tag('DurationFormat', 7),
      tag('Work', hours(s.work / hpd, hpd)), tag('ManualStart', ''), tag('Manual', 0),
      tag('Milestone', s.milestone ? 1 : 0), tag('Summary', s.summary ? 1 : 0), tag('Critical', s.critical ? 1 : 0), tag('IsSubproject', 0),
      tag('ConstraintType', CONSTRAINT_CODE[t.constraint?.type] ?? 0), t.constraint?.date ? tag('ConstraintDate', startOf(t.constraint.date)) : '',
      t.deadline ? tag('Deadline', finishOf(t.deadline)) : '',
      tag('PercentComplete', s.percent), tag('PercentWorkComplete', s.percent), tag('FixedCost', t.fixedCost || 0), tag('Cost', Math.round(s.cost * 100)),
      tag('TotalSlack', s.summary ? 0 : s.slack * hpd * 60 * 10), tag('EarlyStart', startOf(s.startIso)), tag('EarlyFinish', finishOf(s.finishIso)),
      tag('LateStart', startOf(fromDayIso(s.ls))), tag('LateFinish', finishOf(fromDayIso(s.lf))),
      tag('Notes', t.notes), tag('Active', 1));
    for (const l of t.predecessors) {
      if (!uidOf.has(l.id)) continue;
      out.push('<PredecessorLink>', tag('PredecessorUID', uidOf.get(l.id)), tag('Type', LINK_CODE[l.type] ?? 1), tag('CrossProject', 0), tag('LinkLag', Math.round((l.lag || 0) * hpd * 60 * 10)), tag('LagFormat', 7), '</PredecessorLink>');
    }
    out.push('</Task>');
  });
  out.push('</Tasks>');

  out.push('<Resources>');
  p.resources.forEach((r, i) => {
    out.push('<Resource>', tag('UID', i + 1), tag('ID', i + 1), tag('Name', r.name), tag('Type', RESOURCE_CODE[r.type] ?? 1), tag('IsNull', 0), tag('Initials', r.initials),
      tag('Group', r.group), tag('MaxUnits', r.maxUnits ?? 1), tag('StandardRate', r.rate || 0), tag('StandardRateFormat', 2), tag('OvertimeRate', 0), tag('CostPerUse', 0),
      tag('CalendarUID', 1), tag('Active', 1), '</Resource>');
  });
  out.push('</Resources>');

  out.push('<Assignments>');
  let auid = 1;
  p.tasks.forEach((t) => {
    const s = sched.tasks[t.id];
    for (const a of t.assignments) {
      if (!ruid.has(a.resourceId)) continue;
      const r = p.resources.find((x) => x.id === a.resourceId);
      const work = r.type === 'work' ? s.duration * (a.units || 0) : 0;
      out.push('<Assignment>', tag('UID', auid++), tag('TaskUID', uidOf.get(t.id)), tag('ResourceUID', ruid.get(a.resourceId)), tag('Units', a.units ?? 1),
        tag('Start', startOf(s.startIso)), tag('Finish', finishOf(s.finishIso)), tag('Work', hours(work, hpd)), tag('PercentWorkComplete', s.percent), '</Assignment>');
    }
  });
  out.push('</Assignments>');
  out.push('</Project>');
  return out.join('\n');
}
const fromDayIso = (n) => new Date(n * 86400000).toISOString().slice(0, 10);

/** PT40H0M0S → hours; also PT2400M, P5D. */
export function parseIsoDuration(s) {
  const m = String(s || '').match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return null;
  return (+m[1] || 0) * 24 + (+m[2] || 0) + (+m[3] || 0) / 60 + (+m[4] || 0) / 3600;
}
const dateOf = (s) => (s && isoValid(s.slice(0, 10)) ? s.slice(0, 10) : null);

/** @returns {{ project, report: { tasks, resources, links, skipped: string[] } }} */
export function importMspdi(text) {
  const root = parseXml(text);
  if (root.local !== 'Project') throw new Error('This XML is not a Microsoft Project file (no <Project> root).');
  const hpd = Math.max(1, Math.round((+childText(root, 'MinutesPerDay', 480) || 480) / 60));
  // MPXJ puts the file name in <Name>; a title, when there is one, reads better.
  const rawName = childText(root, 'Name'), title = childText(root, 'Title');
  const name = (/\.(xml|mpp|mpt|mpx|xer)$/i.test(rawName) ? (title || rawName.replace(/\.[^.]+$/, '')) : rawName) || title || 'Imported project';
  const p = createProject(name, dateOf(childText(root, 'StartDate')) || undefined);
  p.calendar.hoursPerDay = hpd;
  p.statusDate = dateOf(childText(root, 'StatusDate'));
  const cur = childText(root, 'CurrencySymbol');
  if (cur) p.currency = cur;
  const skipped = [];

  // Calendar: the base calendar's weekdays and its dated exceptions.
  const calId = childText(root, 'CalendarUID', '1');
  const cals = children(child(root, 'Calendars') || { children: [] }, 'Calendar');
  const cal = cals.find((c) => childText(c, 'UID') === calId) || cals[0];
  if (cal) {
    const workDays = [];
    const holidays = [];
    for (const wd of children(child(cal, 'WeekDays') || { children: [] }, 'WeekDay')) {
      const type = +childText(wd, 'DayType');
      const working = childText(wd, 'DayWorking') === '1';
      if (type >= 1 && type <= 7) { if (working) workDays.push(type - 1); }
      else if (type === 0 && !working) {
        const tp = child(wd, 'TimePeriod');
        const from = dateOf(childText(tp || {}, 'FromDate')), to = dateOf(childText(tp || {}, 'ToDate')) || from;
        if (from) { let d = new Date(from); const end = new Date(to); while (d <= end && holidays.length < 400) { holidays.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86400000); } }
      }
    }
    for (const ex of children(child(cal, 'Exceptions') || { children: [] }, 'Exception')) {
      if (childText(ex, 'DayWorking') === '1') continue;
      const tp = child(ex, 'TimePeriod');
      const from = dateOf(childText(tp || {}, 'FromDate')), to = dateOf(childText(tp || {}, 'ToDate')) || from;
      if (from) { let d = new Date(from); const end = new Date(to); while (d <= end && holidays.length < 400) { holidays.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86400000); } }
    }
    if (workDays.length) p.calendar.workDays = workDays;
    p.calendar.holidays = holidays;
  }

  const rById = new Map();
  for (const r of children(child(root, 'Resources') || { children: [] }, 'Resource')) {
    if (childText(r, 'IsNull') === '1') continue;
    const uid = childText(r, 'UID');
    const name = childText(r, 'Name');
    if (uid === '0' || !name) continue; // the unassigned pseudo-resource
    const res = newResource({ name, initials: childText(r, 'Initials'), type: RESOURCE_FROM[+childText(r, 'Type', '1')] || 'work',
      maxUnits: +childText(r, 'MaxUnits', '1') || 1, rate: +childText(r, 'StandardRate', '0') || 0, group: childText(r, 'Group') });
    rById.set(uid, res);
    p.resources.push(res);
  }

  const tById = new Map();
  const links = [];
  for (const x of children(child(root, 'Tasks') || { children: [] }, 'Task')) {
    if (childText(x, 'IsNull') === '1') continue;
    const uid = childText(x, 'UID');
    const level = +childText(x, 'OutlineLevel', '1');
    if (uid === '0' || level === 0) continue; // the project summary task
    const hrs = parseIsoDuration(childText(x, 'Duration')) ?? hpd;
    const t = newTask({
      name: childText(x, 'Name') || 'Untitled task', level: Math.max(1, level), duration: Math.round((hrs / hpd) * 100) / 100,
      milestone: childText(x, 'Milestone') === '1', percent: Math.max(0, Math.min(100, Math.round(+childText(x, 'PercentComplete', '0')) || 0)),
      notes: childText(x, 'Notes'), fixedCost: +childText(x, 'FixedCost', '0') || 0, deadline: dateOf(childText(x, 'Deadline')),
    });
    if (t.milestone) t.duration = 0;
    const ctype = CONSTRAINT_FROM[+childText(x, 'ConstraintType', '0')] || 'ASAP';
    const cdate = dateOf(childText(x, 'ConstraintDate'));
    t.constraint = CONSTRAINTS[ctype] && (cdate || !CONSTRAINTS[ctype].dated) ? { type: ctype, date: CONSTRAINTS[ctype].dated ? cdate : null } : { type: 'ASAP', date: null };
    if (ctype === 'ALAP') skipped.push(`Task “${t.name}”: As Late As Possible is scheduled as soon as possible here.`);
    // Manually scheduled tasks keep their date as a Start No Earlier Than.
    if (childText(x, 'Manual') === '1' && t.constraint.type === 'ASAP') { const ms = dateOf(childText(x, 'ManualStart') || childText(x, 'Start')); if (ms) t.constraint = { type: 'SNET', date: ms }; }
    for (const l of children(x, 'PredecessorLink')) {
      const lagTenths = +childText(l, 'LinkLag', '0') || 0;
      links.push({ to: t, from: childText(l, 'PredecessorUID'), type: LINK_FROM[+childText(l, 'Type', '1')] || 'FS', lag: Math.round((lagTenths / 10 / 60 / hpd) * 100) / 100 });
    }
    tById.set(uid, t);
    p.tasks.push(t);
  }
  // Summary tasks in Project carry the rolled-up duration; here a summary's duration is computed.
  normalizeLevels(p);
  let linked = 0;
  for (const l of links) {
    const from = tById.get(l.from);
    if (!from) { skipped.push(`Task “${l.to.name}”: a link to a task that was not imported.`); continue; }
    if (!LINK_TYPES[l.type]) continue;
    l.to.predecessors.push({ id: from.id, type: l.type, lag: l.lag });
    linked++;
  }
  for (const a of children(child(root, 'Assignments') || { children: [] }, 'Assignment')) {
    const t = tById.get(childText(a, 'TaskUID')), r = rById.get(childText(a, 'ResourceUID'));
    if (!t || !r) continue;
    const units = +childText(a, 'Units', '1');
    if (!t.assignments.some((x) => x.resourceId === r.id)) t.assignments.push({ resourceId: r.id, units: Number.isFinite(units) ? units : 1 });
  }
  return { project: p, report: { tasks: p.tasks.length, resources: p.resources.length, links: linked, skipped } };
}
