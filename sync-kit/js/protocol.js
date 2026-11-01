export const SYNC_ROUTES = {
    pull: '/sync/pull',
    push: '/sync/push',
    health: '/sync/health',
    /** `GET`: a server-sent event per accepted push. See `watch.ts`. */
    events: '/sync/events',
};
