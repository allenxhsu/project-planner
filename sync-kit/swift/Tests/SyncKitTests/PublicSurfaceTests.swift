import XCTest
// Deliberately not `@testable`. Every other file in this target lifts internal
// access, which hides exactly the failures an app hits: a type it can name but
// cannot construct. `SyncTransport` is public so an app can stand in for
// `HttpTransport` — a loopback to the desktop app, a retry wrapper, a fake —
// and that app compiles against this surface, not the internal one.
import SyncKit

private struct Note: SyncRecord, Equatable {
    var id: String
    var updatedAt: Int
    var deletedAt: Int?
    var origin: String?
    var body: String?
}

/// The kind of transport an app supplies, written the way an app would have to.
private struct AppTransport: SyncTransport {
    typealias Record = Note

    let label = "loopback"
    let failWith: Int?

    func pull(_ request: PullRequest) async throws -> PullResponse<Note> {
        if let status = failWith { throw SyncTransportError(route: SyncRoutes.pull, status: status) }
        return PullResponse(records: [], cursor: request.since)
    }

    func push(_ request: PushRequest<Note>) async throws -> PushResponse {
        if let status = failWith { throw SyncTransportError(route: SyncRoutes.push, status: status) }
        return PushResponse(accepted: request.records.count, cursor: 0)
    }
}

final class PublicSurfaceTests: XCTestCase {
    func testAnAppCanBuildTheKitsErrorAndCatchItByType() async throws {
        let engine = SyncEngine(
            store: MemoryStore<Note>(name: "app"),
            transport: AppTransport(failWith: 503),
            deviceId: "phone",
        )

        do {
            _ = try await engine.sync()
            XCTFail("the transport refused, so the sync should have thrown")
        } catch let error as SyncTransportError {
            // The point of the test: a caller's `catch let e as SyncTransportError`
            // matches a failure the *app's* transport raised, not only one
            // `HttpTransport` raised. Without a public initialiser the app has
            // to invent its own error type and this arm never runs.
            XCTAssertEqual(error.status, 503)
            XCTAssertEqual(error.route, SyncRoutes.pull)
            XCTAssertEqual(error.errorDescription, "sync \(SyncRoutes.pull) failed: HTTP 503")
        }
    }

    func testAnAppSuppliedTransportDrivesTheEngine() async throws {
        let store = MemoryStore<Note>(name: "app")
        try await store.put([Note(id: "n1", updatedAt: 1000, deletedAt: nil, origin: "phone", body: "hello")])

        let engine = SyncEngine(store: store, transport: AppTransport(failWith: nil), deviceId: "phone")
        let result = try await engine.sync()

        XCTAssertEqual(result.pushed, 1, "the record went out through the app's own transport")
        let label = await engine.label
        XCTAssertEqual(label, "loopback")
    }
}
