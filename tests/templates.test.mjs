import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, insertTask, setTaskField, link, addResource, assign, addTimesheet, setSummaryStage, phases, phaseOf, getPhase } from '../src/model/model.js';
import { DEFAULT_STAGE_SET, cleanStageSet } from '../src/model/processes.js';
import { stageGroups, addStagesFrom, templateFrom } from '../src/model/templates.js';
import { serialize, parse } from '../src/io/json.js';

const set = cleanStageSet(DEFAULT_STAGE_SET);
const std = (key) => set.find((s) => s.key === key);
const outline = (p) => p.tasks.map((t) => `${'  '.repeat(t.level - 1)}${t.name}`);

/** A worked project: Design and Build stages, a group that is not a stage, and a loose task. */
function chiller() {
  const p = createProject('Chiller WO 421', '2026-06-01');
  const ann = addResource(p, { name: 'Ann Lee', group: 'Electrical' });
  const d = insertTask(p, p.tasks.length, { name: 'Design', level: 1 });
  const layout = insertTask(p, p.tasks.length, { name: 'Layout', level: 2 });
  const drawings = insertTask(p, p.tasks.length, { name: 'Electrical drawings', level: 2 });
  const b = insertTask(p, p.tasks.length, { name: 'Build', level: 1 });
  const frame = insertTask(p, p.tasks.length, { name: 'Weld frame', level: 2 });
  const visit = insertTask(p, p.tasks.length, { name: 'Site visit', level: 1 });
  const travel = insertTask(p, p.tasks.length, { name: 'Book travel', level: 2 });
  const loose = insertTask(p, p.tasks.length, { name: 'Kick-off call', level: 1 });
  setSummaryStage(p, d.id, std('design'));
  setSummaryStage(p, b.id, std('build'));
  setTaskField(p, layout.id, 'work', '4');
  setTaskField(p, drawings.id, 'work', '8');
  setTaskField(p, frame.id, 'skill', 'Welding');
  link(p, layout.id, drawings.id);
  link(p, drawings.id, frame.id);
  assign(p, drawings.id, ann.id, 1);
  // It has been worked: progress, dates, logged time.
  setTaskField(p, layout.id, 'percent', 100);
  setTaskField(p, drawings.id, 'deadline', '2026-06-20');
  setTaskField(p, drawings.id, 'start', '2026-06-10');
  addTimesheet(p, { taskId: layout.id, resourceId: ann.id, date: '2026-06-02', start: 540, hours: 4, note: 'Worked' });
  return { p, d, b, visit, layout, drawings, frame, travel, loose };
}

test('a project’s stages are listed with their tasks; other groups and loose tasks too', () => {
  const { p, d, b, visit, layout, drawings, frame, travel, loose } = chiller();
  const groups = stageGroups(p, set);
  assert.deepEqual(groups.map((g) => [g.kind, g.name, g.stageKey, g.taskIds]), [
    ['stage', 'Design', 'design', [layout.id, drawings.id]],
    ['stage', 'Build', 'build', [frame.id]],
    ['group', 'Site visit', null, [travel.id]],
    ['loose', 'Other tasks', null, [loose.id]],
  ]);
  assert.equal(groups[0].summaryId, d.id);
  assert.equal(groups[1].summaryId, b.id);
  assert.equal(groups[2].summaryId, visit.id);
});

test('picked stages come into a project with their picked tasks, links and work — and none of the history', () => {
  const { p: template, layout, drawings, frame } = chiller();
  const groups = stageGroups(template, set);
  const target = createProject('Chiller WO 500', '2026-10-01');
  const result = addStagesFrom(target, template, [
    { id: groups[0].id, taskIds: [layout.id, drawings.id] },
    { id: groups[1].id, taskIds: [frame.id] },
  ], set);
  assert.deepEqual(result, { stages: 2, merged: 0, tasks: 3, skipped: 0 });
  assert.deepEqual(outline(target), ['Design', '  Layout', '  Electrical drawings', 'Build', '  Weld frame']);
  assert.deepEqual(phases(target).map((ph) => [ph.name, ph.stageKey]), [['Design', 'design'], ['Build', 'build']]);
  const [, l, e, , w] = target.tasks;
  assert.equal(phaseOf(target, e.id), phases(target)[0].id);
  assert.deepEqual(e.predecessors.map((x) => x.id), [l.id], 'a link inside the copy');
  assert.deepEqual(w.predecessors.map((x) => x.id), [e.id], 'and across the copied stages');
  assert.equal(+e.work, 8);
  assert.equal(w.skill, 'Welding');
  assert.equal(l.percent, 0, 'not done here');
  assert.equal(e.deadline, null);
  assert.equal(e.constraint.type, 'ASAP');
  assert.deepEqual(e.assignments, [], 'nobody is on it yet');
  assert.equal((target.timesheets || []).length, 0);
  assert.notEqual(l.id, layout.id, 'a copy, not the template’s own task');
  assert.equal(template.tasks.length, 8, 'the template is untouched');
});

