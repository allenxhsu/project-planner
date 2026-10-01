import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, insertTask, setTaskField, link, phaseOf, inCurrentPhase, moduleFromSummary, addModuleTasks, setSummaryStage, phases } from '../src/model/model.js';
import { DEFAULT_STAGE_SET, cleanStageSet, choicesFor, cleanModule } from '../src/model/processes.js';
import { setCurrentStage, autoAdvance } from '../src/model/stages.js';
import { serialize, parse } from '../src/io/json.js';

const stages = cleanStageSet(DEFAULT_STAGE_SET);
const certify = stages.find((s) => s.key === 'certify');
const design = stages.find((s) => s.key === 'design');

/** A plan with a Design stage and a Certify stage, each a summary. */
function staged() {
  const p = createProject('Chiller WO 1', '2026-10-01');
  const d = insertTask(p, 0, { name: 'Design', level: 1 });
  insertTask(p, 1, { name: 'Layout', level: 2 });
  const c = insertTask(p, 2, { name: 'Certification', level: 1 });
  setSummaryStage(p, d.id, design);
  setSummaryStage(p, c.id, certify);
  return { p, d, c };
}

test('a summary marked as a stage is that stage: its subtasks are its work, released when it is current', () => {
  const { p, d, c } = staged();
  assert.deepEqual(phases(p).map((ph) => [ph.name, ph.stageKey, ph.summaryId]), [['Design', 'design', d.id], ['Certification', 'certify', c.id]]);
  const layout = p.tasks.find((t) => t.name === 'Layout');
  assert.equal(phaseOf(p, layout.id), phases(p)[0].id, 'a subtask is in its summary’s stage');
  setCurrentStage(p, phases(p)[1].id);
  assert.equal(inCurrentPhase(p, layout.id), false, 'not released while the project is certifying');
  setTaskField(p, c.id, 'name', 'CE & NFPA certification');
  assert.equal(phases(p)[1].name, 'CE & NFPA certification', 'renaming the summary renames the stage');
  setSummaryStage(p, c.id, null);
  assert.deepEqual(phases(p).map((ph) => ph.name), ['Design'], 'unmarked: an ordinary summary again');
});

test('a group of tasks becomes a process module, with stages, work and links', () => {
  const { p, c } = staged();
  const a = insertTask(p, p.tasks.length, { name: 'Prepare CE technical file', level: 2 });
  const b = insertTask(p, p.tasks.length, { name: 'Notified body review', level: 2 });
  setTaskField(p, a.id, 'work', '6');
  setTaskField(p, b.id, 'skill', 'Compliance');
  link(p, a.id, b.id);
  const m = moduleFromSummary(p, c.id, stages);
  assert.equal(m.name, 'Certification');
  assert.deepEqual(m.tasks.map((t) => [t.name, t.work, t.stage, t.skill, t.after]),
    [['Prepare CE technical file', 6, 'certify', null, []], ['Notified body review', null, 'certify', 'Compliance', ['t1']]]);
});

test('quick add offers the stage’s module tasks, puts them under the stage’s summary, linked, and not twice', () => {
  const { p } = staged();
  const ce = cleanModule({ id: 'mod_ce', name: 'CE certification', tasks: [
    { key: 'file', name: 'Prepare CE technical file', work: 6, stage: 'certify' },
    { key: 'review', name: 'Notified body review', stage: 'certify', after: ['file'], skill: 'Compliance' },
    { key: 'risk', name: 'Risk assessment (EN ISO 12100)', stage: 'design' },
  ] });
  const offered = choicesFor(p, [ce], 'certify');
  assert.deepEqual(offered.map((x) => x.task.name), ['Prepare CE technical file', 'Notified body review'], 'only the certify stage’s tasks');
  const certifyPhase = phases(p).find((ph) => ph.stageKey === 'certify');
  const made = addModuleTasks(p, offered, { phaseId: certifyPhase.id });
  const names = p.tasks.map((t) => `${'  '.repeat(t.level - 1)}${t.name}`);
  assert.deepEqual(names.slice(-3), ['Certification', '  Prepare CE technical file', '  Notified body review'], 'under the stage’s summary');
  assert.deepEqual(made[1].predecessors.map((l) => l.id), [made[0].id], 'linked as the module says');
  assert.equal(made[1].skill, 'Compliance');
  assert.equal(+made[0].work, 6);
  assert.ok(choicesFor(p, [ce], 'certify').every((x) => x.added), 'shown as added from then on');
  const back = parse(serialize(p)).project;
  assert.deepEqual(back.tasks.find((t) => t.name === 'Notified body review').fromModule, { id: 'mod_ce', key: 'review', name: 'CE certification' });
  assert.equal(back.phases.find((ph) => ph.stageKey === 'certify').summaryId, certifyPhase.summaryId, 'the stage keeps its summary');
});

test('finishing a stage’s work moves the project on, releasing the next stage', () => {
  const { p } = staged();
  setCurrentStage(p, phases(p)[0].id);
  for (const t of p.tasks.filter((x) => x.name === 'Layout')) setTaskField(p, t.id, 'percent', 100);
  assert.equal(autoAdvance(p), true);
  assert.equal(p.currentPhaseId, phases(p)[1].id);
});
