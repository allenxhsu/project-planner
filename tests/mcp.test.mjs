// The MCP server's tools, against the real sync server.
//
// Claude reads and edits plans through `mcp/`: it pulls the workspace, edits
// a plan with the same model functions the UI uses, and pushes the result,
// so the page in front of the person picks it up on its next sync. These
// tests drive the tool functions directly — the MCP transport is a thin
// wrapper around them — with the REAL server (sync-kit/server/dist) on an
// ephemeral port and a second device standing in for the open page, so every
// edit is asserted where it matters: on the server and on the other device.
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SyncEngine, HttpTransport, MemoryStore } from '../sync-kit/js/index.js';
import { createProject, insertTask, link, addResource, assign } from '../src/model/model.js';
import { serialize, parse } from '../src/io/json.js';
import { PlannerClient } from '../mcp/planner.mjs';
import { TOOLS, runTool } from '../mcp/tools.mjs';

const KIT = fileURLToPath(new URL('../../sync-kit/server/dist/', import.meta.url));
const present = existsSync(`${KIT}server.js`);

const WORKSPACE = 'project';
const TOKEN = 'a-test-token-at-least-12-chars';

describe('MCP tools read and edit plans through sync', { skip: present ? false : 'sync-kit/server is not checked out beside this repo' }, () => {
  let base = null;
  let running = null;
  /** The open page: its own store and device id. */
  let page = null;
  /** What Claude talks to. */
  let client = null;

  async function startServer() {
    const { createApp } = await import(`${KIT}server.js`);
    const { loadConfig } = await import(`${KIT}config.js`);
    const { createStorage } = await import(`${KIT}storage/index.js`);
    const config = loadConfig({ STORAGE: 'memory', PORT: '0', HOST: '127.0.0.1', SYNC_TOKENS: `${WORKSPACE}:test:${TOKEN}` });
    const storage = await createStorage(config);
    const app = createApp(config, storage);
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    running = app;
    return `http://127.0.0.1:${app.address().port}/w/${WORKSPACE}`;
  }

  async function device(id) {
    const store = new MemoryStore();
    await store.open();
    const engine = new SyncEngine(store, new HttpTransport({ baseUrl: base, token: TOKEN }), id);
    return { id, store, engine, sync: () => engine.sync() };
  }

  /** A plan record exactly as the page writes one. */
  const record = (p, origin) => ({
    id: p.id, type: 'document', format: 'project-planner', name: p.name,
    body: serialize(p), updatedAt: Date.now(), deletedAt: null, origin,
  });

  /** The page's copy of a plan, after it has synced. */
  async function onPage(planId) {
    await page.sync();
    const rec = await page.store.get(planId);
    return rec ? parse(rec.body).project : null;
  }

  /** A fresh device that has seen nothing: what the server itself holds. */
  async function onServer(planId) {
    const fresh = await device(`audit_${Math.random().toString(36).slice(2, 8)}`);
    await fresh.sync();
    const rec = await fresh.store.get(planId);
    return rec && !rec.deletedAt ? parse(rec.body).project : null;
  }

  function fixture() {
    // Monday 2 Nov 2026, the default Mon–Fri calendar.
    const p = createProject('Website relaunch', '2026-11-02');
    p.id = 'plan_relaunch';
    const phase = insertTask(p, 0, { name: 'Phase A', level: 1 });
    const design = insertTask(p, 1, { name: 'Design', level: 2, duration: 3 });
    const build = insertTask(p, 2, { name: 'Build', level: 2, duration: 2, deadline: '2026-11-06' });
    const review = insertTask(p, 3, { name: 'Review', level: 1, duration: 1, deadline: '2026-11-05' });
    const finished = insertTask(p, 4, { name: 'Done thing', level: 1, duration: 1, percent: 100 });
    link(p, design.id, build.id);
    link(p, build.id, review.id);
    const ana = addResource(p, { name: 'Ana' });
    assign(p, design.id, ana.id, 1);
    void phase; void finished;
    const side = createProject('Side plan', '2026-11-02');
    side.id = 'plan_side';
    insertTask(side, 0, { name: 'Lone task', level: 1, duration: 1 });
    return { p, side };
  }

  before(async () => {
    base = await startServer();
    page = await device('portal');
    const { p, side } = fixture();
    await page.store.put([record(p, page.id), record(side, page.id)]);
    await page.sync();
    const store = new MemoryStore();
    await store.open();
    client = await PlannerClient.open({ url: base, token: TOKEN, deviceId: 'mcp-test', store });
  });

  after(() => running?.close());

  const run = (name, args = {}) => runTool(client, name, args);
  const fails = async (name, args, re) => {
    await assert.rejects(() => run(name, args), (err) => { assert.match(err.message, re); return true; });
  };

  test('every tool has a name, a description and a schema', () => {
    const names = TOOLS.map((t) => t.name);
    for (const t of TOOLS) {
      assert.ok(t.name && t.description && t.inputSchema, t.name);
    }
    for (const expected of ['list_plans', 'use_plan', 'get_plan', 'find_task', 'due_tasks', 'checks', 'add_task', 'edit_task', 'link_tasks', 'unlink_tasks', 'move_task', 'delete_task', 'assign_task', 'unassign_task']) {
      assert.ok(names.includes(expected), `${expected} is a tool`);
    }
    assert.equal(new Set(names).size, names.length, 'no duplicate names');
  });

  test('list_plans: every plan on the shelf, with its size and progress', async () => {
    const { data, text } = await run('list_plans');
    const names = data.map((p) => p.name).sort();
    assert.deepEqual(names, ['Side plan', 'Website relaunch']);
    const relaunch = data.find((p) => p.name === 'Website relaunch');
    assert.equal(relaunch.id, 'plan_relaunch');
    assert.equal(relaunch.tasks, 5);
    assert.equal(relaunch.start, '2026-11-02');
    assert.equal(relaunch.finish, '2026-11-09', 'Review lands on the Monday after');
    assert.match(text, /Website relaunch/);
  });

  test('a plan is named once, then remembered; naming is forgiving but never guesses', async () => {
    await fails('get_plan', {}, /which plan/i);
    await fails('use_plan', { plan: 'nothing like this' }, /No plan matches/);
    await fails('use_plan', { plan: 'n' }, /Several plans match.*Side plan.*Website relaunch/s);
    const { data } = await run('use_plan', { plan: 'relaunch' });
    assert.equal(data.id, 'plan_relaunch');
    const again = await run('get_plan');
    assert.equal(again.data.plan.name, 'Website relaunch', 'remembered');
    const byId = await run('use_plan', { plan: 'plan_side' });
    assert.equal(byId.data.name, 'Side plan', 'an id works too');
    await run('use_plan', { plan: 'Website relaunch' });
  });

  test('get_plan: rows as the task list shows them, with the schedule', async () => {
    const { data, text } = await run('get_plan');
    assert.equal(data.plan.id, 'plan_relaunch');
    const rows = data.tasks;
    assert.deepEqual(rows.map((t) => t.row), [1, 2, 3, 4, 5]);
    assert.deepEqual(rows.map((t) => t.name), ['Phase A', 'Design', 'Build', 'Review', 'Done thing']);
    const [phase, design, build, review] = rows;
    assert.equal(phase.summary, true);
    assert.equal(phase.level, 1);
    assert.equal(design.level, 2);
    assert.equal(design.start, '2026-11-02');
    assert.equal(design.finish, '2026-11-04');
    assert.equal(design.resources, 'Ana');
    assert.equal(build.predecessors, '2', 'links are row numbers, as typed in the UI');
    assert.equal(build.finish, '2026-11-06');
    assert.equal(build.deadline, '2026-11-06');
    assert.equal(review.finish, '2026-11-09');
    assert.equal(review.deadline, '2026-11-05');
    assert.ok(review.slack < 0, 'a missed deadline is negative slack');
    assert.equal(typeof review.critical, 'boolean');
    assert.match(text, /2\s+.*Design/);
    const open = await run('get_plan', { include_done: false });
    assert.deepEqual(open.data.tasks.map((t) => t.name), ['Phase A', 'Design', 'Build', 'Review'], 'done tasks can be left out');
  });

  test('find_task: by row, by exact name, by unique prefix; ambiguity is reported, not guessed', async () => {
    assert.equal((await run('find_task', { task: '3' })).data.matches[0].name, 'Build');
    assert.equal((await run('find_task', { task: 3 })).data.matches[0].name, 'Build');
    assert.equal((await run('find_task', { task: 'review' })).data.matches[0].row, 4);
    assert.equal((await run('find_task', { task: 'des' })).data.matches[0].name, 'Design');
    const several = await run('find_task', { task: 'e' });
    assert.ok(several.data.matches.length > 1, 'a search lists every candidate');
    await fails('edit_task', { task: 'e', deadline: '2026-12-01' }, /Several tasks match/);
    await fails('edit_task', { task: 'zzz', deadline: '2026-12-01' }, /No task matches/);
    await fails('edit_task', { task: 99, deadline: '2026-12-01' }, /No task matches|row 99/i);
  });

  test('edit_task: fields change, the server and the page agree, and a bad value changes nothing', async () => {
    const { data } = await run('edit_task', { task: 'Build', deadline: '2026-11-13', percent: 50, duration: '3d', urgency: 'high', notes: 'Pushed out a week' });
    assert.equal(data.row, 3);
    assert.equal(data.after.deadline, '2026-11-13');
    assert.equal(data.after.percent, 50);
    assert.equal(data.after.duration, 3);
    assert.equal(data.after.finish, '2026-11-09', 'three days from Thursday is Monday');
    assert.equal(data.after.urgency, 'high');
    assert.equal(data.before.deadline, '2026-11-06');
    assert.equal(data.pushed, 1, 'one record went to the server');

    const server = await onServer('plan_relaunch');
    assert.equal(server.tasks[2].deadline, '2026-11-13', 'the server has it');
    assert.equal(server.tasks[2].notes, 'Pushed out a week');
    const shown = await onPage('plan_relaunch');
    assert.equal(shown.tasks[2].percent, 50, 'and so does the page');

    await fails('edit_task', { task: 'Build', deadline: 'next friday' }, /deadline is a date/i);
    await fails('edit_task', { task: 'Build', percent: 140 }, /0 to 100/);
    await fails('edit_task', { task: 'Build' }, /nothing to change/i);
    assert.equal((await onServer('plan_relaunch')).tasks[2].deadline, '2026-11-13', 'a refused edit pushes nothing');
  });

  test('edit_task: a start date pins the task, and the name can change', async () => {
    const { data } = await run('edit_task', { task: 'Review', start: '2026-11-16', name: 'Final review' });
    assert.equal(data.after.name, 'Final review');
    assert.equal(data.after.start, '2026-11-16');
    assert.equal(data.after.constraint, 'SNET 2026-11-16');
    assert.equal((await onServer('plan_relaunch')).tasks[3].name, 'Final review');
  });

  test('add_task: at the end, after a task, or under a summary', async () => {
    const end = await run('add_task', { name: 'Launch', duration: '0d', predecessors: '4' });
    assert.equal(end.data.row, 6);
    assert.equal(end.data.milestone, true);
    const after = await run('add_task', { name: 'Test', after: 'Build', duration: 2, resources: 'Ana' });
    assert.equal(after.data.row, 4, 'right after Build, which has no subtasks');
    assert.equal(after.data.level, 2, 'at the same level as Build');
    const under = await run('add_task', { name: 'Wireframes', under: 'Phase A', duration: 1, deadline: '2026-11-03' });
    const plan = (await run('get_plan')).data.tasks;
    const wire = plan.find((t) => t.name === 'Wireframes');
    assert.equal(wire.level, 2);
    assert.equal(wire.row, 5, 'the last child of Phase A');
    assert.deepEqual(plan.map((t) => t.name), ['Phase A', 'Design', 'Build', 'Test', 'Wireframes', 'Final review', 'Done thing', 'Launch']);
    assert.equal((await onServer('plan_relaunch')).tasks.length, 8);
    await fails('add_task', { name: '' }, /name/i);
  });

  test('link_tasks and unlink_tasks, and a cycle is refused', async () => {
    const linked = await run('link_tasks', { from: 'Test', to: 'Final review', type: 'FS', lag: 1 });
    assert.match(linked.text, /Test.*Final review/s);
    const review = (await run('get_plan')).data.tasks.find((t) => t.name === 'Final review');
    assert.equal(review.predecessors, '3, 4FS+1d');
    await fails('link_tasks', { from: 'Final review', to: 'Design' }, /circular/i);
    await fails('link_tasks', { from: 'Test', to: 'Final review', type: 'XX' }, /link type/i);
    await run('unlink_tasks', { from: 'Test', to: 'Final review' });
    const again = (await run('get_plan')).data.tasks.find((t) => t.name === 'Final review');
    assert.equal(again.predecessors, '3');
    assert.equal((await onServer('plan_relaunch')).tasks.find((t) => t.name === 'Final review').predecessors.length, 1);
  });

  test('move_task: up, down, indent, outdent', async () => {
    await run('move_task', { task: 'Test', direction: 'up' });
    let names = (await run('get_plan')).data.tasks.map((t) => t.name);
    assert.deepEqual(names.slice(1, 4), ['Design', 'Test', 'Build']);
    await run('move_task', { task: 'Test', direction: 'down' });
    names = (await run('get_plan')).data.tasks.map((t) => t.name);
    assert.deepEqual(names.slice(1, 4), ['Design', 'Build', 'Test']);
    await run('move_task', { task: 'Launch', direction: 'indent' });
    let rows = (await run('get_plan')).data.tasks;
    assert.equal(rows.find((t) => t.name === 'Launch').level, 2);
    assert.equal(rows.find((t) => t.name === 'Done thing').summary, true, 'Done thing became its summary');
    await run('move_task', { task: 'Launch', direction: 'outdent' });
    rows = (await run('get_plan')).data.tasks;
    assert.equal(rows.find((t) => t.name === 'Launch').level, 1);
    await fails('move_task', { task: 'Phase A', direction: 'up' }, /cannot move/i);
    await fails('move_task', { task: 'Launch', direction: 'sideways' }, /direction/i);
  });

  test('assign_task and unassign_task: a new name joins the plan’s resources', async () => {
    const { data } = await run('assign_task', { task: 'Build', resource: 'Ben', units: 0.5 });
    assert.equal(data.resources, 'Ben [50%]');
    const build = (await onServer('plan_relaunch')).tasks.find((t) => t.name === 'Build');
    assert.equal(build.assignments.length, 1);
    const again = await run('assign_task', { task: 'Build', resource: 'ana' });
    assert.equal(again.data.resources, 'Ben [50%], Ana', 'an existing person is matched by name, not duplicated');
    assert.equal((await onServer('plan_relaunch')).resources.filter((r) => r.name === 'Ana').length, 1);
    await run('unassign_task', { task: 'Build', resource: 'Ben' });
    assert.equal((await run('get_plan')).data.tasks.find((t) => t.name === 'Build').resources, 'Ana');
    await fails('unassign_task', { task: 'Build', resource: 'Nobody' }, /No resource/i);
  });

  test('delete_task takes its subtasks with it', async () => {
    await run('add_task', { name: 'Temp child', under: 'Phase A' });
    const { data } = await run('delete_task', { task: 'Phase A' });
    assert.equal(data.removed, 6, 'the summary and its five children');
    const names = (await run('get_plan')).data.tasks.map((t) => t.name);
    assert.deepEqual(names, ['Final review', 'Done thing', 'Launch']);
    assert.equal((await onPage('plan_relaunch')).tasks.length, 3);
  });

  test('due_tasks: across every plan, by finish or deadline, open tasks only', async () => {
    const { data, text } = await run('due_tasks', { from: '2026-11-02', to: '2026-11-02' });
    const items = data.map((d) => `${d.plan}: ${d.task}`);
    assert.ok(items.includes('Side plan: Lone task'), 'the other plan is searched too');
    assert.ok(!items.some((i) => i.includes('Done thing')), 'a finished task is not due');
    assert.match(text, /Lone task/);
    const wide = await run('due_tasks', { from: '2026-11-02', to: '2026-11-30', plan: 'relaunch' });
    assert.ok(wide.data.every((d) => d.plan === 'Website relaunch'), 'or narrowed to one plan');
    assert.ok(wide.data.some((d) => d.task === 'Final review' && d.deadline === '2026-11-05'), 'a deadline in range counts even when the finish is not');
    await fails('due_tasks', { from: 'tomorrow' }, /date/i);
    const today = await run('due_tasks', {});
    assert.ok(Array.isArray(today.data), 'with no dates: today');
  });

  test('checks: what the live checks would say', async () => {
    const { data } = await run('checks');
    assert.ok(data.some((i) => i.code === 'deadline-missed' && /Final review/.test(i.text)), JSON.stringify(data));
  });

  test('an edit made on the page between two MCP edits survives', async () => {
    // The page renames a task and syncs...
    const rec = await page.store.get('plan_side');
    const p = parse(rec.body).project;
    p.tasks[0].name = 'Lone task, renamed on the page';
    await page.store.put([{ ...rec, body: serialize(p), updatedAt: Date.now() + 5, origin: page.id }]);
    await page.sync();
    // ...and the MCP edits the same plan without having been told.
    await run('use_plan', { plan: 'Side plan' });
    await run('edit_task', { task: 1, percent: 25 });
    const server = await onServer('plan_side');
    assert.equal(server.tasks[0].name, 'Lone task, renamed on the page', 'the MCP pulled first');
    assert.equal(server.tasks[0].percent, 25, 'and applied its edit on top');
  });
});
