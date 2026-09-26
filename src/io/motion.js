// A Motion export (Settings ▸ Export data: a ZIP of JSON) as plans.
//
// Motion keeps a workspace › project › task tree; each Motion project becomes
// a plan filed under its workspace, and a workspace's tasks with no project
// gather in one plan of their own. A task brings what Motion knows about it:
// its duration (the hours it takes), minimum chunk, start, deadline and
// whether that deadline is hard, priority, labels, assignee, description,
// when it was completed or archived, and the time actually worked — Motion's
// completed chunks — as logged time at the hour it was worked. The export
// has no stages or statuses for tasks, so tasks arrive in no stage, in Todo
// or Completed.

import { createProject, newTask, addResource, assign } from '../model/model.js';
import { BLOCK_CHOICES } from '../model/agenda.js';

const PRIORITY = { ASAP: 'now', HIGH: 'high', MEDIUM: 'normal', LOW: 'low' };
const two = (n) => String(n).padStart(2, '0');
/** A timestamp as the local day, 'YYYY-MM-DD'. */
const localDay = (ts) => { if (ts === null || ts === undefined || ts === '') return null; const d = new Date(ts); return Number.isNaN(+d) ? null : `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; };
const localStamp = (ts) => { if (ts === null || ts === undefined || ts === '') return null; const d = new Date(ts); return Number.isNaN(+d) ? null : `${localDay(ts)}T${two(d.getHours())}:${two(d.getMinutes())}`; };
/** Motion's start dates are midnight UTC for a calendar day: the day is the date part. */
const startDay = (ts) => (typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}/.test(ts) ? ts.slice(0, 10) : null);

/** Motion's rich text as plain text: paragraphs, list items and line breaks kept. */
export function htmlToText(html) {
  if (!html) return '';
  let s = String(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*data-checked="true"[^>]*>/gi, '\n[x] ')
    .replace(/<\s*li[^>]*data-checked="false"[^>]*>/gi, '\n[ ] ')
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    .replace(/<\/\s*(p|div|h\d|ul|ol|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** The block size nearest a minimum chunk, in hours. */
const blockFor = (minutes) => BLOCK_CHOICES.reduce((best, h) => (Math.abs(h * 60 - minutes) < Math.abs(best * 60 - minutes) ? h : best), BLOCK_CHOICES[0]);

/**
 * @param {{ projects: object[], tasks: object[] }} data  the `items` of projects.json and tasks.json
 * @returns {{ workspaces: string[], plans: object[], counts: object }}
 */
export function motionToPlans({ projects = [], tasks = [] }) {
  const byProject = new Map();
  const loose = new Map();                       // workspace name → tasks with no project
  for (const t of tasks) {
    if (t?.project?.id) {
      if (!byProject.has(t.project.id)) byProject.set(t.project.id, []);
      byProject.get(t.project.id).push(t);
    } else {
      const ws = t?.workspace?.name || 'Motion';
      if (!loose.has(ws)) loose.set(ws, []);
      loose.get(ws).push(t);
    }
  }
  const workspaces = new Set();
  const plans = [];
  const counts = { projects: 0, tasks: 0, open: 0, completed: 0, archived: 0, worked: 0 };

  const build = ({ name, workspace, list, archived = false, archivedAt = null, sourceId = null, created = null }) => {
    if (workspace) workspaces.add(workspace);
    const starts = list.map((t) => startDay(t.startDate)).filter(Boolean).sort();
    const p = createProject(name || 'Untitled project', starts[0] || localDay(created) || undefined);
    p.workspaceName = workspace || null;       // resolved to an id when the workspaces exist
    p.archived = !!archived;
    p.archivedAt = archivedAt;
    p.motionId = sourceId;
    const people = new Map();
    const personFor = (a) => {
      if (!a?.name) return null;
      const key = (a.email || a.name).toLowerCase();
      if (!people.has(key)) people.set(key, addResource(p, { name: a.name, email: a.email || '' }));
      return people.get(key);
    };
    // Oldest first, the way the work happened.
    for (const m of [...list].sort((a, b) => String(a.createdTime).localeCompare(String(b.createdTime)))) {
      const minutes = Number.isFinite(+m.duration) && m.duration !== null ? +m.duration : null;
      const hours = minutes !== null ? Math.round((minutes / 60) * 100) / 100 : null;
      const done = !!m.completedTime;
      const t = newTask({
        name: String(m.name || 'Untitled task'), level: 1,
        // Days open, for the Gantt: what the hours need at a full day each.
        duration: hours ? Math.max(1, Math.ceil(hours / 8)) : 1,
        work: hours,
        notes: htmlToText(m.description),
        deadline: localDay(m.dueDate),
        urgency: PRIORITY[m.priorityLevel] || 'normal',
        percent: done ? 100 : 0,
        archived: !!m.archivedTime,
        calendar: { show: !!m.isAutoScheduled && !done && !m.archivedTime, timeBlockIds: [] },
      });
      if (m.deadlineType === 'HARD' && t.deadline) t.hardDeadline = true;
      const start = startDay(m.startDate);
      if (start && !done) t.constraint = { type: 'SNET', date: start };
      if (done) t.doneAt = localStamp(m.completedTime);
      if (m.minimumDuration === null || m.minimumDuration === undefined) t.calendar.whole = true;
      else t.calendar.blockHours = blockFor(+m.minimumDuration);
      const labels = (m.labels || []).map((l) => l?.label?.name || l?.name).filter(Boolean);
      if (labels.length) t.labels = [...new Set(labels)];
      t.activity = [{ at: localStamp(m.createdTime) || localStamp(Date.now()), kind: 'created', text: 'in Motion' }];
      for (const c of m.comments || []) {
        const text = htmlToText(c?.content || c?.text || c?.body || '');
        if (text) t.activity.push({ at: localStamp(c.createdTime || c.createdAt) || t.activity[0].at, kind: 'comment', text });
      }
      if (done) t.activity.push({ at: t.doneAt, kind: 'change', field: 'progress', from: '0%', to: '100%' });
      p.tasks.push(t);
      const who = personFor(m.assignee);
      if (who) assign(p, t.id, who.id, 1);
      // Time worked, where it was worked: Motion's completed chunks.
      for (const ch of m.chunks || []) {
        if (!ch?.completedTime || !ch.scheduledStart || !(+ch.duration > 0)) continue;
        const at = new Date(ch.scheduledStart);
        if (Number.isNaN(+at)) continue;
        p.timesheets.push({
          id: `ts_${Math.random().toString(36).slice(2, 12)}`, taskId: t.id, resourceId: who?.id || null,
          date: localDay(ch.scheduledStart), start: at.getHours() * 60 + at.getMinutes(),
          hours: Math.round((+ch.duration / 60) * 100) / 100, note: 'Worked (Motion)',
        });
        counts.worked++;
      }
      counts.tasks++;
      if (done) counts.completed++;
      if (t.archived) counts.archived++;
      if (!done && !t.archived) counts.open++;
    }
    plans.push(p);
  };

  for (const mp of projects) {
    const status = mp?.status?.name || '';
    build({
      name: mp.name, workspace: mp?.workspace?.name || null, list: byProject.get(mp.id) || [],
      archived: status === 'Completed' || status === 'Cancelled', archivedAt: mp.updatedTime ? localStamp(mp.updatedTime) : null,
      sourceId: mp.id, created: mp.createdTime,
    });
    counts.projects++;
    byProject.delete(mp.id);
  }
  // Tasks whose project is not in the export still belong somewhere.
  for (const [id, list] of byProject) build({ name: list[0]?.project?.name || 'Motion project', workspace: list[0]?.workspace?.name || null, list, sourceId: id });
  for (const [ws, list] of loose) build({ name: `${ws} — tasks without a project`, workspace: ws, list });
  return { workspaces: [...workspaces].sort(), plans, counts };
}

// -------------------------------------------------------------- schedules

const MOTION_DAYS = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
/** "8:30am" → "08:30"; null when it is not a time. */
function clock(text) {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*$/i.exec(String(text || ''));
  if (!m) return null;
  let h = +m[1] % 12;
  if (/pm/i.test(m[3])) h += 12;
  return `${two(h)}:${m[2] || '00'}`;
}

/**
 * Motion's schedules (user/settings.json › schedules) as the planner's.
 * Each keeps Motion's hours, day by day; `work` is the one Motion gives every
 * task that names none, whatever it has been renamed to, so it is the
 * default. Ids are stable, so importing again updates rather than doubles.
 * @returns {{ blocks: object[], defaultId: string|null }}
 */
export function motionSchedules(settings) {
  const all = settings?.schedules && typeof settings.schedules === 'object' ? settings.schedules : {};
  const blocks = [];
  for (const [key, s] of Object.entries(all)) {
    const slots = [];
    for (const [dayName, ranges] of Object.entries(s?.schedule || {})) {
      const day = MOTION_DAYS[dayName];
      if (day === undefined || !Array.isArray(ranges)) continue;
      for (const r of ranges) {
        const [a, b] = String(r?.range || '').split('-');
        const from = clock(a);
        const to = clock(b);
        if (from && to && to > from) slots.push({ day, from, to });
      }
    }
    if (!slots.length) continue;
    slots.sort((x, y) => x.day - y.day || x.from.localeCompare(y.from));
    blocks.push({
      id: `tb_motion_${key.replace(/[^\w-]/g, '_')}`, name: String(s.title || key).trim() || key,
      from: slots.map((x) => x.from).sort()[0], to: slots.map((x) => x.to).sort().at(-1),
      days: [...new Set(slots.map((x) => x.day))].sort(), slots,
    });
  }
  const main = blocks.find((b) => b.id === 'tb_motion_work');
  return { blocks, defaultId: main ? main.id : null };
}