test('only the ticked tasks of a stage come across', () => {
  const { p: template, layout } = chiller();
  const g = stageGroups(template, set);
  const target = createProject('X', '2026-10-01');
  addStagesFrom(target, template, [{ id: g[0].id, taskIds: [layout.id] }], set);
  assert.deepEqual(outline(target), ['Design', '  Layout']);
});

test('a stage the project already has gets the tasks it is missing, not a second stage', () => {
  const { p: template, layout, drawings } = chiller();
  const g = stageGroups(template, set);
  const target = createProject('Chiller WO 501', '2026-10-01');
  const mine = insertTask(target, 0, { name: 'Engineering', level: 1 });
  insertTask(target, 1, { name: 'layout', level: 2 });            // the same task, already there
  setSummaryStage(target, mine.id, std('design'));                 // called something else, same standard stage
  const result = addStagesFrom(target, template, [{ id: g[0].id, taskIds: [layout.id, drawings.id] }], set);
  assert.deepEqual(result, { stages: 0, merged: 1, tasks: 1, skipped: 1 });
  assert.deepEqual(outline(target), ['Engineering', '  layout', '  Electrical drawings']);
  assert.equal(phases(target).length, 1, 'still one Design stage');
});

test('a group that is not a stage comes across as a plain group; nothing picked adds nothing', () => {
  const { p: template, travel } = chiller();
  const g = stageGroups(template, set);
  const target = createProject('X', '2026-10-01');
  assert.deepEqual(addStagesFrom(target, template, [], set), { stages: 0, merged: 0, tasks: 0, skipped: 0 });
  assert.deepEqual(addStagesFrom(target, template, [{ id: 'nope', taskIds: [] }], set), { stages: 0, merged: 0, tasks: 0, skipped: 0 }, 'an unknown stage is ignored');
  addStagesFrom(target, template, [{ id: g[2].id, taskIds: [travel.id] }], set);
  assert.deepEqual(outline(target), ['Site visit', '  Book travel']);
  assert.equal(phases(target).length, 0, 'not a stage there either');
});

test('a template from a project: tuned stages and tasks, skills instead of people, no dates or progress', () => {
  const { p, d, b, visit, layout, drawings, frame, travel, loose } = chiller();
  const groups = stageGroups(p, set);
  const t = templateFrom(p, {
    name: 'Chiller build',
    groups: [
      { id: groups[1].id, include: true, name: 'Fabrication', stageKey: 'build' },     // Build first, renamed
      { id: groups[0].id, include: true, name: 'Design', stageKey: 'design' },
      { id: groups[2].id, include: true, name: 'Site visit', stageKey: 'test' },        // made a stage
      { id: groups[3].id, include: false },                                               // the loose task is left out
    ],
    tasks: { [layout.id]: { include: false }, [drawings.id]: { name: 'Electrical schematics', work: 6 } },
  }, set);

  assert.equal(t.template, true);
  assert.equal(t.name, 'Chiller build');
  assert.notEqual(t.id, p.id);
  assert.deepEqual(outline(t), ['Fabrication', '  Weld frame', 'Design', '  Electrical schematics', 'Site visit', '  Book travel']);
  assert.deepEqual(phases(t).map((ph) => [ph.name, ph.stageKey]), [['Fabrication', 'build'], ['Design', 'design'], ['Site visit', 'test']]);
  const sch = t.tasks.find((x) => x.name === 'Electrical schematics');
  const weld = t.tasks.find((x) => x.name === 'Weld frame');
  assert.equal(+sch.work, 6);
  assert.equal(sch.skill, 'Electrical', 'the assignee’s role became the skill');
  assert.deepEqual(sch.assignments, []);
  assert.deepEqual(t.resources, [], 'no people in a template');
  assert.equal(sch.deadline, null);
  assert.equal(sch.constraint.type, 'ASAP');
  assert.equal(sch.percent, 0);
  assert.deepEqual(sch.predecessors, [], 'a link to a task left out is dropped');
  assert.deepEqual(weld.predecessors.map((l) => l.id), [sch.id], 'links between kept tasks stay');
  assert.equal((t.timesheets || []).length, 0);
  assert.equal(t.currentPhaseId, null);
  assert.equal(p.tasks.length, 8, 'the project itself is untouched');
  assert.equal(p.tasks.find((x) => x.id === layout.id).percent, 100);
  // A stage with every task left out goes too, and a name is required.
  const none = templateFrom(p, { name: 'T', groups: [{ id: groups[1].id, include: true, name: 'Build', stageKey: 'build' }], tasks: { [frame.id]: { include: false } } }, set);
  assert.deepEqual(outline(none), []);
  assert.throws(() => templateFrom(p, { name: '  ', groups: [], tasks: {} }, set), /name/i);
  // And it survives a save as a template.
  const back = parse(serialize(t)).project;
  assert.equal(back.template, true);
  assert.equal(getPhase(back, back.phases[0].id).stageKey, 'build');
  void d; void b; void visit; void travel; void loose;
});
