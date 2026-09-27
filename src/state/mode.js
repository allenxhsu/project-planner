// Home mode and work mode.
//
// Work, personal and school are different lives in one tool. At work, a
// co-worker glancing at the screen should not see the dentist, the course
// or the kitchen: home projects are hidden, and on the calendar their time
// is a plain "Busy". At home, work is still there but dimmed, so the evening
// reads as the evening.
//
// Which it is, is worked out from where this device is (model/places.js):
// the Wi-Fi name, the internet address, the location. A network it has not
// seen is asked about once and remembered. It can also be set by hand, and
// that holds until Auto is chosen again. The choice is per device.

import { set } from './store.js';
import { hosted, post } from '../host.js';
import { matchPlace, teachPlace, describeSignals, signalsKey } from '../model/places.js';

const KEY = 'project-planner:mode';
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } };
const write = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode */ } };

let state = { choice: 'auto', detected: null, by: null, signals: null, ...read() };
const remember = () => write({ choice: state.choice, detected: state.detected, by: state.by });

/** 'auto' (from where this is), 'home' or 'work' (chosen by hand). */
export const modeChoice = () => state.choice;
/** The mode in force: chosen, else detected, else home. */
export const currentMode = () => (state.choice === 'home' || state.choice === 'work' ? state.choice : state.detected || 'home');
/** How the mode was arrived at, for saying so: 'wifi', 'address', 'location', 'asked', 'hand' or null. */
export const modeReason = () => (state.choice !== 'auto' ? 'hand' : state.by);

/** Whether a workspace is home or work: as its settings say, else Work is work and the rest are home. */
export function workspaceKind(workspace) {
  if (workspace?.mode === 'work' || workspace?.mode === 'home') return workspace.mode;
  return /^\s*work\s*$/i.test(String(workspace?.name || '')) ? 'work' : 'home';
}

let workspaceLookup = () => null;
/** sync.js's cache, handed in so this module has no import cycle with it. */
export function useWorkspaces(lookup) { workspaceLookup = lookup; }

/**
 * How something in this workspace is shown now:
 * 'show', 'dim' (work, at home) or 'hide' (home, at work — the calendar draws its time as Busy).
 */
export function visibilityOf(workspaceId) {
  const kind = workspaceKind(workspaceLookup(workspaceId || null));
  const mode = currentMode();
  if (kind === mode) return 'show';
  return mode === 'work' ? 'hide' : 'dim';
}
export const isHidden = (workspaceId) => visibilityOf(workspaceId) === 'hide';
export const isDimmed = (workspaceId) => visibilityOf(workspaceId) === 'dim';

/** Say the mode may have changed: redraw, and let what caches by mode reload. */
function changed() {
  set({});
  window.dispatchEvent(new Event('planner-mode'));
}

export function setModeChoice(choice) {
  state.choice = choice === 'home' || choice === 'work' ? choice : 'auto';
  remember();
  changed();
  if (state.choice === 'auto') void detectMode({ ask: true });
}

// ------------------------------------------------------------------ where this is

/** Wi-Fi name and location from the Mac app, or location from the browser. */
function localSignals() {
  if (hosted) {
    return new Promise((resolve) => {
      const done = (e) => { clearTimeout(timer); window.removeEventListener('host-network', done); resolve(e?.detail || {}); };
      const timer = setTimeout(() => done(null), 12_000);
      window.addEventListener('host-network', done);
      post({ type: 'probeNetwork' });
    }).then((d) => ({ ssid: d.ssid || null, pos: Number.isFinite(d.lat) ? { lat: d.lat, lng: d.lng, accuracy: d.accuracy ?? 1000 } : null }));
  }
  if (!navigator.geolocation) return Promise.resolve({ ssid: null, pos: null });
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ ssid: null, pos: { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy } }),
      () => resolve({ ssid: null, pos: null }),
      { maximumAge: 10 * 60_000, timeout: 10_000, enableHighAccuracy: false },
    );
  });
}

async function networkAddress() {
  try {
    const { serverFetch } = await import('./sync.js');
    const res = await serverFetch('/calendar/network');
    return res.ok ? (await res.json()).ip || null : null;
  } catch { return null; }
}

export async function currentSignals() {
  const [local, ip] = await Promise.all([localSignals(), networkAddress()]);
  return { ...local, ip };
}

const asked = new Set();
let detecting = null;

/**
 * Work out home or work from where this is. A network nobody has said
 * anything about is asked about (once per session) and remembered.
 */
export function detectMode({ ask = true } = {}) {
  if (detecting) return detecting;
  detecting = (async () => {
    const signals = await currentSignals();
    state.signals = signals;
    const { listPlaces } = await import('./sync.js');
    const places = await listPlaces();
    const hit = matchPlace(places, signals);
    if (hit) {
      const moved = state.detected !== hit.kind;
      state.detected = hit.kind;
      state.by = hit.by;
      remember();
      if (moved) changed();
      return hit.kind;
    }
    const key = signalsKey(signals);
    if (!ask || state.choice !== 'auto' || !key || asked.has(key)) return state.detected;
    asked.add(key);
    const kind = await askWhere(signals);
    if (kind) await teach(kind, signals);
    return state.detected;
  })().finally(() => { detecting = null; });
  return detecting;
}

/** Say that where this is, is home or work — and switch to it. */
export async function teach(kind, signals = state.signals) {
  const { listPlaces, savePlace } = await import('./sync.js');
  const s = signals || (await currentSignals());
  for (const place of teachPlace(await listPlaces(), kind, s)) await savePlace(place);
  state.detected = kind;
  state.by = 'asked';
  remember();
  changed();
}

async function askWhere(signals) {
  const { open, foot, button } = await import('../ui/dialog.js');
  const { el } = await import('../util.js');
  return open('Home or work?', (close) => [
    el('p', { text: `Is ${describeSignals(signals)} home or work?` }),
    el('p', { class: 'sc-muted small', text: 'At work, home projects are hidden and their calendar time shows only as Busy. At home, work is dimmed. The answer is remembered for this network.' }),
    foot(button('Not now', () => close(null)), el('span', { class: 'sc-spacer' }),
      button('🏠 Home', () => close('home')), button('💼 Work', () => close('work'), 'sc-button--primary')),
  ]);
}

/** Look again when the network may have changed: on start, coming online, coming back to the window, and every ten minutes. */
export function watchMode() {
  let last = 0;
  const again = () => { if (Date.now() - last > 2 * 60_000) { last = Date.now(); void detectMode({ ask: true }); } };
  again();
  window.addEventListener('online', () => { last = 0; again(); });
  window.addEventListener('focus', again);
  setInterval(() => { last = 0; again(); }, 10 * 60_000);
}

export const lastSignals = () => state.signals;
