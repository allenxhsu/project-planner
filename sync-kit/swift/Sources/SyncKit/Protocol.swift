import Foundation

/// The wire protocol, field for field with `src/protocol.ts`.
///
/// Two routes and four shapes. The server keeps no session and no per-client
/// state beyond the sequence number it hands back, which is what lets the same
/// endpoint be an Electron process on loopback and a Cloud Run service.
public struct PullRequest: Codable, Sendable {
    public var since: Int
    public var deviceId: String

    public init(since: Int, deviceId: String) {
        self.since = since
        self.deviceId = deviceId
    }
}

public struct PullResponse<Record: SyncRecord>: Codable, Sendable {
    public var records: [Record]
    /// Feed back as `since` on the next pull.
    public var cursor: Int

    // Spelled out because a memberwise initialiser is internal: the two
    // responses are built by anything standing in for a server — a test's fake
    // remote, a loopback server in the app itself — and those live outside
    // this module.
    public init(records: [Record], cursor: Int) {
        self.records = records
        self.cursor = cursor
    }
}

public struct PushRequest<Record: SyncRecord>: Codable, Sendable {
    public var records: [Record]
    public var deviceId: String

    public init(records: [Record], deviceId: String) {
        self.records = records
        self.deviceId = deviceId
    }
}

public struct PushResponse: Codable, Sendable {
    public var accepted: Int
    /// Server clock at the time of the write, so clients can advance safely.
    public var cursor: Int

    public init(accepted: Int, cursor: Int) {
        self.accepted = accepted
        self.cursor = cursor
    }
}

public enum SyncRoutes {
    public static let pull = "/sync/pull"
    public static let push = "/sync/push"
    public static let health = "/sync/health"
}

/// Anything that can move records between two stores.
public protocol SyncTransport<Record>: Sendable {
    associatedtype Record: SyncRecord
    var label: String { get }
    func pull(_ request: PullRequest) async throws -> PullResponse<Record>
    func push(_ request: PushRequest<Record>) async throws -> PushResponse
}

public struct SyncTransportError: LocalizedError {
    public let route: String
    public let status: Int
    public var errorDescription: String? { "sync \(route) failed: HTTP \(status)" }

    // Public for the same reason the two responses' initialisers are: an app
    // standing in for `HttpTransport` has to be able to report a failure in the
    // kit's own error type, or its caller's `catch let e as SyncTransportError`
    // never matches.
    public init(route: String, status: Int) {
        self.route = route
        self.status = status
    }
}
