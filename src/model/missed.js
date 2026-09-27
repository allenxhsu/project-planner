// Blocks that came and went without the task being done.
//
// The planner lays work from now on and forgets where it put it, so a block
// at two o'clock that nobody did is, by four, simply laid again later — and
// the afternoon reads as if nothing had been planned there. Motion keeps it
// where it was, with a "!", until someone says what happened. So does this:
// the calendar remembers the blocks it last drew, and any whose time has
// passed with the task still open is kept, to be drawn there and resolved —
// done then (its time logged there), done in part, or not done (dismissed;
// the work is on the calendar again from now on).

import { fromDay } from './calendar.js';

/** How long a missed block is kept waiting to be resolved. */
export const MISSED_DAYS = 30;

export const missedKey = (m) => `${m.planId}|${m.taskId}|${m.day}|${m.start}`;

/**
 * The missed list, with what has passed since the calendar last drew:
 * `saved` is that drawing ({ day, blocks: [{planId, taskId, start, end}] }).
 * A block from an earlier day has passed whole; today's has passed once its
 * end, and the half hour's grace to tick it off, is behind the clock.
 */
export function carryMissed(list, saved, { todayNum, nowMin, grace = 30 }) {
  const out = (list || []).filter((m) => m.day >= todayNum - MISSED_DAYS);
  const seen = new Set(out.map(missedKey));
  if (saved && Number.isInteger(saved.day) && saved.day <= todayNum) {
    for (const b of saved.blocks || []) {
      if (saved.day === todayNum && b.end + grace > nowMin) continue;
      const m = { planId: b.planId, taskId: b.taskId, day: saved.day, start: b.start, end: b.end };
      if (seen.has(missedKey(m))) continue;
      seen.add(missedKey(m));
      out.push(m);
    }
  }
  return out;
}

/**
 * The missed blocks worth drawing: the task is still there, still open, not
 * archived or cancelled, and nobody has logged time over those hours (that is
 * a worked block, drawn already). `entries` are { project, schedule }.
 */
export function missedBlocks(list, entries, { dismissed = new Set() } = {}) {
  const out = [];
  for (const m of list || []) {
    if (dismissed.has(missedKey(m))) continue;
    const e = entries.find((x) => x.project.id === m.planId);
    const t = e?.project.tasks.find((x) => x.id === m.taskId);
    if (!t || t.archived) continue;
    if ((e.schedule?.tasks?.[t.id]?.percent ?? 0) >= 100) continue;
    const iso = fromDay(m.day);
    const covered = (e.project.timesheets || []).some((x) => x.taskId === t.id && x.date === iso && Number.isInteger(x.start)
      && x.start < m.end && x.start + Math.round((+x.hours || 0) * 60) > m.start);
    if (covered) continue;
    out.push({ ...m, planName: e.project.name, dateIso: iso, minutes: m.end - m.start, missed: true, key: missedKey(m) });
  }
  return out.sort((a, b) => a.day - b.day || a.start - b.start);
}
