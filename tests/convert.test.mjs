// The Microsoft Project converter, when tools/setup-converter.sh has run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { importMspdi, exportMspdi } from '../src/io/mspdi.js';
import { computeSchedule } from '../src/model/schedule.js';
import { sampleProject } from '../src/model/sample.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const script = path.join(here, '..', 'tools', 'mpp2xml.sh');
const ready = fs.existsSync(path.join(here, '..', 'tools', 'jre', 'Contents', 'Home', 'bin', 'java')) && fs.existsSync(path.join(here, '..', 'tools', 'mpxj', 'mpxj.jar'));
const convert = (src, dst) => execFileSync(script, [src, dst], { stdio: ['ignore', 'ignore', 'pipe'] });

test('a real .mpp opens through MPXJ', { skip: !ready && 'run tools/setup-converter.sh first' }, () => {
  const out = path.join(os.tmpdir(), `pp-${process.pid}.xml`);
  convert(path.join(here, 'fixtures', 'baseline-project2010.mpp'), out);
  const { project, report } = importMspdi(fs.readFileSync(out, 'utf8'));
  fs.unlinkSync(out);
  assert.equal(report.tasks, 14); // 15 <Task> rows, one of them the project summary
  assert.equal(report.links, 6);
  assert.equal(report.resources, 2);
  assert.ok(project.tasks.some((t) => t.level === 2), 'the outline came through');
  const s = computeSchedule(project);
  assert.equal(s.cyclic.length, 0);
});

test('our XML is accepted by MPXJ and survives a trip through MPX', { skip: !ready && 'run tools/setup-converter.sh first' }, () => {
  const p = sampleProject();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-'));
  const xml = path.join(dir, 'plan.xml'), mpx = path.join(dir, 'plan.mpx'), back = path.join(dir, 'back.xml');
  fs.writeFileSync(xml, exportMspdi(p, computeSchedule(p)));
  convert(xml, mpx);
  convert(mpx, back);
  const { project, report } = importMspdi(fs.readFileSync(back, 'utf8'));
  fs.rmSync(dir, { recursive: true });
  assert.equal(report.tasks, p.tasks.length);
  assert.equal(report.links, p.tasks.reduce((n, t) => n + t.predecessors.length, 0));
  assert.deepEqual(project.tasks.map((t) => t.level), p.tasks.map((t) => t.level));
});
