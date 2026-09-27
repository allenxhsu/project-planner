// Home or work, from where this device is (model/places.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPlace, teachPlace, metresBetween, signalsKey } from '../src/model/places.js';

const HOME = { lat: 37.3318, lng: -122.0312 };
const WORK = { lat: 37.4200, lng: -122.0800 };

test('Wi-Fi beats the address, and the address beats the map', () => {
  const places = [
    { kind: 'home', ssids: ['Xu Home'], ips: ['198.51.100.4'], points: [HOME] },
    { kind: 'work', ssids: ['CorpNet'], ips: ['203.0.113.9'], points: [WORK] },
  ];
  assert.deepEqual(matchPlace(places, { ssid: 'CorpNet', ip: '198.51.100.4', pos: { ...HOME, accuracy: 30 } }), { kind: 'work', by: 'wifi' });
  assert.deepEqual(matchPlace(places, { ssid: 'Cafe', ip: '198.51.100.4', pos: { ...WORK, accuracy: 30 } }), { kind: 'home', by: 'address' });
  assert.deepEqual(matchPlace(places, { ip: '192.0.2.1', pos: { lat: HOME.lat + 0.001, lng: HOME.lng, accuracy: 40 } }), { kind: 'home', by: 'location' });
  assert.equal(matchPlace(places, { ssid: 'Cafe', ip: '192.0.2.1', pos: { lat: 38, lng: -121, accuracy: 30 } }), null, 'nowhere known: ask');
  assert.equal(matchPlace(places, { pos: { ...HOME, accuracy: 5000 } }), null, 'a vague fix says nothing');
});

test('teaching a network moves it to that place, never both', () => {
  let places = [{ kind: 'home', ssids: ['Guest'], ips: [], points: [] }];
  places = teachPlace(places, 'work', { ssid: 'Guest', ip: '203.0.113.9', pos: { ...WORK, accuracy: 20 } });
  const work = places.find((p) => p.kind === 'work');
  const home = places.find((p) => p.kind === 'home');
  assert.deepEqual(work.ssids, ['Guest']);
  assert.deepEqual(work.ips, ['203.0.113.9']);
  assert.equal(work.points.length, 1);
  assert.deepEqual(home.ssids, [], 'taken off home');
  assert.deepEqual(matchPlace(places, { ssid: 'Guest' }), { kind: 'work', by: 'wifi' });
  // The same spot taught again does not pile up points.
  places = teachPlace(places, 'work', { pos: { ...WORK, accuracy: 20 } });
  assert.equal(places.find((p) => p.kind === 'work').points.length, 1);
});

test('distances and keys', () => {
  assert.ok(Math.abs(metresBetween(HOME, { lat: HOME.lat + 0.001, lng: HOME.lng }) - 111) < 2);
  assert.equal(signalsKey({ ssid: 'X', ip: '1.2.3.4' }), 'X');
  assert.equal(signalsKey({}), '');
});
