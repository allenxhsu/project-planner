import { SyncUnauthorized } from './http.js';
import { SYNC_ROUTES } from './protocol.js';
const MAX_RETRY_MS = 30_000;
export function watchChanges(opts) {
    const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
    const url = opts.baseUrl.replace(/\/$/, '') + SYNC_ROUTES.events;
    const headers = { Accept: 'text/event-stream' };
    if (opts.token)
        headers.Authorization = `Bearer ${opts.token}`;
    const firstRetry = opts.retryMs ?? 1000;
    let stopped = false;
    let controller = null;
    let timer = null;
    let wait = firstRetry;
    const schedule = () => {
        if (stopped)
            return;
        timer = setTimeout(() => {
            timer = null;
            void connect();
        }, wait);
        wait = Math.min(wait * 2, MAX_RETRY_MS);
    };
    const dispatch = (block) => {
        let event = '';
        const data = [];
        for (const line of block.split('\n')) {
            if (line.startsWith('event:'))
                event = line.slice(6).trim();
            else if (line.startsWith('data:'))
                data.push(line.slice(5).trim());
            // `retry:`, `id:` and comment lines carry nothing this client acts on.
        }
        if (event !== 'change')
            return;
        try {
            const parsed = JSON.parse(data.join('\n'));
            if (typeof parsed.cursor === 'number')
                opts.onChange({ cursor: parsed.cursor });
        }
        catch {
            // A malformed event is the server's bug, and dropping it costs one
            // sync's worth of promptness — not a crash in the page's event loop.
        }
    };
    const read = async (body, signal) => {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (done || signal.aborted)
                return;
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
            let at;
            while ((at = buffer.indexOf('\n\n')) >= 0) {
                dispatch(buffer.slice(0, at));
                buffer = buffer.slice(at + 2);
            }
        }
    };
    const connect = async () => {
        if (stopped)
            return;
        controller = new AbortController();
        try {
            const res = await doFetch(url, {
                method: 'GET',
                headers,
                credentials: 'same-origin',
                signal: controller.signal,
            });
            if (res.status === 401 || res.status === 403) {
                stopped = true;
                opts.onError?.(new SyncUnauthorized(SYNC_ROUTES.events));
                return;
            }
            if (!res.ok || !res.body)
                throw new Error(`sync ${SYNC_ROUTES.events} failed: ${res.status} ${res.statusText}`);
            // Connected: the next pause, if there is one, starts short again.
            wait = firstRetry;
            await read(res.body, controller.signal);
        }
        catch (err) {
            if (stopped)
                return;
            opts.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
        schedule();
    };
    void connect();
    return {
        stop() {
            stopped = true;
            if (timer)
                clearTimeout(timer);
            timer = null;
            controller?.abort();
        },
        get active() {
            return !stopped;
        },
    };
}
