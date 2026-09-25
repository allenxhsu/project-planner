import { SYNC_ROUTES } from './protocol.js';
/**
 * A refusal that means "your credential, not your request".
 *
 * Distinguished from every other failure because it is the only one a person
 * can act on: a 500 is ours, a timeout is the network, and a 401 is a sign-in
 * that has run out. `code` is what the UI switches on, so it does not have to
 * match on a message that was never meant to be parsed.
 */
export class SyncUnauthorized extends Error {
    code = 'unauthorized';
    constructor(route) {
        super(`sync ${route} was refused: not signed in`);
        this.name = 'SyncUnauthorized';
    }
}
/**
 * A name for a workspace URL that a person would recognise.
 *
 * The label is dispatched on `sync-kit:status` and rendered by ui-kit, so it
 * lands in the DOM and in screenshots: the workspace segment of
 * `https://host/w/heptabase` says everything useful and nothing sensitive. A
 * URL that does not parse is handed back as it came, because a wrong label is
 * better than no sync.
 */
function nameOf(baseUrl) {
    try {
        const url = new URL(baseUrl);
        const workspace = url.pathname.split('/').filter(Boolean).pop();
        return workspace ?? url.host;
    }
    catch {
        return baseUrl;
    }
}
/**
 * HTTP transport.
 *
 * This is the whole "online sync" story: point `baseUrl` at the desktop app's
 * loopback server to sync a browser tab with the desktop database, or at a
 * hosted server to sync across machines. Nothing else in the app changes.
 */
export class HttpTransport {
    opts;
    label;
    constructor(opts) {
        this.opts = opts;
        this.label = opts.label ?? nameOf(opts.baseUrl);
    }
    async call(route, body) {
        const headers = { 'Content-Type': 'application/json' };
        if (this.opts.token)
            headers.Authorization = `Bearer ${this.opts.token}`;
        // A phone that just left Wi-Fi would otherwise hang on "Syncing…" for
        // minutes; a bounded wait fails fast and the next trigger retries.
        const res = await fetch(this.opts.baseUrl.replace(/\/$/, '') + route, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            credentials: 'same-origin',
            signal: AbortSignal.timeout(20_000),
        });
        if (res.status === 401 || res.status === 403) {
            // 403 as well as 401: a cookie-authenticated write refused as cross-site
            // is the same story from the person's point of view — this browser is
            // not going to be able to sync until something about its credential
            // changes — and telling them apart helps nobody holding a phone.
            this.opts.onUnauthorized?.();
            throw new SyncUnauthorized(route);
        }
        if (!res.ok) {
            throw new Error(`sync ${route} failed: ${res.status} ${res.statusText}`);
        }
        return (await res.json());
    }
    pull(req) {
        return this.call(SYNC_ROUTES.pull, req);
    }
    push(req) {
        return this.call(SYNC_ROUTES.push, req);
    }
}
