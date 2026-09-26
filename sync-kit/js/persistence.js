/**
 * Whether the browser has promised to keep what the store holds.
 *
 * A browser tab is the one client whose copy of the workspace can vanish
 * without anyone deleting it. Storage is "best effort" by default: under disk
 * pressure the browser evicts an origin's IndexedDB and localStorage wholesale,
 * and Safari drops the lot after seven days without a visit. The remedy is to
 * ask — `navigator.storage.persist()` — and then to say, somewhere the person
 * can see it, whether the answer was yes.
 *
 * Who says yes, as of this writing:
 *
 * - **Chrome and Edge** decide without a prompt, on engagement: a site that is
 *   installed, bookmarked, granted notifications, or simply used often is
 *   granted; a site opened once is not, and asking again later can succeed.
 * - **Firefox** asks the person, once.
 * - **Safari** grants it to an installed web app — one added to the Home
 *   Screen or the Dock — which is also exempt from the seven-day eviction.
 *   A plain tab is not.
 *
 * `usage` and `quota` come from `estimate()` and are what a settings page
 * shows beside the answer. Everything here is guarded, because the same
 * module runs under Node in the tests and the mirror, where there is no
 * `navigator.storage` and no data to lose.
 */
function manager() {
    if (typeof navigator === 'undefined')
        return null;
    const found = navigator.storage;
    return found && typeof found.estimate === 'function' ? found : null;
}
/**
 * Reads the answer without asking the question. This is what the engine
 * publishes on every sync, so a widget can show "at risk" the moment a
 * browser has not granted persistence — and null where there is no browser.
 */
export async function storageStatus() {
    const storage = manager();
    if (!storage)
        return null;
    try {
        const [persisted, estimate] = await Promise.all([
            typeof storage.persisted === 'function' ? storage.persisted() : Promise.resolve(false),
            storage.estimate(),
        ]);
        return { persisted, usage: estimate.usage ?? null, quota: estimate.quota ?? null };
    }
    catch {
        return null;
    }
}
/**
 * Asks the browser to keep this origin's data, and reports where things
 * stand afterwards.
 *
 * Call it from a place that makes sense to a person — after the first sync,
 * or from a "keep my data on this device" button — rather than at page load,
 * because Firefox turns it into a prompt. A platform with no Storage API
 * answers `persisted: false`, which is the honest reading: nothing has
 * promised anything.
 */
export async function requestPersistentStorage() {
    const storage = manager();
    if (!storage || typeof storage.persist !== 'function')
        return { persisted: false, usage: null, quota: null };
    let persisted = false;
    try {
        persisted = await storage.persist();
    }
    catch {
        persisted = false;
    }
    const status = await storageStatus();
    return { persisted, usage: status?.usage ?? null, quota: status?.quota ?? null };
}
