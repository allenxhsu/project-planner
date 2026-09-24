"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mergeRecord = mergeRecord;
/**
 * Last-write-wins merge for one record.
 *
 * Ordering: newer `updatedAt` wins; identical timestamps are broken by
 * comparing `origin` device ids, which is arbitrary but *consistent* — every
 * device, and the server, independently reach the same answer, which is what
 * makes the outcome independent of the order things arrived in.
 */
function mergeRecord(local, remote) {
    if (!local)
        return remote;
    if (remote.updatedAt > local.updatedAt)
        return remote;
    if (remote.updatedAt < local.updatedAt)
        return local;
    // `origin` is optional in the contract, so a record without one has to lose
    // to a record with one, everywhere, rather than compare as `undefined`.
    return (remote.origin ?? '') > (local.origin ?? '') ? remote : local;
}
