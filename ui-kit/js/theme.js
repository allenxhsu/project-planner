/**
 * Toolkit UI runtime. No dependencies, no build step: plain ES module.
 *
 *   import { initTheme, setRace } from '../ui-kit/js/theme.js';
 *   initTheme({ app: 'idef0' });
 *
 * State is three attributes on <html>, which is all the CSS keys off:
 *   data-sc            skin on (absent = the app's own classic styling)
 *   data-race          steel | crystal | chitin
 *   data-app           one of APPS below (the app's identity colour)
 * plus data-sc-effects="off" to drop the decorative overlays, and
 * data-sc-mac-inset when a desktop build hides the macOS title bar.
 *
 * Preferences are stored per origin in localStorage under `ui-kit.*`. Apps
 * served from the same origin therefore share a race choice automatically.
 */

export const RACES = ['steel', 'crystal', 'chitin'];
export const RACE_LABELS = { steel: 'Steel', crystal: 'Crystal', chitin: 'Chitin' };
/** Every app in the suite, i.e. the valid data-app values. Colours live in tokens/tokens.json. */
export const APPS = ['heptabase', 'idef0', 'sysml', 'project', 'pyramid', 'profiler', 'hypermail', 'metropolis', 'habit', 'bom'];

/**
 * Values written by the first release of the kit. They are translated on read
 * and rewritten once, so an existing preference survives the rename.
 */
const LEGACY = {
  race: { terran: 'steel', protoss: 'crystal', zerg: 'chitin' },
  skin: { starcraft: 'hud' },
  app: { mindmap: 'metropolis' },
};

const KEY = {
  skin: 'ui-kit.skin',
  race: 'ui-kit.race',
  effects: 'ui-kit.effects',
};

const EVENT = 'ui-kit:change';

function read(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    // Storage can be blocked (private windows, sandboxed frames).
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* preference simply won't persist */
  }
}

function migrate(key, table) {
  const value = read(key, null);
  if (value !== null && table[value]) write(key, table[value]);
}

/** Current preferences, with defaults applied. */
export function getTheme() {
  migrate(KEY.race, LEGACY.race);
  migrate(KEY.skin, LEGACY.skin);
  const race = read(KEY.race, 'steel');
  return {
    skin: read(KEY.skin, 'hud') === 'classic' ? 'classic' : 'hud',
    race: RACES.includes(race) ? race : 'steel',
    effects: read(KEY.effects, 'on') === 'off' ? 'off' : 'on',
  };
}

/** Writes the current preferences onto <html>. */
export function applyTheme({ app, root = document.documentElement, macInset } = {}) {
  const t = getTheme();
  if (t.skin === 'hud') root.setAttribute('data-sc', '');
  else root.removeAttribute('data-sc');
  root.setAttribute('data-race', t.race);
  if (t.effects === 'off') root.setAttribute('data-sc-effects', 'off');
  else root.removeAttribute('data-sc-effects');
  if (app) root.setAttribute('data-app', LEGACY.app[app] ?? app);
  if (macInset !== undefined) {
    if (macInset) root.setAttribute('data-sc-mac-inset', '');
    else root.removeAttribute('data-sc-mac-inset');
  }
  return t;
}

/**
 * Call once at startup, before the first render, so the page never flashes
 * the unthemed look. Also keeps other tabs of the same app in step.
 */
export function initTheme({ app, macInset } = {}) {
  const t = applyTheme({ app, macInset });
  window.addEventListener('storage', (e) => {
    if (e.key && e.key.startsWith('ui-kit.')) {
      applyTheme();
      window.dispatchEvent(new CustomEvent(EVENT, { detail: getTheme() }));
    }
  });
  return t;
}

function update(key, value) {
  write(key, value);
  const t = applyTheme();
  window.dispatchEvent(new CustomEvent(EVENT, { detail: t }));
  return t;
}

export const setSkin = (skin) => update(KEY.skin, skin === 'classic' ? 'classic' : 'hud');
export const setRace = (race) => update(KEY.race, RACES.includes(race) ? race : 'steel');
export const setEffects = (on) => update(KEY.effects, on ? 'on' : 'off');

/** Subscribe to preference changes. Returns an unsubscribe function. */
export function onThemeChange(callback) {
  const handler = (e) => callback(e.detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

/** True inside an Electron (or similar) macOS window with a hidden title bar. */
export function detectMacDesktop() {
  return /Mac/.test(navigator.userAgent) && /Electron/.test(navigator.userAgent);
}
