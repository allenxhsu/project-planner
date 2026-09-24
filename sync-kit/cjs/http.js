"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HttpTransport = void 0;
const protocol_js_1 = require("./protocol.js");
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
class HttpTransport {
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
        if (!res.ok) {
            throw new Error(`sync ${route} failed: ${res.status} ${res.statusText}`);
        }
        return (await res.json());
    }
    pull(req) {
        return this.call(protocol_js_1.SYNC_ROUTES.pull, req);
    }
    push(req) {
        return this.call(protocol_js_1.SYNC_ROUTES.push, req);
    }
}
exports.HttpTransport = HttpTransport;
