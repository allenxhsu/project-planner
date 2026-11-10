// The tools, as plain functions: a name, a description Claude reads, a JSON
// schema for the arguments, and a handler over a PlannerClient that returns
// `{ text, data }` — the text is what Claude sees, the data is what the
// tests check. server.mjs wraps these in the MCP protocol and nothing else.
//
// Tasks are named the way a person names them at the keyboard: the row
// number the task list shows, or the task's name — exact, or a prefix or a
// fragment when it fits exactly one. Two candidates are an error that lists
// them, never a guess.

import { PlannerClient, taskRow } from './planner.mjs';
import {
  setTaskField, insertTask, removeTasks, moveTask, indentTasks, outdentTasks,
  link, unlink, addResource, assign, unassign, descendants, taskIndex, timeBlocks,
  saveEvent, removeEvent, eventsOf, setPin, clearPins, pinsOf,
} from '../src/model/model.js';
import { isoValid, today } from '../src/model/calendar.js';
import { GoogleCalendar, syncCalendar, loadCalendars, HORIZON_DAYS } from './gcal.mjs';
import { computeSchedule } from '../src/model/schedule.js';


/**
 * Time blocks ("schedules" in the app) named the way a person types them:
 * "Study", "work, deep" — case-insensitive, exact or a prefix that fits one.
 * Returns ids. "" means none: the task may go in any block.
 */
