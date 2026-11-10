// The planner and Google Calendar, kept in step — the pure part.
//
// This is what the app runs in the browser (state/gcal.js, through the sync
// server) and what mcp/gcal.mjs runs as a command and an MCP tool: the same
// reconciliation, so the two can never disagree. Nothing from node is in here.
//
// Tasks have dates and hours but no time of day; the planner's calendar lays
// them into clock time (model/agenda.js: time blocks, pins, events, the
// day's focus). Google Calendar — one secondary calendar per plan,
// plan-calendars.json — is where the day is read and, since Allen edits it
// there, the source of truth for *when*. So the sync runs both ways with the
// calendar winning:
//
//   calendar → planner  an event dragged, resized, renamed or ticked moves
//                       its task's pin, its work, its name, its percent; an
//                       event deleted takes the task off the calendar;
//   planner → calendar  the laid blocks that have no event yet are pushed,
//                       one event per task per day, and pinned where they
//                       landed; a task renamed or finished in the planner
//                       retitles its event; a task deleted deletes it.
//
// Both sides carry the other's id: the event's private extended properties
// hold the plan and task id, the task's `calendar.links` hold the calendar,
// the event id and where the event was at the last sync (day, start,
// minutes, title) — the snapshot that says which side moved. When both did,
// the calendar wins and the planner's change is reported. Hand-made events
// without ids are matched by title, then by slot, with a score; the match is
// proposed in the dry run and written only when confirmed. Two candidates
// are an ambiguity listed for a person, never a guess. Anything on a
// calendar that is neither linked nor matched is reported as new and becomes
// a task only when asked.
//
// Three layers, so the first two need no Google: pure functions over plans
// and normalised events; applyToPlan, which writes a run's changes into a
// plan; and GoogleCalendar + syncCalendar, the Calendar API over fetch.

import { computeSchedule } from './schedule.js';
import { planBlocksAcross } from './agenda.js';
import { eventsOf, saveEvent, getTask, pinsOf, setPin, linksOf, setLinks, setTaskField, insertTask, logActivity } from './model.js';
import { localDate, toDay, fromDay } from './calendar.js';

/** Today through this many days: what a run pushes. */
export const HORIZON_DAYS = 14;
/** This many days back: how far a run reads the calendars for edits. */
export const LOOKBACK_DAYS = 14;
/** A task's merged run on a day shorter than this is not worth an event. */
export const MIN_MINUTES = 15;
/** Two blocks of one task on one day this close are one event. */
export const MERGE_GAP_MINUTES = 15;
/** The private extended properties that carry the planner's ids. */
export const PROP_PLAN = 'plannerPlanId';
export const PROP_TASK = 'plannerTaskId';
const DESCRIPTION_PREFIX = 'Planner:';


const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const dayMs = (iso) => new Date(`${iso}T00:00:00`).getTime();
const minutesOf = (d) => d.getHours() * 60 + d.getMinutes();
const span = (e) => `${e.dateIso} ${clock(e.start)}–${clock(e.end)}`;
const at = (e) => `${e.day} ${clock(e.start)}`;
const samePin = (a, b) => a && b && a.day === b.day && a.start === b.start && a.minutes === b.minutes;
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();
const isDone = (t) => Math.round(+t.percent || 0) >= 100;
/** A short stable hash of a string (djb2), so busy time from outside has one id across runs — no node crypto in the browser. */
const hashOf = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(16).padStart(8, '0'); };

// ---------------------------------------------------------------- the map

/**
 * The plan-name → calendarId map as committed: `{ plans: { "<plan>":
 * { calendarId, calendarName } } }` (calendars Claude made are named
 * "Claude - <workspace> - <plan>"; reused ones keep their names), or the
 * older flat `{ "<plan>": "<calendarId>" }`.
 */
export function calendarMap(raw) {
  const plans = raw && typeof raw === 'object' && raw.plans && typeof raw.plans === 'object' ? raw.plans : raw || {};
  const out = {};
  for (const [name, v] of Object.entries(plans)) {
    if (name.startsWith('_')) continue;
    const id = typeof v === 'string' ? v : v?.calendarId;
    if (id) out[name] = id;
  }
  return out;
}

/** The plans that are laid: every unarchived one, with its schedule. */
export function liveEntries(plans) {
  return plans
    .map((x) => x.project || x)
    .filter((project) => project && !project.archived)
    .map((project) => ({ project, schedule: computeSchedule(project) }));
}

