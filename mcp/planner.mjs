// The MCP's side of sync: pull the workspace, read plans, edit one, push.
//
// Nothing here knows about MCP. It is a sync-kit device like the page and
// the Mac — its own store, its own id, its own cursors — that happens to be
// driven by tool calls instead of a person. An edit is: sync (so what is
// edited is the newest copy anyone has pushed), apply the same model
// functions the UI uses, serialize exactly as File ▸ Save does, write the
// record with a newer `updatedAt` and this device's `origin`, and sync again
// so the server has it and announces it. The page in front of the person
// pulls on that announcement and adopts the plan, unless it holds unsaved
// edits of its own — then it asks, as it always has.

import { SyncEngine, HttpTransport, MemoryStore, FileStore } from '../sync-kit/js/index.js';
import { parse, serialize } from '../src/io/json.js';
import { computeSchedule } from '../src/model/schedule.js';
import { validate } from '../src/model/validate.js';
import { formatAssignments, formatPredecessors, createProject, timeBlockIdsOf, getTimeBlock, pinsOf } from '../src/model/model.js';

export const FORMAT = 'project-planner';

export class PlannerClient {
  /**
   * @param {{ url: string, token?: string, deviceId?: string, store?: object, storePath?: string }} opts
   *   `url` is the workspace, e.g. `https://host/w/project`. One of `store`
   *   (an opened-or-not sync-kit store) or `storePath` (a FileStore, which
   *   keeps the cursors so each start pulls only what is new); a MemoryStore
   *   when neither is given.
   */
  static async open({ url, token, deviceId = 'mcp', store = null, storePath = null }) {
    if (!url) throw new Error('The sync URL is not set (PROJECT_SYNC_URL, e.g. https://host/w/project).');
    const s = store || (storePath ? new FileStore({ path: storePath }) : new MemoryStore());
    await s.open();
    const transport = new HttpTransport({ baseUrl: url, token, label: 'project' });
    const client = new PlannerClient(s, new SyncEngine(s, transport, deviceId), deviceId);
    await client.sync();
    return client;
  }

  constructor(store, engine, deviceId) {
    this.store = store;
    this.engine = engine;
    this.deviceId = deviceId;
    /** The plan `use_plan` chose, so later calls need not name it. */
    this.defaultPlanId = null;
  }

  /** One pull-and-push. Throws when the server cannot be reached or refuses. */
  async sync() {
    return this.engine.sync();
  }

  /** Every live plan record on the shelf. */
  async records() {
    const all = await this.store.all();
    return all.filter((r) => r && r.type === 'document' && r.format === FORMAT && !r.deletedAt && typeof r.body === 'string');
  }

  /** Plans by name, each with its parsed project and schedule. */
  async plans() {
    const out = [];
    for (const record of await this.records()) {
      let project;
      try { project = parse(record.body).project; } catch { continue; }
      out.push({ record, project });
    }
    return out.sort((a, b) => String(a.project.name).localeCompare(String(b.project.name)));
  }

  /**
   * Which plan: an id, an exact name, or a substring that matches one plan.
   * Nothing is ever guessed between two candidates — the error lists them.
   */
  async resolvePlan(ref) {
    const plans = await this.plans();
    const id = ref == null || ref === '' ? this.defaultPlanId : String(ref).trim();
    if (!id) throw new Error('Say which plan: pass `plan` (a name or id), or call use_plan once and it is remembered.');
    const q = id.toLowerCase();
    const exact = plans.filter((p) => p.record.id === id || String(p.project.name).toLowerCase() === q);
    if (exact.length === 1) return exact[0];
    const partial = exact.length ? exact : plans.filter((p) => String(p.project.name).toLowerCase().includes(q) || p.record.id.toLowerCase().includes(q));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) throw new Error(`Several plans match “${id}”: ${partial.map((p) => p.project.name).join(', ')}. Say which.`);
    throw new Error(`No plan matches “${id}”. list_plans shows what is on the shelf.`);
  }

  /** A plan, freshly pulled, with its schedule. */
  async load(ref) {
    await this.sync();
    const { record, project } = await this.resolvePlan(ref);
    return { record, project, schedule: computeSchedule(project) };
  }

  /**
   * Edit a plan and push it. `fn(project, schedule)` mutates the project and
   * may throw (the model's own messages); nothing is written when it does.
   * @returns {{ project, schedule, pushed: number, result: any }}
   */
  async edit(ref, fn) {
    const { record, project, schedule } = await this.load(ref);
    const result = fn(project, schedule);
    const body = serialize(project);
    const updatedAt = Math.max(Date.now(), (record.updatedAt || 0) + 1);
    await this.store.put([{ ...record, name: project.name, body, updatedAt, origin: this.deviceId }]);
    const { pushed } = await this.sync();
    return { project, schedule: computeSchedule(project), pushed, result };
  }

  /**
   * Make a new, empty plan and push it. Names are unique on the shelf,
   * ignoring case, so a later `use_plan` by name can never be ambiguous.
   * The new plan becomes the default for later calls, as after use_plan.
   * @returns {{ record, project, pushed: number }}
   */
  async create({ name, start = null, workDays = null }) {
    const clean = String(name ?? '').trim();
    if (!clean) throw new Error('A plan needs a name.');
    await this.sync();
    const taken = (await this.plans()).find((p) => String(p.project.name).toLowerCase() === clean.toLowerCase());
    if (taken) throw new Error(`A plan named “${taken.project.name}” already exists (${taken.record.id}).`);
    const project = createProject(clean, start);
    if (workDays) project.calendar = { ...project.calendar, workDays: [...workDays] };
    const now = Date.now();
    const record = { id: project.id, type: 'document', format: FORMAT, name: project.name, body: serialize(project), updatedAt: now, deletedAt: null, origin: this.deviceId };
    await this.store.put([record]);
    const { pushed } = await this.sync();
    this.defaultPlanId = project.id;
    return { record, project, pushed };
  }

  /** The live checks over a plan, as the Checks panel lists them. */
  checks(project, schedule = computeSchedule(project)) {
    return validate(project, schedule);
  }
}

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** One task as a row of the task list: what every read tool returns. */
export function taskRow(project, schedule, task, index) {
  const info = schedule.tasks[task.id] || {};
  const c = task.constraint || { type: 'ASAP', date: null };
  return {
    row: index + 1,
    id: task.id,
    wbs: info.wbs ?? null,
    name: task.name,
    level: task.level,
    summary: !!info.summary,
    milestone: !!info.milestone,
    duration: info.summary ? info.duration : task.duration,
    work: info.work ?? null,
    start: info.startIso ?? null,
    finish: info.finishIso ?? null,
    deadline: task.deadline || null,
    percent: info.percent ?? task.percent ?? 0,
    slack: info.slack ?? null,
    critical: !!info.critical,
    predecessors: formatPredecessors(project, task),
    resources: formatAssignments(project, task),
    urgency: task.urgency || 'normal',
    constraint: c.type === 'ASAP' || !c.type ? 'ASAP' : `${c.type} ${c.date || ''}`.trim(),
    schedule: timeBlockIdsOf(task).map((id) => getTimeBlock(project, id)?.name).filter(Boolean).join(', ') || 'any',
    pins: pinsOf(task).map((x) => `${x.day} ${hhmm(x.start)}-${hhmm(x.start + x.minutes)}`),
    notes: task.notes || '',
  };
}
