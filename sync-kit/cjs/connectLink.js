"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseConnectLink = parseConnectLink;
exports.buildConnectLink = buildConnectLink;
/** Accepts `heptabase` or `heptabase:`, so callers need not remember which. */
function protocolOf(scheme) {
    return scheme.endsWith(':') ? scheme : `${scheme}:`;
}
function parseConnectLink(scheme, raw) {
    let parsed;
    try {
        parsed = new URL(raw);
    }
    catch {
        return null;
    }
    const action = parsed.hostname || parsed.pathname.replace(/^\/+/, '');
    if (parsed.protocol !== protocolOf(scheme) || action !== 'connect')
        return null;
    const url = (parsed.searchParams.get('url') ?? '').replace(/\/+$/, '');
    const token = parsed.searchParams.get('token') ?? '';
    // A bare origin: scheme, host and optional port. Nothing else belongs in it.
    if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(url))
        return null;
    return { url, token };
}
function buildConnectLink(scheme, origin, token) {
    return `${protocolOf(scheme)}//connect?url=${encodeURIComponent(origin)}&token=${encodeURIComponent(token)}`;
}
