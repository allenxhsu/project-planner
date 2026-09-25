import XCTest
// Not `@testable`, for the same reason as PublicSurfaceTests: an app drives
// pairing entirely through the public surface, and a fake sign-in sheet is
// exactly the seam an app's own tests will reach for.
import SyncKit

final class PairingTests: XCTestCase {
    private let origin = "https://toolkit.example"

    /// A sign-in sheet that never opens: it answers with the link the Portal
    /// would have redirected to, so the whole flow runs in a test process.
    private func fakeSheet(token: String = "t0ken", device: String? = "dev-1",
                           origin: String? = nil) -> PairingFlow.Present {
        let replyOrigin = origin ?? self.origin
        return { page, scheme in
            // The page the sheet would have opened carries the scheme, which
            // is how the Portal knows where to send the person back.
            XCTAssertEqual(page.path, "/devices/pair")
            let query = URLComponents(url: page, resolvingAgainstBaseURL: false)?.queryItems ?? []
            XCTAssertEqual(query.first { $0.name == "scheme" }?.value, scheme)
            return URL(string: ConnectLink.build(scheme: scheme, origin: replyOrigin, token: token, deviceId: device))!
        }
    }

    // MARK: The link

    func testTheConnectLinkRoundTrips() throws {
        let raw = ConnectLink.build(scheme: "sysml", origin: "https://toolkit.example/", token: "abc", deviceId: "d7")
        let parsed = try XCTUnwrap(ConnectLink.parse(scheme: "sysml", raw))
        XCTAssertEqual(parsed.url, "https://toolkit.example")
        XCTAssertEqual(parsed.token, "abc")
        XCTAssertEqual(parsed.deviceId, "d7")
        XCTAssertEqual(parsed.workspaceURL(for: "sysml"), "https://toolkit.example/w/sysml")
    }

    func testTheLinkRulesMatchTheJavaScriptClients() {
        // A LAN link from a QR code: no Portal behind it, so no device id.
        let lan = ConnectLink.parse(scheme: "sysml", "sysml://connect?url=http%3A%2F%2F192.168.1.5%3A7761&token=t")
        XCTAssertEqual(lan?.url, "http://192.168.1.5:7761")
        XCTAssertNil(lan?.deviceId)
        // `sysml:connect?…`, which some senders produce, is the same link.
        XCTAssertNotNil(ConnectLink.parse(scheme: "sysml", "sysml:connect?url=https%3A%2F%2Fa.example&token=t"))
        // Another app's link, another action, a missing token: all refused.
        XCTAssertNil(ConnectLink.parse(scheme: "sysml", "pyramid://connect?url=https%3A%2F%2Fa.example&token=t"))
        XCTAssertNil(ConnectLink.parse(scheme: "sysml", "sysml://open?url=https%3A%2F%2Fa.example&token=t"))
        XCTAssertNil(ConnectLink.parse(scheme: "sysml", "sysml://connect?url=https%3A%2F%2Fa.example"))
        // A bare origin and nothing else: a path here would be a redirect
        // somebody smuggled into the link, and the token would follow it.
        XCTAssertNil(ConnectLink.parse(scheme: "sysml", "sysml://connect?url=https%3A%2F%2Fa.example%2Fsteal&token=t"))
        XCTAssertNil(ConnectLink.parse(scheme: "sysml", "sysml://connect?url=javascript%3Aalert(1)&token=t"))
        XCTAssertNil(ConnectLink.parse(scheme: "sysml", "not a url at all"))
    }

    // MARK: The flow

    func testPairingKeepsWhatTheSheetReturned() async throws {
        let store = MemoryPairingStore()
        let flow = PairingFlow(portalOrigin: origin + "/", scheme: "sysml", store: store, present: fakeSheet())

        XCTAssertNil(try flow.current())
        XCTAssertEqual(flow.pairingPage.absoluteString, "\(origin)/devices/pair?scheme=sysml")

        let paired = try await flow.pair(label: "Allen's Mac")
        XCTAssertEqual(paired, DevicePairing(url: origin, token: "t0ken", deviceId: "dev-1"))
        XCTAssertEqual(try flow.current(), paired)
    }

    func testTheDeviceLabelReachesThePairingPage() async throws {
        let seen = LabelBox()
        let replyOrigin = origin
        let flow = PairingFlow(portalOrigin: origin, scheme: "sysml", store: MemoryPairingStore()) { page, scheme in
            let query = URLComponents(url: page, resolvingAgainstBaseURL: false)?.queryItems ?? []
            seen.value = query.first { $0.name == "label" }?.value
            return URL(string: ConnectLink.build(scheme: scheme, origin: replyOrigin, token: "t"))!
        }
        try await flow.pair(label: "Allen's Mac")
        XCTAssertEqual(seen.value, "Allen's Mac")
    }

