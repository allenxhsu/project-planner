// Reading a Profiler export: the contract Profiler documents as stable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readProfile, profileLine, PROFILE_FORMAT } from '../src/io/profile.js';

const sample = (over = {}) => JSON.stringify({
  format: PROFILE_FORMAT,
  formatVersion: 1,
  generatedAt: '2026-09-20T10:00:00.000Z',
  generator: { name: 'Profiler', version: '0.1.0' },
  subject: { id: 'uma-chen', name: 'Uma Chen', team: 'Platform', role: 'Systems engineer' },
  instruments: [
    { id: 'mbti', name: 'MBTI', headline: 'INTJ', tagline: 'Plans first', codes: { type: 'INTJ' }, confidence: 0.82, caveats: ['T/F is borderline'], scales: [], detail: { whatever: 1 } },
    { id: 'disc', name: 'DISC', headline: 'High D / High C', tagline: '', codes: { primary: 'D' }, confidence: 0.6, caveats: [], scales: [] },
  ],
  responses: { 'mbti-ei-01': 4 },
  ...over,
});

test('reads the subject and every instrument headline', () => {
  const p = readProfile(sample());
  assert.equal(p.subjectId, 'uma-chen');
  assert.equal(p.name, 'Uma Chen');
  assert.equal(p.team, 'Platform');
  assert.equal(p.role, 'Systems engineer');
  assert.equal(p.instruments.length, 2);
  assert.equal(p.instruments[0].headline, 'INTJ');
  assert.deepEqual(p.instruments[0].codes, { type: 'INTJ' });
  assert.equal(profileLine(p), 'INTJ · High D / High C');
});

test('keeps neither the raw answers nor the unstable detail blob', () => {
  const p = readProfile(sample());
  assert.equal(p.responses, undefined);
  assert.equal(p.instruments[0].detail, undefined);
});

test('a later format version is read, not rejected', () => {
  const p = readProfile(sample({ formatVersion: 4 }));
  assert.equal(p.instruments.length, 2);
});

test('confidence is clamped, and a missing one is null not zero', () => {
  const doc = JSON.parse(sample());
  doc.instruments[0].confidence = 1.4;
  delete doc.instruments[1].confidence;
  const p = readProfile(JSON.stringify(doc));
  assert.equal(p.instruments[0].confidence, 1);
  assert.equal(p.instruments[1].confidence, null);
});

test('a file that is not a profile says so', () => {
  assert.throws(() => readProfile('not json'), /not JSON/);
  assert.throws(() => readProfile('{"format":"something.else"}'), /not a Profiler profile/);
  assert.throws(() => readProfile(sample({ instruments: [] })), /no instrument results/);
});
