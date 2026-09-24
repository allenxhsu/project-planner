import Foundation

/// What sync-kit needs to know about your records.
///
/// The same four fields as the TypeScript side, and for the same reason: the
/// kit never looks at the rest, so one server carries a habit tracker's
/// entries and a note app's cards without knowing what either of them is.
///
/// Where Swift differs from the TypeScript client, and it matters: your type
/// *is* the JSON boundary here, so `Codable`'s synthesised decoder drops any
/// field it has no property for. A record another device wrote under a newer
/// schema comes back missing those fields, and the next local edit pushes the
/// truncated version — which then wins on `updatedAt` for everyone. The
/// JavaScript client keeps them, because there the record stays a plain
/// object. If the workspace is shared with clients that may run ahead of this
/// build, give your type a catch-all that round-trips the remainder:
///
/// ```swift
/// struct Card: SyncRecord {
///     var id: String
///     var updatedAt: Int
///     var deletedAt: Int?
///     var origin: String?
///     var title: String
///     /// Everything a newer client sent that this build has no property for.
///     var extra: [String: JSONValue] = [:]
/// }
/// ```
///
/// with `init(from:)` and `encode(to:)` collecting and re-emitting the unknown
/// keys. A single-app workspace, where every client is built from this one
/// struct, does not need it.
public protocol SyncRecord: Codable, Sendable {
    var id: String { get }
    /// Milliseconds since the epoch, from the device that wrote it. A logical clock.
    var updatedAt: Int { get }
    /// Tombstone. Non-nil means deleted; the row stays so the deletion can travel.
    var deletedAt: Int? { get }
    /// Device that last wrote this record. Breaks `updatedAt` ties.
    var origin: String? { get }
}

/// The single persistence seam.
///
/// An implementation over SwiftData, a file, or a dictionary is all the same to
/// the engine. The SwiftData adapter lives in the app that needs it rather than
/// here, because it has to know the app's own model types.
public protocol SyncStore<Record>: Sendable {
    associatedtype Record: SyncRecord

    /// Every record including tombstones. Callers filter the deleted ones out.
    func all() async throws -> [Record]
    func get(_ id: String) async throws -> Record?
    /// Upsert. Records arrive with `updatedAt` already stamped by the caller.
    func put(_ records: [Record]) async throws
    /// Records touched strictly after `ts` — the outgoing half of a sync.
    ///
    /// Exclusive on purpose: the push cursor is the highest `updatedAt` already
    /// sent, so including it would re-send that record on every idle pass.
    func changedSince(_ ts: Int) async throws -> [Record]

    /// The cursor space. Only the two sync cursors live here, so it is typed to
    /// what they are rather than made generic over anything an app might store.
    func meta(_ key: String) async throws -> Int?
    func setMeta(_ key: String, _ value: Int) async throws

    func clear() async throws
}

/// Last-write-wins merge for one record.
///
/// Newer `updatedAt` wins; identical timestamps are broken by comparing
/// `origin` device ids, which is arbitrary but *consistent* — every device, and
/// the server, independently reach the same answer, which is what makes the
/// outcome independent of the order things arrived in.
public func mergeRecord<R: SyncRecord>(_ local: R?, _ remote: R) -> R {
    guard let local else { return remote }
    if remote.updatedAt > local.updatedAt { return remote }
    if remote.updatedAt < local.updatedAt { return local }
    // `origin` is optional in the contract, so a record without one has to lose
    // to a record with one, everywhere, rather than compare as nil.
    return (remote.origin ?? "") > (local.origin ?? "") ? remote : local
}

/// Everything in a dictionary, for tests and for scratch workspaces.
public actor MemoryStore<Record: SyncRecord>: SyncStore {
    private var records: [String: Record] = [:]
    private var metadata: [String: Int] = [:]
    public let name: String

    public init(name: String = "memory") {
        self.name = name
    }

    public func all() async throws -> [Record] { Array(records.values) }
    public func get(_ id: String) async throws -> Record? { records[id] }

    public func put(_ incoming: [Record]) async throws {
        for record in incoming { records[record.id] = record }
    }

    public func changedSince(_ ts: Int) async throws -> [Record] {
        records.values.filter { $0.updatedAt > ts }
    }

    public func meta(_ key: String) async throws -> Int? { metadata[key] }
    public func setMeta(_ key: String, _ value: Int) async throws { metadata[key] = value }

    public func clear() async throws {
        records.removeAll()
        metadata.removeAll()
    }
}
