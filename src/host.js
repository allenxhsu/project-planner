// Bridge to the macOS app (macos/), which hosts this page in a WKWebView.
//
// In a browser `hosted` is false and nothing here does anything. Hosted, the
// native side owns what a browser cannot do well — documents, the menu bar,
// save panels, PDF — and this module is the only place the two sides meet:
//
//   page → app   post({ type, … })               ready | changed | saveFile | pdf | new | open | save
//   app → page   window.projectHost.load(…)      put a file's text into this window
//                window.projectHost.command(id)  run a menu command
//                window.projectHost.saved(name)  the document was written
//
// Imports nothing, so the model layer can depend on it and still load under Node.

const handler = globalThis.webkit?.messageHandlers?.project;

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
 * @param {{load: Function, command: Function, saved: Function}} api
 */
export function initHost(api) {
  if (!hosted) return;
  globalThis.projectHost = api;
  document.documentElement.setAttribute('data-hosted', '');
  // The web view's own context menu offers Reload, which would discard the window's plan.
  document.addEventListener('contextmenu', (e) => {
    if (!/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) e.preventDefault();
  });
  post({ type: 'ready' });
}