export function resolveBlocks(project, text) {
  const names = String(text ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const all = timeBlocks(project);
  return names.map((q) => {
    const lq = q.toLowerCase();
    const exact = all.filter((b) => String(b.name).toLowerCase() === lq);
    const hits = exact.length ? exact : all.filter((b) => String(b.name).toLowerCase().startsWith(lq));
    if (hits.length === 1) return hits[0].id;
    const have = all.map((b) => b.name).join(', ');
    if (hits.length > 1) throw new Error(`Several schedules match “${q}”: ${hits.map((b) => b.name).join(', ')}. Say which.`);
    throw new Error(`No schedule named “${q}” in this plan. It has: ${have}.`);
  });
}



// ------------------------------------------------------------------ pins

/**
 * "2026-11-09 09:00-13:00, 2026-11-10 13:30-14:30" → pins the model takes.
 * A pin fixes the task to that clock time on that day; its minutes count
 * against the task's work. "" means no pins.
 */
export function parsePins(text) {
  const parts = String(text ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return parts.map((part) => {
    const m = /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(part);
    if (!m) throw new Error(`A pin looks like "2026-11-09 09:00-13:00" (day, start-end); got “${part}”.`);
    const start = +m[2] * 60 + +m[3], end = +m[4] * 60 + +m[5];
    if (+m[2] > 23 || +m[3] > 59 || +m[4] > 24 || +m[5] > 59) throw new Error(`A pin's times are clock times; got “${part}”.`);
    if (end <= start) throw new Error(`A pin ends after it starts; got “${part}”.`);
    return { day: m[1], start, minutes: end - start };
  });
}

// ------------------------------------------------------------------ events

/** "08:30" → minutes into the day. Anything else is an error the person can read. */
function minutesOf(text, what) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(`\`${what}\` is a time of day like 08:30.`);
  return +m[1] * 60 + +m[2];
}
const clock = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/** One event as the tools return it. */
function eventRow(ev, planName = null) {
  return {
    id: ev.id, title: ev.title, day: ev.day, endDay: ev.endDay, from: clock(ev.start), to: clock(ev.end),
    allDay: !!ev.allDay, busy: ev.busy !== false, repeat: ev.repeat || 'none', notes: ev.notes || '',
    ...(planName ? { plan: planName } : {}),
  };
}

/** The one event an id or a title fragment means; two candidates are an error. */
function resolveEvent(project, ref) {
  const q = String(ref ?? '').trim().toLowerCase();
  const all = eventsOf(project);
  const byId = all.filter((e) => e.id === ref);
  if (byId.length === 1) return byId[0];
  const exact = all.filter((e) => String(e.title).toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const hits = exact.length ? exact : all.filter((e) => String(e.title).toLowerCase().includes(q));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`Several events match “${ref}”: ${hits.map((e) => `${e.title} (${e.day})`).join(', ')}. Say which.`);
  throw new Error(`No event matches “${ref}”. list_events shows them.`);
}

// ------------------------------------------------------------------ naming

/** Every task whose row or name fits `ref`, best matches first. */
export function matchTasks(project, ref) {
  const tasks = project.tasks;
  const raw = ref == null ? '' : String(ref).trim();
  if (typeof ref === 'number' || /^\d+$/.test(raw)) {
    const row = Number(raw);
    const t = tasks[row - 1];
    return { kind: 'row', row, matches: t ? [t] : [] };
  }
  const q = raw.toLowerCase();
  if (!q) return { kind: 'name', matches: [] };
  const name = (t) => String(t.name || '').toLowerCase();
  const exact = tasks.filter((t) => name(t) === q);
  if (exact.length) return { kind: 'name', matches: exact };
  const prefix = tasks.filter((t) => name(t).startsWith(q));
  if (prefix.length) return { kind: 'name', matches: prefix };
  return { kind: 'name', matches: tasks.filter((t) => name(t).includes(q)) };
}

/** Exactly one task, or an error that says why not. */
export function resolveTask(project, ref) {
  const { kind, row, matches } = matchTasks(project, ref);
  if (matches.length === 1) return matches[0];
  if (kind === 'row') throw new Error(`No task matches row ${row}: the plan has ${project.tasks.length} rows.`);
  if (matches.length === 0) throw new Error(`No task matches “${ref}”. find_task lists candidates; get_plan shows every row.`);
  const list = matches.slice(0, 8).map((t) => `${taskIndex(project, t.id) + 1} ${t.name}`).join(', ');
  throw new Error(`Several tasks match “${ref}”: ${list}${matches.length > 8 ? ', …' : ''}. Say the row number.`);
}

function resolveResource(project, ref) {
  const q = String(ref || '').trim().toLowerCase();
  if (!q) throw new Error('A resource needs a name.');
  return project.resources.find((r) => String(r.name).trim().toLowerCase() === q)
    || project.resources.find((r) => String(r.name).trim().toLowerCase().startsWith(q))
    || null;
}

const dateArg = (value, what) => {
  if (value == null || value === '') return null;
  if (!isoValid(value)) throw new Error(`${what} is a date (YYYY-MM-DD), not “${value}”.`);
  return value;
};

// --------------------------------------------------------------- rendering

const pad = (s, n) => String(s ?? '').padEnd(n);
const num = (s, n) => String(s ?? '').padStart(n);

function planHeader(project, schedule) {
  return `${project.name} — ${project.tasks.length} tasks, ${schedule.startIso} → ${schedule.finishIso}, ${schedule.percent}% done (id ${project.id})`;
}

function rowsText(rows) {
  if (!rows.length) return '(no tasks)';
  const lines = [`${num('#', 3)}  ${pad('task', 44)} ${num('dur', 5)}  ${pad('start', 10)}  ${pad('finish', 10)}  ${pad('deadline', 10)} ${num('%', 4)} ${num('slack', 6)}  ${pad('pred', 10)} who`];
  for (const r of rows) {
    const name = `${'  '.repeat(Math.max(0, r.level - 1))}${r.name}${r.summary ? ' ▸' : r.milestone ? ' ◆' : ''}`;
    lines.push(`${num(r.row, 3)}  ${pad(name.slice(0, 44), 44)} ${num(r.milestone ? '0d' : `${r.duration}d`, 5)}  ${pad(r.start, 10)}  ${pad(r.finish, 10)}  ${pad(r.deadline || '', 10)} ${num(r.percent, 4)} ${num(r.summary ? '' : r.slack, 6)}  ${pad(r.predecessors, 10)} ${r.resources}${r.critical && !r.summary ? '  ⚑' : ''}`);
  }
  return lines.join('\n');
}

function dueText(rows) {
  if (!rows.length) return 'Nothing is due in that range.';
  return rows.map((r) => `${r.date}  ${r.plan} › ${r.row} ${r.task}${r.deadline ? ` (deadline ${r.deadline})` : ''} — ${r.percent}% done, slack ${r.slack}${r.resources ? `, ${r.resources}` : ''}`).join('\n');
}

// -------------------------------------------------------------------- tools

const PLAN_ARG = { type: 'string', description: 'The plan: its name (or a unique part of it) or id. Optional after use_plan.' };
const TASK_ARG = { type: ['string', 'number'], description: 'A task: the row number shown in the task list, or its name (exact, or a prefix/fragment that fits one task).' };

/**
 * Every tool. `inputSchema` is JSON Schema, as the MCP tools/list wants it;
 * `handler(client, args)` returns `{ text, data }`.
 */
export const TOOLS = [
  {
    name: 'list_plans',
    description: 'Every plan on the shelf: name, id, how many tasks, start and finish, percent done.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(client) {
      await client.sync();
      const data = (await client.plans()).map(({ record, project }) => {
        const s = computeSchedule(project);
        return { id: record.id, name: project.name, tasks: project.tasks.length, start: s.startIso, finish: s.finishIso, percent: s.percent, archived: !!project.archived };
      });
      const text = data.length ? data.map((p) => `${p.name} — ${p.tasks} tasks, ${p.start} → ${p.finish}, ${p.percent}%${p.archived ? ', archived' : ''} (${p.id})`).join('\n') : 'No plans on the shelf.';
      return { text, data };
    },
  },
  {
    name: 'create_plan',
    description: 'Make a new, empty plan on the shelf. It becomes the plan later calls work on. Names are unique.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        start: { type: 'string', description: 'YYYY-MM-DD the plan starts; today when omitted.' },
        work_days: {
          type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 },
          description: 'Working weekdays, 0 = Sunday … 6 = Saturday. Default Mon–Fri [1,2,3,4,5]; [0,1,2,3,4,5,6] for a plan that runs every day; [0,6] for weekend-only.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async handler(client, args) {
      if (args.start != null && !isoValid(args.start)) throw new Error('`start` is a date, YYYY-MM-DD.');
      let workDays = null;
      if (args.work_days != null) {
        const days = Array.isArray(args.work_days) ? args.work_days : [args.work_days];
        if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('`work_days` lists weekdays 0 (Sunday) to 6 (Saturday).');
        workDays = [...new Set(days)].sort();
      }
      const { record, project, pushed } = await client.create({ name: args.name, start: args.start || null, workDays });
      return {
        text: `Made “${project.name}” (${record.id}), starting ${project.start}, working ${project.calendar.workDays.join(',')}. Later calls work on it.`,
        data: { id: record.id, name: project.name, start: project.start, workDays: project.calendar.workDays, pushed },
      };
    },
  },
  {
    name: 'add_event',
    description: 'Block out time the work goes around: a trip, a ride day, a drive, an appointment. One day or a span of days, by clock time or all day. Events on any plan count for the whole shelf.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: PLAN_ARG,
        title: { type: 'string' },
        day: { type: 'string', description: 'First day, YYYY-MM-DD.' },
        end_day: { type: 'string', description: 'Last day, YYYY-MM-DD; the same day when left out.' },
        from: { type: 'string', description: 'Start time of day, like 08:30. Required unless all_day.' },
        to: { type: 'string', description: 'End time of day, like 16:00. Required unless all_day.' },
        all_day: { type: 'boolean' },
        busy: { type: 'boolean', description: 'Default true: the time is taken. false shows the event without blocking work.' },
        notes: { type: 'string' },
      },
      required: ['title', 'day'],
      additionalProperties: false,
    },
    async handler(client, args) {
      const title = String(args.title || '').trim();
      if (!title) throw new Error('An event needs a title.');
      if (!isoValid(args.day)) throw new Error('`day` is a date, YYYY-MM-DD.');
      if (args.end_day != null && args.end_day !== '' && !isoValid(args.end_day)) throw new Error('`end_day` is a date, YYYY-MM-DD.');
      const allDay = args.all_day === true;
      const start = allDay ? 0 : minutesOf(args.from, 'from');
      const end = allDay ? 24 * 60 : minutesOf(args.to, 'to');
      const { project, pushed, result: ev } = await client.edit(args.plan, (p) => saveEvent(p, {
        title, day: args.day, endDay: args.end_day || args.day, start, end, allDay,
        busy: args.busy !== false, notes: args.notes || '',
      }));
      const row = eventRow(ev, project.name);
      return { text: `Blocked “${row.title}” ${row.day}${row.endDay !== row.day ? ` → ${row.endDay}` : ''}, ${row.allDay ? 'all day' : `${row.from}–${row.to}`}${row.busy ? '' : ' (not busy)'}.`, data: { ...row, pushed } };
    },
  },
  {
    name: 'list_events',
    description: 'The events (blocked time) on a plan, or on every plan when none is chosen, optionally within a date range.',
    inputSchema: {
      type: 'object',
      properties: { plan: PLAN_ARG, from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' } },
      additionalProperties: false,
    },
    async handler(client, args) {
      for (const k of ['from', 'to']) if (args[k] != null && args[k] !== '' && !isoValid(args[k])) throw new Error(`\`${k}\` is a date, YYYY-MM-DD.`);
      await client.sync();
      const plans = (args.plan || client.defaultPlanId) ? [await client.resolvePlan(args.plan)] : await client.plans();
      const out = [];
      for (const { project } of plans) for (const ev of eventsOf(project)) {
        if (args.from && ev.endDay < args.from) continue;
        if (args.to && ev.day > args.to) continue;
        out.push(eventRow(ev, project.name));
      }
      out.sort((a, b) => a.day.localeCompare(b.day) || a.from.localeCompare(b.from));
      const text = out.length ? out.map((e) => `${e.day}${e.endDay !== e.day ? `→${e.endDay}` : ''} ${e.allDay ? 'all day' : `${e.from}–${e.to}`}  ${e.title} (${e.plan})`).join('\n') : 'No events.';
      return { text, data: out };
    },
  },
  {
    name: 'delete_event',
    description: 'Remove one event by its id or its title (exact, or a fragment that fits one).',
    inputSchema: {
      type: 'object',
      properties: { plan: PLAN_ARG, event: { type: 'string' } },
      required: ['event'],
      additionalProperties: false,
    },
    async handler(client, args) {
      let title = null;
      const { pushed } = await client.edit(args.plan, (p) => { const ev = resolveEvent(p, args.event); title = ev.title; removeEvent(p, ev.id); });
      return { text: `Removed “${title}”.`, data: { removed: 1, title, pushed } };
    },
  },
  {
    name: 'sync_calendar',
    description: 'Keep the planner and Google Calendar in step, the calendar winning. Reads each plan\u2019s own calendar (mcp/plan-calendars.json) two weeks back and ahead: an event moved, resized, renamed, ticked (\u2713) or deleted there updates its task (pin, work, name, done; a deleted event takes the task off the calendar); laid blocks with no event yet are pushed as one event per task per day; a task renamed or finished here retitles its event. Hand-made events are matched to tasks and proposed; the dry run (default) lists everything. confirm_links writes the proposed links; adopt_new turns unmatched events into tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        dry_run: { type: 'boolean', description: 'Default true: show what would change and write nothing. false writes both sides.' },
        plan: { type: 'string', description: 'Only this plan\u2019s calendar. Default: every plan with a calendar.' },
        days: { type: 'integer', description: `How many days ahead to push. Default ${HORIZON_DAYS}.` },
        confirm_links: { type: 'boolean', description: 'Write the links the previous dry run proposed (hand-made event \u2194 task). Default false.' },
        adopt_new: { type: 'boolean', description: 'Make a task for each event on a plan calendar that matches nothing. Default false.' },
      },
      additionalProperties: false,
    },
    async handler(client, args) {
      const gcal = client.gcal || (client.gcal = await GoogleCalendar.open());
      const calendars = client.calendars || loadCalendars();
      const out = await syncCalendar({
        client, gcal, calendars, now: client.now || new Date(), dryRun: args.dry_run !== false,
        horizonDays: Number.isInteger(args.days) && args.days > 0 ? args.days : HORIZON_DAYS, plan: args.plan || null,
        confirmLinks: args.confirm_links === true, adoptNew: args.adopt_new === true,
      });
      const a = out.actions;
      const counts = { create: a.create.length, update: a.update.length, delete: a.delete.length, pull: a.pull.length, unlink: a.unlink.length, link: a.link.length, ambiguous: a.ambiguous.length, orphans: a.orphans.length, keep: a.keep };
      return { text: `${out.text}\n${out.applied ? 'Applied.' : 'Dry run; nothing written.'}`, data: { applied: out.applied, ...counts, unmapped: out.unmapped, window: out.window } };
    },
  },
  {
    name: 'use_plan',
    description: 'Choose the plan later calls work on, so they need not name it. Returns its name and id.',
    inputSchema: { type: 'object', properties: { plan: { ...PLAN_ARG, description: 'The plan: its name (or a unique part of it) or id.' } }, required: ['plan'], additionalProperties: false },
    async handler(client, { plan }) {
      await client.sync();
      const found = await client.resolvePlan(plan);
      client.defaultPlanId = found.record.id;
      return { text: `Working on “${found.project.name}” (${found.record.id}).`, data: { id: found.record.id, name: found.project.name } };
    },
  },
  {
    name: 'get_plan',
    description: 'The task list of a plan with its schedule: row, name (indented by outline level), duration, start, finish, deadline, percent done, slack, predecessors (row numbers), resources. ▸ marks a summary, ◆ a milestone, ⚑ the critical path.',
    inputSchema: { type: 'object', properties: { plan: PLAN_ARG, include_done: { type: 'boolean', description: 'Include tasks at 100%. Default true.' } }, additionalProperties: false },
    async handler(client, { plan, include_done = true } = {}) {
      const { record, project, schedule } = await client.load(plan);
      let rows = project.tasks.map((t, i) => taskRow(project, schedule, t, i));
      if (!include_done) rows = rows.filter((r) => r.summary || r.percent < 100);
      return {
        text: `${planHeader(project, schedule)}\n${rowsText(rows)}`,
        data: { plan: { id: record.id, name: project.name, start: schedule.startIso, finish: schedule.finishIso, percent: schedule.percent }, tasks: rows },
      };
    },
  },
  {
    name: 'find_task',
    description: 'Which tasks a row number or a name fragment refers to. Use it when a name might be ambiguous.',
    inputSchema: { type: 'object', properties: { plan: PLAN_ARG, task: TASK_ARG }, required: ['task'], additionalProperties: false },
    async handler(client, { plan, task }) {
      const { project, schedule } = await client.load(plan);
      const { matches } = matchTasks(project, task);
      const rows = matches.map((t) => taskRow(project, schedule, t, taskIndex(project, t.id)));
      return { text: rows.length ? rowsText(rows) : `No task matches “${task}”.`, data: { matches: rows } };
    },
  },
  {
    name: 'due_tasks',
    description: 'Open tasks across every plan (or one plan) that finish, or have a deadline, within a date range. Defaults to today.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'First day, YYYY-MM-DD. Default today.' },
        to: { type: 'string', description: 'Last day, YYYY-MM-DD. Default `from`.' },
        plan: { ...PLAN_ARG, description: 'Only this plan. Default: every plan.' },
      },
      additionalProperties: false,
    },
    async handler(client, { from, to, plan } = {}) {
      const start = dateArg(from, 'from') || today();
      const end = dateArg(to, 'to') || start;
      if (end < start) throw new Error('`to` is before `from`.');
      await client.sync();
      const plans = plan ? [await client.resolvePlan(plan)] : await client.plans();
      const data = [];
      for (const { project } of plans) {
        const schedule = computeSchedule(project);
        project.tasks.forEach((t, i) => {
          const r = taskRow(project, schedule, t, i);
          if (r.summary || r.percent >= 100) return;
          const byFinish = r.finish && r.finish >= start && r.finish <= end;
          const byDeadline = r.deadline && r.deadline >= start && r.deadline <= end;
          if (!byFinish && !byDeadline) return;
          data.push({ date: byDeadline ? r.deadline : r.finish, plan: project.name, planId: project.id, row: r.row, task: r.name, start: r.start, finish: r.finish, deadline: r.deadline, percent: r.percent, slack: r.slack, resources: r.resources, urgency: r.urgency });
        });
      }
      data.sort((a, b) => a.date.localeCompare(b.date) || a.plan.localeCompare(b.plan) || a.row - b.row);
      return { text: `Due ${start === end ? start : `${start} → ${end}`}:\n${dueText(data)}`, data };
    },
  },
  {
    name: 'checks',
    description: 'What the live checks say about a plan: missed deadlines, negative slack, cycles, overallocation, missing links or resources.',
    inputSchema: { type: 'object', properties: { plan: PLAN_ARG }, additionalProperties: false },
    async handler(client, { plan } = {}) {
      const { project, schedule } = await client.load(plan);
      const data = client.checks(project, schedule);
      return { text: data.length ? data.map((i) => `${i.level}: ${i.text}`).join('\n') : 'No issues.', data };
    },
  },
  {
    name: 'add_task',
    description: 'Add a task: at the end of the plan, right after a task (`after`, at its level), or as the last subtask of a summary (`under`). Returns its row.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: PLAN_ARG,
        name: { type: 'string' },
        after: { ...TASK_ARG, description: 'Put it right after this task (and that task’s subtasks), at the same level.' },
        under: { ...TASK_ARG, description: 'Put it as the last subtask of this task.' },
        duration: { type: ['string', 'number'], description: 'Working days: 3, "3d", "2w". "0d" is a milestone. Default 1.' },
        work: { type: ['string', 'number'], description: 'Hours actually spent, like 12 or "12h"; blank means full-time for the duration.' },
        deadline: { type: 'string', description: 'YYYY-MM-DD' },
        start: { type: 'string', description: 'Pin the start (Start No Earlier Than), YYYY-MM-DD.' },
        predecessors: { type: 'string', description: 'As typed in the task list: "3", "3FS+2d, 5SS".' },
        resources: { type: 'string', description: 'As typed in the task list: "Ana, Ben [50%]". Unknown names join the plan.' },
        urgency: { type: 'string', enum: ['now', 'high', 'normal', 'low'] },
        percent: { type: 'number' },
        notes: { type: 'string' },
        claude_scheduled: { type: 'boolean', description: 'Mark it Claude / MCP scheduled: Claude chose its start and deadline, the calendar lays it only inside them and nothing automatic moves them. Use it for anything over 30 minutes; false makes it manual again.' },
        schedule: { type: 'string', description: 'The schedule(s) (time blocks) the task is laid in, by name: "Study", "Work, Deep focus". "" means any.' },
        pin: { type: 'string', description: 'Fix the task to clock time: "2026-11-09 09:00-13:00", several separated by commas; replaces earlier pins; "" unpins. The pinned minutes count against the task’s work.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async handler(client, args) {
      const name = String(args.name || '').trim();
      if (!name) throw new Error('A task needs a name.');
      const { project, schedule, pushed, result: id } = await client.edit(args.plan, (p) => {
        let at = p.tasks.length;
        let level = 1;
        if (args.after != null) {
          const ref = resolveTask(p, args.after);
          const i = taskIndex(p, ref.id);
          at = i + 1 + descendants(p, i).length;
          level = ref.level;
        } else if (args.under != null) {
          const ref = resolveTask(p, args.under);
          const i = taskIndex(p, ref.id);
          at = i + 1 + descendants(p, i).length;
          level = ref.level + 1;
        }
        const t = insertTask(p, at, { name, level });
        setTaskField(p, t.id, 'duration', args.duration == null ? 1 : args.duration);
        applyFields(p, t.id, args, ['work', 'deadline', 'start', 'predecessors', 'resources', 'urgency', 'percent', 'notes', 'claude_scheduled', 'schedule', 'pin']);
        return t.id;
      });
      const t = project.tasks.find((x) => x.id === id);
      const row = taskRow(project, schedule, t, taskIndex(project, t.id));
      return { text: `Added row ${row.row} “${row.name}” (${row.start} → ${row.finish}).`, data: { ...row, pushed } };
    },
  },
  {
    name: 'edit_task',
    description: 'Change a task’s fields. Only the fields given change. `start` pins the task (Start No Earlier Than); `duration` and `work` accept "3d", "12h".',
    inputSchema: {
      type: 'object',
      properties: {
        plan: PLAN_ARG,
        task: TASK_ARG,
        name: { type: 'string' },
        duration: { type: ['string', 'number'], description: 'Working days: 3, "3d", "2w". 0 makes a milestone.' },
        work: { type: ['string', 'number'], description: 'Hours: 12 or "12h"; "" returns to full-time.' },
        percent: { type: 'number', minimum: 0, maximum: 100 },
        deadline: { type: 'string', description: 'YYYY-MM-DD, or "" to clear.' },
        start: { type: 'string', description: 'Pin the start, YYYY-MM-DD; "" lets it float (As Soon As Possible).' },
        constraint_type: { type: 'string', enum: ['ASAP', 'SNET', 'SNLT', 'FNET', 'FNLT', 'MSO', 'MFO'] },
        constraint_date: { type: 'string', description: 'YYYY-MM-DD' },
        urgency: { type: 'string', enum: ['now', 'high', 'normal', 'low'] },
        predecessors: { type: 'string', description: 'Replaces the links: "3, 5SS-1d". "" unlinks.' },
        resources: { type: 'string', description: 'Replaces the assignments: "Ana, Ben [50%]". "" unassigns.' },
        milestone: { type: 'boolean' },
        notes: { type: 'string' },
        claude_scheduled: { type: 'boolean', description: 'Mark it Claude / MCP scheduled: Claude chose its start and deadline, the calendar lays it only inside them and nothing automatic moves them. Use it for anything over 30 minutes; false makes it manual again.' },
        schedule: { type: 'string', description: 'The schedule(s) (time blocks) the task is laid in, by name: "Study", "Work, Deep focus". "" means any.' },
        pin: { type: 'string', description: 'Fix the task to clock time: "2026-11-09 09:00-13:00", several separated by commas; replaces earlier pins; "" unpins. The pinned minutes count against the task’s work.' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    async handler(client, args) {
      const fields = ['name', 'duration', 'work', 'percent', 'deadline', 'start', 'constraint_type', 'constraint_date', 'urgency', 'predecessors', 'resources', 'milestone', 'notes', 'claude_scheduled', 'schedule', 'pin'];
      if (!fields.some((f) => args[f] !== undefined)) throw new Error('Nothing to change: pass at least one field.');
      let before = null;
      let id = null;
      const { project, schedule, pushed } = await client.edit(args.plan, (p, s) => {
        const t = resolveTask(p, args.task);
        id = t.id;
        before = taskRow(p, s, t, taskIndex(p, t.id));
        applyFields(p, t.id, args, fields);
      });
      const after = taskRow(project, schedule, project.tasks.find((t) => t.id === id), taskIndex(project, id));
      const changed = fields.filter((f) => args[f] !== undefined).join(', ');
      return { text: `Row ${after.row} “${after.name}”: ${changed} changed. Now ${after.start} → ${after.finish}${after.deadline ? `, deadline ${after.deadline}` : ''}, ${after.percent}%, slack ${after.slack}.`, data: { row: after.row, before, after, pushed } };
    },
  },
  {
    name: 'link_tasks',
    description: 'Make `to` depend on `from`: Finish-to-Start by default, with an optional lag in working days (negative for a lead).',
    inputSchema: {
      type: 'object',
      properties: { plan: PLAN_ARG, from: { ...TASK_ARG, description: 'The predecessor.' }, to: { ...TASK_ARG, description: 'The task that waits for it.' }, type: { type: 'string', enum: ['FS', 'SS', 'FF', 'SF'] }, lag: { type: 'number', description: 'Working days; default 0.' } },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    async handler(client, { plan, from, to, type = 'FS', lag = 0 }) {
      let names = null;
      const { project, schedule, pushed } = await client.edit(plan, (p) => {
        const a = resolveTask(p, from), b = resolveTask(p, to);
        link(p, a.id, b.id, type, lag);
        names = [a, b];
      });
      const [a, b] = names.map((t) => taskRow(project, schedule, t, taskIndex(project, t.id)));
      return { text: `Linked row ${a.row} “${a.name}” → row ${b.row} “${b.name}” (${type}${lag ? `${lag > 0 ? '+' : ''}${lag}d` : ''}); “${b.name}” is now ${b.start} → ${b.finish}.`, data: { from: a, to: b, pushed } };
    },
  },
  {
    name: 'unlink_tasks',
    description: 'Remove the link from `from` to `to`.',
    inputSchema: { type: 'object', properties: { plan: PLAN_ARG, from: TASK_ARG, to: TASK_ARG }, required: ['from', 'to'], additionalProperties: false },
    async handler(client, { plan, from, to }) {
      let names = null;
      const { project, schedule, pushed } = await client.edit(plan, (p) => {
        const a = resolveTask(p, from), b = resolveTask(p, to);
        unlink(p, a.id, b.id);
        names = [a, b];
      });
      const [a, b] = names.map((t) => taskRow(project, schedule, t, taskIndex(project, t.id)));
      return { text: `Row ${b.row} “${b.name}” no longer follows row ${a.row} “${a.name}”.`, data: { from: a, to: b, pushed } };
    },
  },
  {
    name: 'move_task',
    description: 'Move a task (with its subtasks): up or down past its neighbour, or indent/outdent one outline level.',
    inputSchema: { type: 'object', properties: { plan: PLAN_ARG, task: TASK_ARG, direction: { type: 'string', enum: ['up', 'down', 'indent', 'outdent'] } }, required: ['task', 'direction'], additionalProperties: false },
    async handler(client, { plan, task, direction }) {
      if (!['up', 'down', 'indent', 'outdent'].includes(direction)) throw new Error('direction is one of up, down, indent, outdent.');
      let id = null;
      const { project, schedule, pushed } = await client.edit(plan, (p) => {
        const t = resolveTask(p, task);
        id = t.id;
        const ok = direction === 'up' ? moveTask(p, t.id, -1)
          : direction === 'down' ? moveTask(p, t.id, 1)
            : direction === 'indent' ? indentTasks(p, [t.id]) > 0
              : outdentTasks(p, [t.id]) > 0;
        if (!ok) throw new Error(`Cannot move “${t.name}” ${direction}: ${direction === 'up' || direction === 'down' ? 'there is no sibling on that side' : direction === 'indent' ? 'it is already deeper than the task above it' : 'it is at the top level'}.`);
      });
      const row = taskRow(project, schedule, project.tasks.find((t) => t.id === id), taskIndex(project, id));
      return { text: `Row ${row.row} “${row.name}” moved ${direction}; level ${row.level}.`, data: { ...row, pushed } };
    },
  },
  {
    name: 'delete_task',
    description: 'Delete a task and everything under it. Links to it are dropped.',
    inputSchema: { type: 'object', properties: { plan: PLAN_ARG, task: TASK_ARG }, required: ['task'], additionalProperties: false },
    async handler(client, { plan, task }) {
      let name = null;
      const { pushed, result } = await client.edit(plan, (p) => {
        const t = resolveTask(p, task);
        name = t.name;
        return removeTasks(p, [t.id]);
      });
      return { text: `Deleted “${name}”${result > 1 ? ` and ${result - 1} subtask${result > 2 ? 's' : ''}` : ''}.`, data: { removed: result, pushed } };
    },
  },
  {
    name: 'assign_task',
    description: 'Put a person on a task, at full time or a fraction (`units` 0.5 = half time). A name not yet in the plan joins its resources.',
    inputSchema: { type: 'object', properties: { plan: PLAN_ARG, task: TASK_ARG, resource: { type: 'string' }, units: { type: 'number', description: '1 = full time (default), 0.5 = half.' } }, required: ['task', 'resource'], additionalProperties: false },
    async handler(client, { plan, task, resource, units = 1 }) {
      let id = null;
      const { project, schedule, pushed } = await client.edit(plan, (p) => {
        const t = resolveTask(p, task);
        id = t.id;
        const r = resolveResource(p, resource) || addResource(p, { name: String(resource).trim() });
        assign(p, t.id, r.id, units);
      });
      const row = taskRow(project, schedule, project.tasks.find((t) => t.id === id), taskIndex(project, id));
      return { text: `Row ${row.row} “${row.name}”: ${row.resources}.`, data: { ...row, pushed } };
    },
  },
  {
    name: 'unassign_task',
    description: 'Take a person off a task.',
    inputSchema: { type: 'object', properties: { plan: PLAN_ARG, task: TASK_ARG, resource: { type: 'string' } }, required: ['task', 'resource'], additionalProperties: false },
    async handler(client, { plan, task, resource }) {
      let id = null;
      const { project, schedule, pushed } = await client.edit(plan, (p) => {
        const t = resolveTask(p, task);
        id = t.id;
        const r = resolveResource(p, resource);
        if (!r) throw new Error(`No resource named “${resource}” in this plan.`);
        unassign(p, t.id, r.id);
      });
      const row = taskRow(project, schedule, project.tasks.find((t) => t.id === id), taskIndex(project, id));
      return { text: `Row ${row.row} “${row.name}”: ${row.resources || 'nobody'}.`, data: { ...row, pushed } };
    },
  },
];

/** The task fields a tool accepts, mapped onto the model's names. */
const FIELD_NAMES = { constraint_type: 'constraintType', constraint_date: 'constraintDate', claude_scheduled: 'scheduledBy' };
function applyFields(p, id, args, fields) {
  for (const f of fields) {
    if (args[f] === undefined) continue;
    if (f === 'schedule') { setTaskField(p, id, 'timeBlock', resolveBlocks(p, args[f])); continue; }
    if (f === 'pin') { const pins = parsePins(args[f]); clearPins(p, id); for (const pin of pins) setPin(p, id, pin); continue; }
    // The model parses "3d", "2w", "12h" itself, as the task list does.
    setTaskField(p, id, FIELD_NAMES[f] || f, args[f]);
  }
}

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Run one tool by name. Unknown names and the handlers' own errors throw. */
export async function runTool(client, name, args = {}) {
  const tool = BY_NAME.get(name);
  if (!tool) throw new Error(`No tool named ${name}.`);
  for (const key of tool.inputSchema.required || []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') throw new Error(`${name} needs \`${key}\`.`);
  }
  return tool.handler(client, args);
}

export { PlannerClient };