// ------------------------------------------------------------- the titles

/**
 * What an event title says: the task name, less the plan — a trailing
 * "(Plan)" or "(Alc…)" that begins the plan's name, or a leading "Plan:" —
 * a ✓ at either end (done), "(time approx.)" (approx) and a trailing
 * "— priority / urgent / maintenance" note.
 */
export function parseTitle(title, planName) {
  let s = String(title || '').trim();
  let done = false, approx = false;
  const plan = String(planName || '').toLowerCase();
  const namesPlan = (x) => x && plan && plan.startsWith(x.toLowerCase());
  for (let before = null; before !== s;) {
    before = s;
    s = s.replace(/^[✓✔☑]\s*/, () => { done = true; return ''; }).replace(/\s*[✓✔☑]$/, () => { done = true; return ''; });
    s = s.replace(/\s*\(time approx\.?\)$/i, () => { approx = true; return ''; });
    s = s.replace(/\s*[—–-]+\s*(priority|urgent|maintenance)$/i, '');
    const tag = /\(([^()]+)\)$/.exec(s);
    if (tag && namesPlan(tag[1])) s = s.slice(0, tag.index).trimEnd();
    const prefix = /^([^:]{2,40}):\s+/.exec(s);
    if (prefix && namesPlan(prefix[1])) s = s.slice(prefix[0].length);
  }
  return { name: s.replace(/\s+/g, ' ').trim(), done, approx };
}

