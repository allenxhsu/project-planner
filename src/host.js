// VENDORED COPY of ../shell-kit/js/host.js (commit 752c7c9, 2026-09-25).
// Do not edit here: change shell-kit, then run  node ../shell-kit/scripts/copy-into.mjs <this file>

// shell-kit/js/host.js — the page's half of the bridge to the macOS shell
// (ToolkitShell, ../shell-kit). Apps vendor a copy of this file:
//   node ../shell-kit/scripts/copy-into.mjs src/host.js
//
// In a browser `hosted` is false and nothing here does anything. Hosted, the
// native side owns what a browser cannot do well — documents, the menu bar,
// save panels, PDF — and this module is the only place the two sides meet:
//
//   page → app   post({ type, … })            ready | changed | saveFile | pdf | new | open | save | log
//   app → page   window.<name>Host.load(text, name)   put a file's text into this window
//                window.<name>Host.command(id)        run a menu command
//                window.<name>Host.saved(name)        the document was written
//                window.<name>Host.remote({url, token})  the toolkit Portal this Mac paired with
//
// `remote` is the newest of these (added with Portal pairing): the shell signs
// in through a sign-in sheet, keeps the device token in the Keychain, and
// hands the page the same two values its own Sync settings hold — so the page
// treats them exactly as if they had been typed in, and does not care that a
// Keychain was involved. It arrives when the page reports ready and again
// whenever the person signs in or out; two empty strings mean signed out, the
// same as clearing those fields by hand. A vendored copy without it is a copy
// from before pairing: `copy-into.mjs --check` will say so.
//
// The shell injects `window.__toolkitHost = '<name>'` before any module
// loads, so `hosted` is known at import time; `initHost({ name })` names the
// same handler. Imports nothing, so a model layer that depends on it still
// loads under Node.

const injectedName = typeof globalThis.__toolkitHost === 'string' ? globalThis.__toolkitHost : null;
let handler = injectedName ? globalThis.webkit?.messageHandlers?.[injectedName] : null;

/** True inside the macOS shell. */
export const hosted = !!handler;

export function post(message) {
  if (handler) handler.postMessage(message);
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Hand a file to the app, which asks where to save it. */
export async function saveViaHost(blob, filename) {
  post({ type: 'saveFile', name: filename, base64: await toBase64(blob) });
}

/**
 * Expose the page's callbacks to the shell and tell it the page is ready.
 *
 * `remote` is optional: an app with no sync gets a no-op, so the shell can
 * always make the call without asking what the page supports.
 * @param {{name: string, load: (text: string, fileName: string) => any, command: (id: string) => void, saved: (fileName: string) => void, remote?: (settings: {url: string, token: string}) => void}} api
 */
export function initHost({ name, load, command, saved, remote = () => {} }) {
  handler = handler || globalThis.webkit?.messageHandlers?.[name] || null;
  if (!handler) return false;
  globalThis[`${name}Host`] = { load, command, saved, remote };
  document.documentElement.setAttribute('data-hosted', '');
  // The web view's own context menu offers Reload, which would discard the window's document.
  document.addEventListener('contextmenu', (e) => {
    if (!/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) e.preventDefault();
  });
  post({ type: 'ready' });
  return true;
}
