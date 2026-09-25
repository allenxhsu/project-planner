// Run with:  node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs } from '../src/io/ics.js';

const ics = (body) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Allen's work\r\n${body}\r\nEND:VCALENDAR`;
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const window = { from: at(2026, 9, 1), to: at(2026, 12, 31) };

test('a plain meeting reads its title and its hours', () => {
  const { events, name } = parseIcs(ics(
    'BEGIN:VEVENT\r\nUID:a@x\r\nSUMMARY:Design review\r\nDTSTART:20260922T140000\r\nDTEND:20260922T153000\r\nEND:VEVENT'), window);
  assert.equal(name, "Allen's work");
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Design review');
  assert.equal(events[0].start, at(2026, 9, 22, 14, 0));
  assert.equal(events[0].end, at(2026, 9, 22, 15, 30));
  assert.equal(events[0].busy, true);
});

test('a folded line and escaped text survive', () => {
  const { events } = parseIcs(ics(
    'BEGIN:VEVENT\r\nUID:b@x\r\nSUMMARY:Sprint planning\r\n  and retro\r\nDTSTART:20260923T090000\r\nDTEND:20260923T100000\r\nEND:VEVENT'), window);
  assert.equal(events[0].title, 'Sprint planning and retro');
});

test('an all-day event covers its day', () => {
  const { events } = parseIcs(ics(
    'BEGIN:VEVENT\r\nUID:c@x\r\nSUMMARY:Company holiday\r\nDTSTART;VALUE=DATE:20260924\r\nDTEND;VALUE=DATE:20260925\r\nEND:VEVENT'), window);
  assert.equal(events[0].allDay, true);
  assert.equal(events[0].start, at(2026, 9, 24));
  assert.equal(events[0].end, at(2026, 9, 25));
});

test('a daily stand-up repeats, and stops when it is told to', () => {
  const { events } = parseIcs(ics(
    'BEGIN:VEVENT\r\nUID:d@x\r\nSUMMARY:Stand-up\r\nDTSTART:20260921T091500\r\nDTEND:20260921T093000\r\nRRULE:FREQ=DAILY;COUNT=5\r\nEND:VEVENT'), window);
  assert.equal(events.length, 5);
  assert.deepEqual(events.map((e) => new Date(e.start).getDate()), [21, 22, 23, 24, 25]);
  assert.ok(events.every((e) => new Date(e.start).getHours() === 9 && new Date(e.start).getMinutes() === 15));
});

test('a weekly meeting on named days repeats on those days only', () => {
  const { events } = parseIcs(ics(
    'BEGIN:VEVENT\r\nUID:e@x\r\nSUMMARY:1:1\r\nDTSTART:20260922T110000\r\nDTEND:20260922T113000\r\nRRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261009T000000Z\r\nEND:VEVENT'), window);
  assert.ok(events.length >= 5, `expected several, got ${events.length}`);
  assert.ok(events.every((e) => [2, 4].includes(new Date(e.start).getDay())), 'Tuesdays and Thursdays only');
  assert.ok(events.every((e) => e.start <= at(2026, 10, 9)), 'and it stops at UNTIL');
});

test('free time and cancellations are not busy', () => {
  const { events } = parseIcs(ics(
    'BEGIN:VEVENT\r\nUID:f@x\r\nSUMMARY:Out of office\r\nDTSTART:20260925T090000\r\nDTEND:20260925T170000\r\nTRANSP:TRANSPARENT\r\nEND:VEVENT\r\n' +
    'BEGIN:VEVENT\r\nUID:g@x\r\nSUMMARY:Cancelled thing\r\nDTSTART:20260925T100000\r\nDTEND:20260925T110000\r\nSTATUS:CANCELLED\r\nEND:VEVENT'), window);
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.busy === false));
});

test('events outside the window are left out, and rubbish does not throw', () => {
  const { events } = parseIcs(ics(
    'BEGIN:VEVENT\r\nUID:h@x\r\nSUMMARY:Ancient history\r\nDTSTART:20200101T090000\r\nDTEND:20200101T100000\r\nEND:VEVENT'), window);
  assert.equal(events.length, 0);
  assert.deepEqual(parseIcs('not an ics file at all', window).events, []);
  assert.equal(parseIcs(ics('BEGIN:VEVENT\r\nUID:i@x\r\nSUMMARY:No date\r\nEND:VEVENT'), window).skipped, 1);
});