/**
 * The words of a name worth comparing: words of four letters or more, cut
 * to five so "lecture" and "lectures" agree, and anything with a digit in
 * it kept whole ("1/30", "27G", "HW6", "11-08") when it is more than one
 * character — a lecture's date is what tells it from the next one.
 */
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'then', 'about', 'after', 'before']);
function wordsOf(s) {
  const out = new Set();
  for (const raw of String(s || '').toLowerCase().split(/[\s,;()"“”]+/)) {
    const t = raw.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%]+$/gu, '');
    if (!t) continue;
    if (/\d/.test(t)) { if (t.length >= 2) out.add(t); continue; }
    const w = t.replace(/[^\p{L}]/gu, '');
    if (w.length >= 4 && !STOP.has(w)) out.add(w.slice(0, 5));
  }
  return out;
}
/** How much two names share: common words over the geometric mean of their counts; 0 when either has none. */
export function overlap(a, b) {
  const A = wordsOf(a), B = wordsOf(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n += 1;
  return n / Math.sqrt(A.size * B.size);
}

/** The task name the description's "Planner: Plan › Task" line names, or null. */
function describedName(description) {
  const m = /^\s*Planner:\s*.*?›\s*(.+?)\s*$/m.exec(String(description || ''));
  return m ? m[1].replace(/\.$/, '') : null;
}
/** The row numbers a "Planner: Plan › row 17" / "rows 5, 12" / "rows 26–43" line names. */
function describedRows(description) {
  const m = /›\s*rows?\s+([\d]+(?:\s*[,–-]\s*\d+)*)/i.exec(String(description || ''));
  if (!m) return [];
  const rows = [];
  for (const part of m[1].split(',')) {
    const r = /^\s*(\d+)(?:\s*[–-]\s*(\d+))?\s*$/.exec(part);
    if (!r) continue;
    const a = +r[1], b = r[2] ? +r[2] : a;
    for (let i = a; i <= Math.min(b, a + 60); i++) rows.push(i);
  }
  return rows;
}

// ----------------------------------------------------------- the matching

/** Words shared this much of the way are the same task said differently. */
export const WORDS_THRESHOLD = 0.5;

/**
 * Which task each unlinked event on a plan's calendar means.
 *
 * Four tiers, each tried only when the one before found nothing:
 *   title  the event's title less its plan tag, or the task the description's
 *          "Planner: Plan › Task" line names, equals a task's name (score 1;
 *          0.9 when several tasks share the name and one is pinned that day);
 *   row    the description says "› row 17" (score 0.95; "rows 5, 12" lists them);
 *   slot   a task is pinned on that day starting when the event starts and
 *          shares at least a word with it (score 0.75);
 *   words  the names share at least half their words, a task pinned that day
 *          preferred when it scores nearly as well (score 0.6–0.9).
 * One candidate is a match; several, or a slot with nothing in common, are
 * an ambiguity listed with the candidates; none is an orphan. One task may
 * take several events.
 *
 * @returns {{ matches: Array<{event, task, score, how}>, ambiguous: Array<{event, candidates}>, orphans: Array }}
 */
export function matchEvents(events, { project, planName = project?.name }) {
  const tasks = project.tasks.filter((t) => !t.summary);
  const out = { matches: [], ambiguous: [], orphans: [] };
  for (const ev of events) {
    if (ev.allDay) { out.orphans.push(ev); continue; }
    const name = parseTitle(ev.title, planName).name;
    const titled = norm(name), described = norm(describedName(ev.description) || '');
    // A pin that starts when the event starts: the length may differ, since a
    // half-done task's block is drawn shorter than its pin.
    const pinnedThere = (t) => pinsOf(t).some((q) => q.day === ev.dateIso && q.start === ev.start);
    const onDay = (t) => pinsOf(t).some((q) => q.day === ev.dateIso);
    // Same name on several tasks (a routine's occurrences): the one on this
    // day. Two on the same day stay ambiguous — a slot is not a name.
    const settle = (hits, how, score) => {
      if (hits.length === 1) { out.matches.push({ event: ev, task: hits[0], score, how }); return true; }
      const narrowed = hits.filter(onDay);
      if (narrowed.length === 1) { out.matches.push({ event: ev, task: narrowed[0], score: Math.min(score, 0.9), how }); return true; }
      out.ambiguous.push({ event: ev, candidates: narrowed.length ? narrowed : hits });
      return true;
    };
    const byTitle = titled ? tasks.filter((t) => norm(t.name) === titled) : [];
    const byName = byTitle.length ? byTitle : described ? tasks.filter((t) => norm(t.name) === described) : [];
    if (byName.length) { settle(byName, 'title', 1); continue; }
    // "› row 17" in the description: the row the event was made for.
    const byRow = describedRows(ev.description).map((n) => project.tasks[n - 1]).filter((t) => t && !t.summary);
    if (byRow.length) { settle(byRow, 'row', 0.95); continue; }
    // A task pinned where the event starts that shares a word with it: the
    // event was made for that pin, however it was retitled.
    const scored = tasks.map((t) => ({ t, o: overlap(name, t.name) })).filter((x) => x.o >= WORDS_THRESHOLD);
    const atSlot = tasks.filter(pinnedThere);
    const slotShared = atSlot.filter((t) => overlap(name, t.name) > 0);
    // …unless the pinned one shares only a word or two and another task shares
    // twice as much of the name: then the name is the better witness.
    const slotScore = slotShared.length === 1 ? overlap(name, slotShared[0].name) : 0;
    const outworded = slotShared.length === 1 && scored.some((x) => x.t !== slotShared[0] && x.o >= slotScore + 0.3);
    if (slotShared.length === 1 && !outworded) { out.matches.push({ event: ev, task: slotShared[0], score: 0.75, how: 'slot' }); continue; }
    if (slotShared.length > 1) { out.ambiguous.push({ event: ev, candidates: slotShared }); continue; }
    if (scored.length) {
      // Among everything that shares the words, the task pinned that day
      // (a routine's or a series' occurrence); else the best score.
      const top = Math.max(...scored.map((x) => x.o));
      const onThisDay = scored.filter((x) => onDay(x.t) && x.o >= top - 0.15);
      const pool = onThisDay.length ? onThisDay : scored;
      const best = Math.max(...pool.map((x) => x.o));
      settle(pool.filter((x) => x.o === best).map((x) => x.t), 'words', Math.min(0.9, 0.6 + 0.3 * best));
      continue;
    }
    if (atSlot.length) out.ambiguous.push({ event: ev, candidates: atSlot });   // a slot alone is not a name
    else out.orphans.push(ev);
  }
  return out;
}

// ---------------------------------------------------------- what to push

/**
 * Busy time from outside the planner, as planner events on a copy of the
 * first plan: lane `*`, so every person's hours are taken, no travel time
 * of its own. `busy` is `{ title, start, end, allDay?, busy?, location? }`
 * in ms; one with `busy: false` books nothing and is dropped.
 */
export function withBusy(entries, busy) {
  const taken = (busy || []).filter((b) => b && b.busy !== false && Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start);
  if (!taken.length || !entries.length) return entries;
  const copy = { ...entries[0].project, events: [...eventsOf(entries[0].project)] };
  for (const b of taken) {
    const s = new Date(b.start), e = new Date(b.end);
    const day = localDate(s);
    const endDay = localDate(new Date(b.end - 1));   // an end at midnight belongs to the day before
    saveEvent(copy, {
      id: `ev_busy_${hashOf(`${b.title}|${b.start}|${b.end}`)}`,
      title: String(b.title || 'Busy'), day, endDay, allDay: !!b.allDay,
      start: minutesOf(s), end: minutesOf(e) === 0 && endDay < localDate(e) ? 24 * 60 : minutesOf(e),
      busy: true, travel: 0, location: b.location || '', notes: 'From Google Calendar',
    });
  }
  return [{ ...entries[0], project: copy }, ...entries.slice(1)];
}

/** `[firstIso, lastIso]`: today through today + days − 1. */
export function horizonOf(now, horizonDays = HORIZON_DAYS) {
  const first = toDay(localDate(now));
  return [fromDay(first), fromDay(first + horizonDays - 1)];
}
/** `[firstIso, lastIso]`: the days a run reads, back and ahead. */
export function windowOf(now, { horizonDays = HORIZON_DAYS, lookbackDays = LOOKBACK_DAYS } = {}) {
  const today = toDay(localDate(now));
  return [fromDay(today - lookbackDays), fromDay(today + horizonDays - 1)];
}

const titleOf = (task, planName) => `${task.name} (${planName})${isDone(task) ? ' ✓' : ''}`;
const descriptionOf = (task, planName, flags = []) => [
  `${DESCRIPTION_PREFIX} ${planName} › ${task.name}`,
  String(task.notes || '').trim() || null,
  flags.length ? flags.join(' · ') : null,
].filter(Boolean).join('\n');

/**
 * The events the planner would push: one per task per day on the plan's
 * calendar, for laid blocks on days the task has no event yet.
 *
 * @returns {{ events: Array, unmapped: string[], layout: object, horizon: [string, string] }}
 */
export function desiredEvents(entries, { calendars = {}, now = new Date(), horizonDays = HORIZON_DAYS, busy = [] } = {}) {
  const layout = planBlocksAcross(withBusy(entries, busy), { now });
  const [first, last] = horizonOf(now, horizonDays);
  const projects = new Map(entries.map((e) => [e.project.id, e.project]));

  const groups = new Map();
  for (const b of layout.blocks) {
    if (b.dateIso < first || b.dateIso > last) continue;
    const project = projects.get(b.planId);
    const task = project ? getTask(project, b.taskId) : null;
    if (!task || task.builtin) continue;
    if (linksOf(task).some((l) => l.day === b.dateIso)) continue;   // already on the calendar that day
    const key = `${b.planId}|${b.taskId}|${b.dateIso}`;
    if (!groups.has(key)) groups.set(key, { project, task, dateIso: b.dateIso, blocks: [] });
    groups.get(key).blocks.push(b);
  }

  const events = [];
  const unmapped = new Set();
  for (const { project, task, dateIso, blocks } of groups.values()) {
    const calendarId = calendars[project.name];
    const runs = [];
    for (const b of [...blocks].sort((x, y) => x.start - y.start)) {
      const run = runs[runs.length - 1];
      if (run && b.start - run.end <= MERGE_GAP_MINUTES) { run.end = Math.max(run.end, b.end); run.blocks.push(b); }
      else runs.push({ start: b.start, end: b.end, blocks: [b] });
    }
    for (const run of runs) {
      if (run.end - run.start < MIN_MINUTES) continue;
      if (!calendarId) { unmapped.add(project.name); continue; }
      const flags = [
        run.blocks.some((b) => b.pinned) ? 'Pinned' : null,
        run.blocks.some((b) => b.late) ? 'After its deadline' : null,
        run.blocks.some((b) => b.overdue) ? 'Overdue' : null,
      ].filter(Boolean);
      events.push({
        calendarId, planId: project.id, planName: project.name, taskId: task.id, taskName: task.name, dateIso,
        start: run.start, end: run.end, title: titleOf(task, project.name), description: descriptionOf(task, project.name, flags),
      });
    }
  }
  events.sort((a, b) => a.dateIso.localeCompare(b.dateIso) || a.start - b.start || a.title.localeCompare(b.title));
  return { events, unmapped: [...unmapped].sort(), layout, horizon: [first, last] };
}

// ------------------------------------------------------------ reconcile

/**
 * Everything one run would do, from the plans and what the calendars hold.
 *
 * `existing` are normalised events (fromGoogleEvent) from every plan
 * calendar in scope. The result is data for a dry run to print and for
 * applyToPlan / syncCalendar to carry out:
 *   pull      calendar → task changes (pin, work, name, done), with
 *             `conflict` and `plannerChange` when the planner had moved too;
 *   unlink    linked events gone from the calendar;
 *   link      proposed links for hand-made events; ambiguous; orphans;
 *   create / update / delete  planner → calendar; keep, a count.
 */
export function reconcile(entries, existing, { calendars = {}, now = new Date(), horizonDays = HORIZON_DAYS, lookbackDays = LOOKBACK_DAYS, busy = [], planId = null } = {}) {
  const window = windowOf(now, { horizonDays, lookbackDays });
  const inScope = (project) => !planId || project?.id === planId;
  const byCalendar = new Map();
  for (const { project } of entries) if (calendars[project.name] && inScope(project)) byCalendar.set(calendars[project.name], project);
  const projects = new Map(entries.map((e) => [e.project.id, e.project]));

  const out = { pull: [], unlink: [], link: [], ambiguous: [], orphans: [], create: [], update: [], delete: [], keep: 0, window, unmapped: [] };
  const covered = new Set();          // `${taskId}|${dateIso}` with an event, proposed or real
  const seen = new Set();             // `${calendarId}|${eventId}` of linked events found
  const loose = new Map();            // calendarId → unlinked events
  const setLoose = (ev) => { if (!loose.has(ev.calendarId)) loose.set(ev.calendarId, []); loose.get(ev.calendarId).push(ev); };

  /** The task each link points at, by the tasks' own links. */
  const owners = new Map();
  for (const project of byCalendar.values()) for (const task of project.tasks) for (const link of linksOf(task)) owners.set(`${link.calendarId}|${link.eventId}`, { project, task, link });

  for (const ev of existing) {
    const project = ev && byCalendar.get(ev.calendarId);
    if (!project) continue;
    const owned = owners.get(`${ev.calendarId}|${ev.id}`);
    const task = owned?.task || (ev.taskId && ev.planId === project.id ? getTask(project, ev.taskId) : null);
    if (!task) {
      if (ev.taskId && ev.planId === project.id) out.delete.push(ev);          // the planner's task is gone
      else setLoose(ev);
      continue;
    }
    seen.add(`${ev.calendarId}|${ev.id}`);
    covered.add(`${task.id}|${ev.dateIso}`);
    const snap = owned?.link || null;
    const parsed = parseTitle(ev.title, project.name);
    const minutes = ev.end - ev.start;
    const calendarChanged = !snap || snap.day !== ev.dateIso || snap.start !== ev.start || snap.minutes !== minutes || snap.title !== ev.title;
    // The planner side is compared with what the task was at the last sync —
    // its name and done then — not with the event's title, which is Allen's
    // wording and may well differ from the task's.
    const plannerChanges = [];
    if (snap) {
      const snapTitle = parseTitle(snap.title, project.name);
      const wasName = snap.name ?? snapTitle.name, wasDone = snap.name != null ? !!snap.done : snapTitle.done;
      if (!pinsOf(task).some((q) => samePin(q, snap))) plannerChanges.push(`pin ${pinsOf(task).map(at).join(', ') || 'none'}`);
      if (norm(task.name) !== norm(wasName)) plannerChanges.push(`name “${task.name}”`);
      if (isDone(task) !== wasDone) plannerChanges.push(isDone(task) ? 'done' : 'reopened');
    }
    if (calendarChanged) {
      const changes = { pin: { from: snap ? { day: snap.day, start: snap.start, minutes: snap.minutes } : null, to: { day: ev.dateIso, start: ev.start, minutes } } };
      if (snap && snap.minutes !== minutes && task.work != null) changes.work = { from: task.work, to: Math.round((task.work + (minutes - snap.minutes) / 60) * 100) / 100 };
      // A rename follows only a retitle: a moved event keeps the task's name.
      const retitled = !snap || snap.title !== ev.title;
      if (retitled && parsed.name && norm(parsed.name) !== norm(task.name)) changes.name = { from: task.name, to: parsed.name };
      if (parsed.done && !isDone(task)) changes.done = true;
      out.pull.push({ planId: project.id, planName: project.name, taskId: task.id, taskName: task.name, event: ev, link: snap, changes, conflict: plannerChanges.length > 0, plannerChange: plannerChanges.join(', ') });
    } else if (plannerChanges.length) {
      const pin = pinsOf(task).find((q) => q.day === snap.day) || snap;
      out.update.push({ existing: ev, desired: {
        calendarId: ev.calendarId, planId: project.id, planName: project.name, taskId: task.id, taskName: task.name,
        dateIso: pin.day, start: pin.start, end: pin.start + pin.minutes, title: titleOf(task, project.name), description: descriptionOf(task, project.name),
      } });
    } else out.keep += 1;
  }

  // Linked events that were not on the calendar: deleted there.
  const unlinkedTasks = new Set();
  for (const { project, task, link } of owners.values()) {
    if (seen.has(`${link.calendarId}|${link.eventId}`)) continue;
    if (link.day < window[0] || link.day > window[1]) continue;      // outside what was read: unknown, not gone
    out.unlink.push({ planId: project.id, planName: project.name, taskId: task.id, taskName: task.name, link });
    unlinkedTasks.add(task.id);
  }

  // Hand-made events: propose, list, or report.
  for (const [calendarId, evs] of loose) {
    const project = byCalendar.get(calendarId);
    const { matches, ambiguous, orphans } = matchEvents(evs, { project });
    for (const m of matches) {
      covered.add(`${m.task.id}|${m.event.dateIso}`);
      out.link.push({ planId: project.id, planName: project.name, taskId: m.task.id, taskName: m.task.name, event: m.event, score: m.score, how: m.how });
    }
    out.ambiguous.push(...ambiguous.map((a) => ({ ...a, planId: project.id, planName: project.name })));
    out.orphans.push(...orphans.map((e) => ({ ...e, planId: project.id, planName: project.name })));
  }

  // What the planner pushes.
  const { events, unmapped } = desiredEvents(entries, { calendars, now, horizonDays, busy });
  out.create = events.filter((d) => inScope(projects.get(d.planId)) && !covered.has(`${d.taskId}|${d.dateIso}`) && !unlinkedTasks.has(d.taskId));
  out.unmapped = unmapped.filter((name) => inScope([...projects.values()].find((p) => p.name === name)));
  return out;
}

// ------------------------------------------------------ apply to a plan

const replacePin = (p, task, from, to) => {
  const i = from ? pinsOf(task).findIndex((q) => samePin(q, from)) : -1;
  if (!pinsOf(task).some((q) => samePin(q, to))) setPin(p, task.id, to, i >= 0 ? i : null);
  else if (i >= 0) task.calendar = { ...task.calendar, pins: pinsOf(task).filter((q, k) => k !== i) };
};
const linkOf = (ev, task) => ({ calendarId: ev.calendarId, eventId: ev.id, day: ev.dateIso, start: ev.start, minutes: ev.end - ev.start, title: ev.title, name: task.name, ...(isDone(task) ? { done: true } : {}) });
const putLink = (p, task, link) => setLinks(p, task.id, [...linksOf(task).filter((l) => !(l.calendarId === link.calendarId && l.eventId === link.eventId)), link]);

/** Record that a task's block is now this event: link it and pin it there. */
export function recordLink(p, taskId, ev) {
  const task = getTask(p, taskId);
  if (!task) return;
  replacePin(p, task, null, { day: ev.dateIso, start: ev.start, minutes: ev.end - ev.start });
  putLink(p, task, linkOf(ev, task));
}

/**
 * Write a run's calendar-side changes into one plan. Proposed links are
 * written only with `confirmLinks`; orphans become tasks only with `adoptNew`.
 * Returns how many tasks changed.
 */
export function applyToPlan(p, actions, { confirmLinks = false, adoptNew = false } = {}) {
  let changed = 0;
  const mine = (x) => x.planId === p.id;
  for (const c of actions.pull.filter(mine)) {
    const task = getTask(p, c.taskId);
    if (!task) continue;
    replacePin(p, task, c.changes.pin.from, c.changes.pin.to);
    if (c.changes.work) setTaskField(p, task.id, 'work', String(c.changes.work.to));
    if (c.changes.name) setTaskField(p, task.id, 'name', c.changes.name.to);
    if (c.changes.done) setTaskField(p, task.id, 'percent', 100);
    putLink(p, task, linkOf(c.event, task));
    logActivity(task, { kind: 'calendar', text: `Google Calendar: ${span(c.event)}${c.changes.name ? `, renamed “${c.changes.name.to}”` : ''}${c.changes.done ? ', done' : ''}${c.conflict ? ` (calendar won over the planner's ${c.plannerChange})` : ''}` });
    changed += 1;
  }
  for (const u of actions.unlink.filter(mine)) {
    const task = getTask(p, u.taskId);
    if (!task) continue;
    const pins = pinsOf(task).filter((q) => !samePin(q, u.link));
    setLinks(p, task.id, linksOf(task).filter((l) => !(l.calendarId === u.link.calendarId && l.eventId === u.link.eventId)));
    task.calendar = { ...task.calendar, pins };
    if (!linksOf(task).length) task.calendar.show = false;
    logActivity(task, { kind: 'calendar', text: `Event deleted on Google Calendar (${at(u.link)}); taken off the calendar.` });
    changed += 1;
  }
  if (confirmLinks) {
    const links = actions.link.filter(mine);
    for (const l of links) {
      const task = getTask(p, l.taskId);
      if (!task) continue;
      // A ✓ finishes the task only when every event it is linked to is ticked:
      // one lecture of two watched is not the pair.
      const all = [...links.filter((x) => x.taskId === task.id).map((x) => x.event.title), ...linksOf(task).filter((k) => !links.some((x) => x.event.id === k.eventId)).map((k) => k.title)];
      if (!isDone(task) && all.length && all.every((t) => parseTitle(t, p.name).done)) setTaskField(p, task.id, 'percent', 100);
      recordLink(p, task.id, l.event);
      changed += 1;
    }
  }
  if (adoptNew) {
    for (const ev of actions.orphans.filter(mine)) {
      const { name, done } = parseTitle(ev.title, p.name);
      const task = insertTask(p, p.tasks.length, { name: name || ev.title || 'Untitled task', duration: 1, level: 1, calendar: { show: true, timeBlockIds: [] } });
      setTaskField(p, task.id, 'work', String((ev.end - ev.start) / 60));
      if (done) setTaskField(p, task.id, 'percent', 100);
      recordLink(p, task.id, ev);
      logActivity(task, { kind: 'calendar', text: `Made from a Google Calendar event (${span(ev)}).` });
      changed += 1;
    }
  }
  return changed;
}

// ------------------------------------------------------- Google event shape

/** A desired event as the Calendar API takes it. */
export function toGoogleEvent(d, timeZone) {
  const when = (iso, minutes) => minutes >= 24 * 60
    ? { dateTime: `${fromDay(toDay(iso) + 1)}T00:00:00`, timeZone }
    : { dateTime: `${iso}T${clock(minutes)}:00`, timeZone };
  return {
    summary: d.title, description: d.description,
    start: when(d.dateIso, d.start), end: when(d.dateIso, d.end),
    extendedProperties: { private: { [PROP_PLAN]: d.planId, [PROP_TASK]: d.taskId } },
    transparency: 'opaque',
  };
}

/** A Calendar API event, normalised; null when it is cancelled or has no start. */
export function fromGoogleEvent(raw, calendarId) {
  if (!raw || raw.status === 'cancelled' || !raw.start) return null;
  const props = raw.extendedProperties?.private || {};
  const base = {
    id: raw.id, calendarId, planId: props[PROP_PLAN] || null, taskId: props[PROP_TASK] || null,
    title: raw.summary || '', description: raw.description || '', location: raw.location || '',
    transparent: raw.transparency === 'transparent', updatedMs: raw.updated ? Date.parse(raw.updated) : 0,
  };
  if (raw.start.date) {
    return { ...base, allDay: true, dateIso: raw.start.date, start: 0, end: 24 * 60, startMs: dayMs(raw.start.date), endMs: dayMs(raw.end?.date || raw.start.date) };
  }
  const s = new Date(raw.start.dateTime), e = new Date(raw.end?.dateTime || raw.start.dateTime);
  const dateIso = localDate(s);
  return { ...base, allDay: false, dateIso, start: minutesOf(s), end: localDate(e) === dateIso ? minutesOf(e) : 24 * 60, startMs: s.getTime(), endMs: e.getTime() };
}

/** The run as text: counts, then one line per change. */
export function describeActions(a, { unmapped = [], window = null } = {}) {
  const lines = [];
  if (window) lines.push(`Window ${window[0]} → ${window[1]}.`);
  lines.push(`create ${a.create.length}, update ${a.update.length}, delete ${a.delete.length}, pull ${a.pull.length}, unlink ${a.unlink.length}, link ${a.link.length}, ambiguous ${a.ambiguous.length}, new ${a.orphans.length}, keep ${a.keep}`);
  for (const d of a.create) lines.push(`+ ${span(d)} ${d.title}`);
  for (const { existing, desired } of a.update) lines.push(`~ ${span(desired)} ${desired.title} (was ${span(existing)} ${existing.title})`);
  for (const e of a.delete) lines.push(`- ${span(e)} ${e.title}`);
  for (const c of a.pull) {
    const from = c.changes.pin.from ? at(c.changes.pin.from) : 'unplaced';
    const bits = [`${from} → ${at(c.changes.pin.to)} (${c.changes.pin.to.minutes} min)`];
    if (c.changes.work) bits.push(`work ${c.changes.work.from}h → ${c.changes.work.to}h`);
    if (c.changes.name) bits.push(`renamed “${c.changes.name.to}”`);
    if (c.changes.done) bits.push('done');
    lines.push(`← ${c.taskName} (${c.planName}): ${bits.join(', ')}${c.conflict ? ` — conflict, calendar wins; planner had ${c.plannerChange}` : ''}`);
  }
  for (const u of a.unlink) lines.push(`event deleted: ${u.taskName} (${u.planName}) ${at(u.link)} — task taken off the calendar`);
  for (const l of a.link) lines.push(`link? ${span(l.event)} “${l.event.title}” → ${l.taskName} (${l.planName}) [${l.how}, ${l.score}]`);
  for (const x of a.ambiguous) lines.push(`ambiguous: ${span(x.event)} “${x.event.title}” — ${x.candidates.length} tasks: ${x.candidates.map((t) => t.name).join(' / ')}`);
  for (const e of a.orphans) lines.push(`new on calendar: ${span(e)} “${e.title}”`);
  if (unmapped.length) lines.push(`no calendar: ${unmapped.join(', ')}`);
  return lines.join('\n');
}


// ----------------------------------------------------- the app's own pieces

/**
 * Which Google calendar each plan has: the one it was given
 * (`project.gcal = { account, calendarId, calendarName }`), else the one
 * named for it — "Claude - <workspace> - <plan>" (what the planner's
 * calendars are called), or exactly the plan's name — among the calendars
 * the account may write to. A plan with neither has no calendar.
 *
 * @param plans projects (or `{ project }` entries)
 * @param calendars `{ account, id, name, access }` as the server lists them
 * @returns Map planId → { account, calendarId, calendarName, source: 'setting' | 'name' }
 */
export function matchPlanCalendars(plans, calendars) {
  const writable = (calendars || []).filter((c) => c && c.id && (c.access === 'owner' || c.access === 'writer'));
  const out = new Map();
  for (const raw of plans || []) {
    const project = raw?.project || raw;
    if (!project?.id) continue;
    const given = project.gcal;
    if (given && typeof given.calendarId === 'string' && given.calendarId) {
      out.set(project.id, { account: String(given.account || writable.find((c) => c.id === given.calendarId)?.account || ''), calendarId: given.calendarId, calendarName: String(given.calendarName || ''), source: 'setting' });
      continue;
    }
    const name = norm(project.name);
    const prefixed = writable.find((c) => { const m = /^claude - .+? - (.+)$/i.exec(String(c.name || '').trim()); return m && norm(m[1]) === name; });
    const exact = prefixed || writable.find((c) => norm(c.name) === name);
    if (exact) out.set(project.id, { account: exact.account, calendarId: exact.id, calendarName: exact.name, source: 'name' });
  }
  return out;
}

/** The plan-name → calendarId map that reconcile and desiredEvents take, from matchPlanCalendars. */
export function calendarIdsByPlanName(plans, map) {
  const out = {};
  for (const raw of plans || []) {
    const project = raw?.project || raw;
    const hit = project?.id && map.get(project.id);
    if (hit) out[project.name] = hit.calendarId;
  }
  return out;
}

/**
 * What the quiet read-back may apply without a person looking: the calendar's
 * own doing to linked events — pulls and unlinks. Everything the planner
 * would push, and every proposal, waits for the Sync button's review.
 */
export function readBackActions(actions) {
  return { ...actions, link: [], ambiguous: [], orphans: [], create: [], update: [], delete: [] };
}

/** How many things a run would do, proposals included. */
export const countOf = (a) => ['pull', 'unlink', 'link', 'ambiguous', 'orphans', 'create', 'update', 'delete'].reduce((n, k) => n + (a[k]?.length || 0), 0);
