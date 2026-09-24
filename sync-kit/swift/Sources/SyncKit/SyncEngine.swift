import Foundation

/// Both cursors, for whoever has to clear them.
///
/// They describe one store's position against *one particular server*. Point
/// the same store at a different server and neither means anything there, so
/// changing the sync URL has to reset them.
public enum SyncCursorKeys {
    public static let pull = "sync.cursor.pull"
    public static let push = "sync.cursor.push"
    public static let all = [pull, push]
}

public struct SyncResult<Record: SyncRecord>: Sendable {
    public var pulled: Int
    public var pushed: Int
    /// Records that actually changed locally — the UI reloads only when non-empty.
    public var applied: [Record]
}

/// Bidirectional last-write-wins sync, the same algorithm as `src/engine.ts`.
///
/// Pull first, then push. In that order a record the remote already has a newer
/// version of is resolved before we consider sending ours, so we never push a
/// write we are about to discard.
///
/// Two cursors rather than one: the pull cursor is *remote* clock time and the
/// push cursor is *local* clock time. Conflating them drops writes whenever the
/// two machines' clocks disagree.
public actor SyncEngine<Store: SyncStore, Transport: SyncTransport> where Store.Record == Transport.Record {
    public typealias Record = Store.Record

    private let store: Store
    private let transport: Transport
    private let deviceId: String
    private var running = false

    public init(store: Store, transport: Transport, deviceId: String) {
        self.store = store
        self.transport = transport
        self.deviceId = deviceId
    }

    public var label: String { transport.label }

    @discardableResult
    public func sync() async throws -> SyncResult<Record> {
        if running {
            // Overlapping syncs would double-push the same window of records.
            return SyncResult(pulled: 0, pushed: 0, applied: [])
        }
        running = true
        defer { running = false }

        let applied = try await pull()
        let pushed = try await push()
        return SyncResult(pulled: applied.count, pushed: pushed, applied: applied)
    }

    private func pull() async throws -> [Record] {
        let since = try await store.meta(SyncCursorKeys.pull) ?? 0
        let response = try await transport.pull(PullRequest(since: since, deviceId: deviceId))

        var applied: [Record] = []
        for remote in response.records {
            // Resolve each incoming record against what we hold, and write back
            // only the ones that won. Rewriting losers would bump their local
            // timestamps and cause an endless push/pull ping-pong.
            let local = try await store.get(remote.id)
            let winner = mergeRecord(local, remote)
            if winner.origin == remote.origin, winner.updatedAt == remote.updatedAt,
               local == nil || local!.updatedAt != remote.updatedAt {
                applied.append(remote)
            }
        }
        if !applied.isEmpty { try await store.put(applied) }

        try await store.setMeta(SyncCursorKeys.pull, response.cursor)
        return applied
    }

    private func push() async throws -> Int {
        let since = try await store.meta(SyncCursorKeys.push) ?? 0
        let outgoing = try await store.changedSince(since)

        // Records we just merged in from the remote carry a foreign `origin`;
        // sending them straight back is pure noise.
        let mine = outgoing.filter { $0.origin == deviceId }
        // The high-water mark of what we *send*, not of what we saw. `outgoing`
        // also holds the records `pull` just merged in, stamped with the writing
        // device's clock; letting one of those move this cursor parks it in the
        // future whenever another device runs fast, and every local write
        // stamped before that point never leaves this machine.
        let mark = mine.reduce(since) { max($0, $1.updatedAt) }
        if mine.isEmpty {
            try await store.setMeta(SyncCursorKeys.push, mark)
            return 0
        }

        let response = try await transport.push(PushRequest(records: mine, deviceId: deviceId))
        try await store.setMeta(SyncCursorKeys.push, mark)
        return response.accepted
    }
}
