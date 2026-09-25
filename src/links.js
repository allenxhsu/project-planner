// Links between the toolkit's apps. On the Portal every app is a path on one
// origin (/bom/, /project/), so a link is a path; served on this machine each
// app has a port of its own (the launcher's catalog), so a link is a port.

import { portalApp } from '../sync-kit/js/portal.js';

const LOCAL_PORTS = { bom: 8126, project: 8125 };

export function appUrl(appId, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  const base = portalApp() ? `${location.origin}/${appId}/` : `${location.protocol}//${location.hostname}:${LOCAL_PORTS[appId]}/`;
  return query ? `${base}?${query}` : base;
}

/** Open another app in its own tab, the same tab each time. */
export function openApp(appId, params) {
  window.open(appUrl(appId, params), `toolkit-${appId}`);
}

/** The query parameters a link brought, taken off the address bar so a reload does not act on them twice. */
export function takeLinkParams(names) {
  const url = new URL(location.href);
  const out = {};
  for (const n of names) if (url.searchParams.has(n)) { out[n] = url.searchParams.get(n); url.searchParams.delete(n); }
  if (Object.keys(out).length) history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
  return out;
}