    func testARefusedSheetLeavesTheOldPairingAlone() async throws {
        let store = MemoryPairingStore(DevicePairing(url: origin, token: "old", deviceId: "dev-0"))
        let cancelled = PairingFlow(portalOrigin: origin, scheme: "sysml", store: store) { _, _ in
            throw PairingError.cancelled
        }
        do {
            try await cancelled.pair()
            XCTFail("a cancelled sheet should throw")
        } catch let error as PairingError {
            XCTAssertEqual(error, .cancelled)
        }
        XCTAssertEqual(try cancelled.current()?.token, "old")

        // A sheet that comes back with somebody else's link is a failure too,
        // not a reason to throw away a token that works.
        let wrong = PairingFlow(portalOrigin: origin, scheme: "sysml", store: store) { _, _ in
            URL(string: "pyramid://connect?url=https%3A%2F%2Fa.example&token=t")!
        }
        do {
            try await wrong.pair()
            XCTFail("another app's link should throw")
        } catch is PairingError {}
        XCTAssertEqual(try wrong.current()?.token, "old")
    }

    func testSignOutRevokesTheDeviceAtThePortal() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RecordingProtocol.self]
        RecordingProtocol.reset(status: 204)

        let store = MemoryPairingStore()
        let flow = PairingFlow(portalOrigin: origin, scheme: "sysml", store: store,
                               session: URLSession(configuration: configuration), present: fakeSheet(device: "dev-9"))
        try await flow.pair()

        let result = try await flow.signOut()
        XCTAssertTrue(result.revoked)
        XCTAssertNil(result.revocationError)
        XCTAssertNil(try flow.current())

        let request = try XCTUnwrap(RecordingProtocol.seen.last)
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.absoluteString, "\(origin)/auth/devices/dev-9")
        // The device authenticates its own revocation with the token it is
        // giving up; there is no session cookie on a Mac to do it with.
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer t0ken")
    }

    func testAPortalThatRefusesTheRevocationStillSignsOutLocally() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RecordingProtocol.self]
        RecordingProtocol.reset(status: 403)

        let flow = PairingFlow(portalOrigin: origin, scheme: "sysml", store: MemoryPairingStore(),
                               session: URLSession(configuration: configuration), present: fakeSheet())
        try await flow.pair()
        let result = try await flow.signOut()
        XCTAssertFalse(result.revoked)
        XCTAssertEqual(result.revocationError as? PairingError, .revocationRefused(status: 403))
        XCTAssertNil(try flow.current())
    }

    func testSignOutForgetsTheTokenEvenWhenThePortalIsUnreachable() async throws {
        let store = MemoryPairingStore()
        // Nothing is listening on this port, so the DELETE fails the way it
        // fails on a plane.
        let flow = PairingFlow(portalOrigin: "http://127.0.0.1:1", scheme: "sysml", store: store,
                               present: fakeSheet(origin: "http://127.0.0.1:1"))
        try await flow.pair()
        XCTAssertNotNil(try flow.current())

        let result = try await flow.signOut()
        XCTAssertTrue(result.wasPaired)
        XCTAssertFalse(result.revoked)
        XCTAssertNotNil(result.revocationError)
        XCTAssertNil(try flow.current(), "the Keychain item goes whether or not the Portal answered")
    }

    func testSignOutOfADeviceThatWasNeverPairedIsHarmless() async throws {
        let flow = PairingFlow(portalOrigin: origin, scheme: "sysml", store: MemoryPairingStore())
        let result = try await flow.signOut()
        XCTAssertFalse(result.wasPaired)
        XCTAssertFalse(result.revoked)
        XCTAssertNil(result.revocationError)
    }

    // MARK: The Keychain

    func testTheKeychainHoldsAPairingAcrossFlows() async throws {
        // A service name of its own, so a run never touches a real app's item.
        let service = "sync-kit.test.\(UUID().uuidString)"
        let store = KeychainPairingStore(service: service)
        // A machine with no usable Keychain (a locked login keychain on a
        // build agent) should report that, not fail the suite.
        do {
            try store.save(DevicePairing(url: origin, token: "probe"))
        } catch let error as PairingError {
            throw XCTSkip("no usable Keychain here: \(error.localizedDescription)")
        }
        defer { try? store.forget() }

        let flow = PairingFlow(portalOrigin: origin, scheme: "sysml", store: store, present: fakeSheet(token: "kept"))
        try await flow.pair()

        // A second flow, as after a relaunch: same service, same item.
        let reopened = PairingFlow(portalOrigin: origin, scheme: "sysml", store: KeychainPairingStore(service: service))
        XCTAssertEqual(try reopened.current(), DevicePairing(url: origin, token: "kept", deviceId: "dev-1"))

        try store.forget()
        XCTAssertNil(try reopened.current())
        // Forgetting twice is what a second Sign out does; it must not throw.
        XCTAssertNoThrow(try store.forget())
    }
}

/// A box for the value a `@Sendable` closure saw, without making the test class Sendable.
private final class LabelBox: @unchecked Sendable {
    var value: String?
}

/// A stand-in for the Portal: records the request and answers with a status.
/// `URLProtocol` rather than a local server, so the test has no port to pick
/// and nothing to leave running.
private final class RecordingProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) private static let lock = NSLock()
    nonisolated(unsafe) private static var requests: [URLRequest] = []
    nonisolated(unsafe) private static var status = 204

    static var seen: [URLRequest] { lock.withLock { requests } }

    static func reset(status newStatus: Int) {
        lock.withLock { requests = []; status = newStatus }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        RecordingProtocol.lock.withLock { RecordingProtocol.requests.append(request) }
        let response = HTTPURLResponse(url: request.url!, statusCode: RecordingProtocol.lock.withLock { RecordingProtocol.status },
                                       httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
