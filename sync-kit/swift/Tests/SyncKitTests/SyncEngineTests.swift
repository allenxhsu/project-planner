import XCTest
@testable import SyncKit

/// A record with a field the kit has never heard of, which has to survive the
/// round trip like any other.
struct Card: SyncRecord, Equatable {
    var id: String
    var updatedAt: Int
    var deletedAt: Int?
    var origin: String?
    var title: String?

    init(_ id: String, _ updatedAt: Int, _ origin: String, title: String? = nil, deletedAt: Int? = nil) {
        self.id = id
        self.updatedAt = updatedAt
        self.origin = origin
        self.title = title
        self.deletedAt = deletedAt
    }
}

/// A server in an actor.
///
/// The real one is covered by the server's own conformance suite; what these
/// tests need is a remote whose clock they own. Sequence numbers belong to the
/// remote rather than to a connection, exactly as they do in the real server,
/// so two engines sharing one of these are two devices on one server.
actor FakeRemote: SyncTransport {
    typealias Record = Card

    nonisolated let label: String
    private var records: [String: Card] = [:]
    private var order: [String: Int] = [:]
    private var seq = 0
    private(set) var pulls = 0
    private(set) var pushes = 0

    init(label: String = "fake") {
        self.label = label
    }

    /// Puts a record in as if some other client had written it.
    func seed(_ record: Card) {
        records[record.id] = record
        seq += 1
        order[record.id] = seq
    }

    func held(_ id: String) -> Card? { records[id] }

    func pull(_ request: PullRequest) async throws -> PullResponse<Card> {
        pulls += 1
        let page = records.values
            .filter { (order[$0.id] ?? 0) > request.since }
            .sorted { (order[$0.id] ?? 0) < (order[$1.id] ?? 0) }
        return PullResponse(records: page, cursor: seq)
    }

    func push(_ request: PushRequest<Card>) async throws -> PushResponse {
        pushes += 1
        var accepted = 0
        for record in request.records {
            // The server runs the same merge rule as the client, so a device
            // with a slow clock cannot overwrite a newer record by pushing
            // later. A loser is not an error; it is simply not counted.
            if let held = records[record.id], !beats(record, held) { continue }
            records[record.id] = record
            // Renumbered at the end of the stream: a record just written is
            // the most recent thing anyone pulling should see.
            seq += 1
            order[record.id] = seq
            accepted += 1
        }
        return PushResponse(accepted: accepted, cursor: seq)
    }

    /// `mergeRecord`, spelled as a comparison: the fake has to count winners,
    /// not pick them, and asking which of two values a merge returned is not
    /// something value semantics can answer.
    private func beats(_ incoming: Card, _ held: Card) -> Bool {
        if incoming.updatedAt != held.updatedAt { return incoming.updatedAt > held.updatedAt }
        return (incoming.origin ?? "") > (held.origin ?? "")
    }
}

final class MergeRuleTests: XCTestCase {
    func testLastWriteWins() {
        XCTAssertEqual(mergeRecord(nil, Card("a", 1, "x")).origin, "x", "nothing local: the remote is it")
        XCTAssertEqual(mergeRecord(Card("a", 2, "x"), Card("a", 1, "y")).updatedAt, 2, "newer wins")
        XCTAssertEqual(mergeRecord(Card("a", 1, "x"), Card("a", 2, "y")).updatedAt, 2, "newer wins the other way")
    }

    func testTiesBreakTheSameWayFromEitherSide() {
        XCTAssertEqual(mergeRecord(Card("a", 1, "x"), Card("a", 1, "y")).origin, "y")
        XCTAssertEqual(mergeRecord(Card("a", 1, "y"), Card("a", 1, "x")).origin, "y")
    }

    func testARecordWithoutAnOriginLoses() {
        var anonymous = Card("a", 1, "")
        anonymous.origin = nil
        XCTAssertEqual(mergeRecord(anonymous, Card("a", 1, "x")).origin, "x")
    }

    /// The whole reason the Swift half exists: a phone and a browser tab reach
    /// the same answer, so the rule is written twice and must agree twice.
    func testItAgreesWithTheTypeScriptRule() {
        // `mergeRecord(local, remote)` in `src/store.ts`, same arguments.
        XCTAssertEqual(mergeRecord(Card("a", 1000, "mac"), Card("a", 1000, "phone")).origin, "phone")
        XCTAssertEqual(mergeRecord(Card("a", 1001, "mac"), Card("a", 1000, "phone")).origin, "mac")
    }
}

final class WireShapeTests: XCTestCase {
    /// The field names are the protocol. A rename here is a client that talks
    /// to nothing, and nothing else in this package would notice.
    func testRequestsEncodeTheFieldsTheServerReads() throws {
        let pull = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(PullRequest(since: 7, deviceId: "b7c1"))
        ) as? [String: Any]
        XCTAssertEqual(pull?["since"] as? Int, 7)
        XCTAssertEqual(pull?["deviceId"] as? String, "b7c1")

        let push = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(PushRequest(records: [Card("one", 1000, "phone", title: "hello")], deviceId: "b7c1"))
        ) as? [String: Any]
        let records = push?["records"] as? [[String: Any]]
        XCTAssertEqual(push?["deviceId"] as? String, "b7c1")
        XCTAssertEqual(records?.first?["id"] as? String, "one")
        XCTAssertEqual(records?.first?["updatedAt"] as? Int, 1000)
        XCTAssertEqual(records?.first?["title"] as? String, "hello", "a field the kit knows nothing about travels")
        XCTAssertNil(records?.first?["deletedAt"], "and an absent tombstone is absent, not null")
    }

    func testResponsesDecodeWhatTheServerSends() throws {
        let pull = """
        {"records":[{"id":"one","updatedAt":1000,"origin":"mac","deletedAt":null,"title":"from the mac"}],"cursor":42}
        """
        let decoded = try JSONDecoder().decode(PullResponse<Card>.self, from: Data(pull.utf8))
        XCTAssertEqual(decoded.cursor, 42)
        XCTAssertEqual(decoded.records.first?.title, "from the mac")
        XCTAssertNil(decoded.records.first?.deletedAt, "an explicit null is not a tombstone")

        let push = try JSONDecoder().decode(PushResponse.self, from: Data(#"{"accepted":3,"cursor":44}"#.utf8))
        XCTAssertEqual(push.accepted, 3)
    }

    /// The label reaches a person's screen, so the two halves of the kit have
    /// to derive it identically — these are the answers `nameOf` in
    /// `src/http.ts` gives for the same inputs.
    func testTheDefaultLabelMatchesTheTypeScriptOne() {
        XCTAssertEqual(nameOf("https://sync-server-76qncr5ydq-uc.a.run.app/w/heptabase"), "heptabase")
        XCTAssertEqual(nameOf("http://192.168.1.14:8787/w/habit"), "habit")
        XCTAssertEqual(nameOf("https://example.test"), "example.test", "no workspace segment: the host names it")
        XCTAssertEqual(nameOf("http://127.0.0.1:8787"), "127.0.0.1:8787", "and the port, which is what tells two loopback servers apart")
        XCTAssertEqual(nameOf("not a url"), "not a url", "a wrong label beats refusing to sync")
    }

    func testTheLabelNeverCarriesTheToken() {
        let transport = HttpTransport<Card>(baseUrl: "https://host/w/habit", token: "secret-token-value")
        XCTAssertEqual(transport.label, "habit")
        XCTAssertFalse(transport.label.contains("secret"), "the label lands in the DOM and in screenshots")
    }

    func testTheRoutesAreTheOnesTheServerServes() {
        XCTAssertEqual(SyncRoutes.pull, "/sync/pull")
        XCTAssertEqual(SyncRoutes.push, "/sync/push")
        XCTAssertEqual(SyncRoutes.health, "/sync/health")
    }
}

final class MemoryStoreTests: XCTestCase {
    func testChangedSinceIsExclusive() async throws {
        let store = MemoryStore<Card>()
        try await store.put([Card("a", 1000, "mac"), Card("b", 2000, "mac")])
        let after = try await store.changedSince(1000).map(\.id)
        let everything = try await store.changedSince(0)
        XCTAssertEqual(after, ["b"], "the push cursor is the last thing sent, so it must not come back")
        XCTAssertEqual(everything.count, 2)
    }

    func testPutIsAnUpsert() async throws {
        let store = MemoryStore<Card>()
        try await store.put([Card("a", 1000, "mac")])
        try await store.put([Card("a", 2000, "phone")])
        let held = try await store.all()
        let updated = try await store.get("a")
        XCTAssertEqual(held.count, 1)
        XCTAssertEqual(updated?.origin, "phone")
    }
}

final class SyncEngineTests: XCTestCase {
    func testTwoDevicesConverge() async throws {
        let server = FakeRemote()
        let macStore = MemoryStore<Card>(name: "mac")
        let phoneStore = MemoryStore<Card>(name: "phone")
        let mac = SyncEngine(store: macStore, transport: server, deviceId: "mac")
        let phone = SyncEngine(store: phoneStore, transport: server, deviceId: "phone")

        try await macStore.put([Card("one", 1000, "mac", title: "from the mac")])
        try await phoneStore.put([Card("two", 1100, "phone", title: "from the phone")])

        // Twice each: the first pass on either side pushes before the other has
        // pulled, so one round is not enough for both to see both.
        for _ in 0..<2 {
            try await mac.sync()
            try await phone.sync()
        }

        let onMac = try await macStore.all().map(\.id).sorted()
        let onPhone = try await phoneStore.all().map(\.id).sorted()
        let crossed = try await macStore.get("two")
        XCTAssertEqual(onMac, ["one", "two"])
        XCTAssertEqual(onPhone, ["one", "two"])
        XCTAssertEqual(crossed?.title, "from the phone", "the body travelled untouched")
    }

    func testAnIdleSyncMovesNothing() async throws {
        let server = FakeRemote()
        let store = MemoryStore<Card>()
        let engine = SyncEngine(store: store, transport: server, deviceId: "mac")
        try await engine.sync()
        let pushesBefore = await server.pushes

        let idle = try await engine.sync()
        XCTAssertEqual(idle.pulled, 0)
        XCTAssertEqual(idle.pushed, 0)
        let pushes = await server.pushes
        let pulls = await server.pulls
        XCTAssertEqual(pushes, pushesBefore, "it does not push an empty batch")
        XCTAssertGreaterThan(pulls, 1, "but it still pulls — that is how it finds out")
    }

    func testAMergedInRecordIsNeverPushedBack() async throws {
        let server = FakeRemote()
        await server.seed(Card("theirs", 1000, "phone"))
        let store = MemoryStore<Card>()
        let engine = SyncEngine(store: store, transport: server, deviceId: "mac")

        let first = try await engine.sync()
        XCTAssertEqual(first.pulled, 1)
        XCTAssertEqual(first.pushed, 0, "what came in does not go straight back out")

        try await store.put([Card("mine", 2000, "mac")])
        let second = try await engine.sync()
        XCTAssertEqual(second.pushed, 1, "only the record this device wrote")
    }

    func testALosingPullLeavesTheLocalRecordAlone() async throws {
        let server = FakeRemote()
        await server.seed(Card("one", 5000, "phone", title: "stale"))
        let store = MemoryStore<Card>()
        try await store.put([Card("one", 9000, "mac", title: "edited on the mac")])
        let engine = SyncEngine(store: store, transport: server, deviceId: "mac")

        let result = try await engine.sync()
        let survivor = try await store.get("one")
        XCTAssertEqual(survivor?.title, "edited on the mac", "the newer local copy survived")
        XCTAssertTrue(result.applied.isEmpty, "and the loser is not in applied, so no UI reloads over it")
    }

    func testADeletionTravels() async throws {
        let server = FakeRemote()
        let macStore = MemoryStore<Card>()
        let phoneStore = MemoryStore<Card>()
        let mac = SyncEngine(store: macStore, transport: server, deviceId: "mac")
        let phone = SyncEngine(store: phoneStore, transport: server, deviceId: "phone")

        try await macStore.put([Card("one", 1000, "mac")])
        try await mac.sync()
        try await phone.sync()
        let arrived = try await phoneStore.get("one")
        XCTAssertNotNil(arrived)

        try await macStore.put([Card("one", 2000, "mac", deletedAt: 2000)])
        try await mac.sync()
        try await phone.sync()
        let tombstone = try await phoneStore.get("one")
        XCTAssertEqual(tombstone?.deletedAt, 2000, "the row stays so the deletion can travel")
    }

    func testRepointingADeviceNeedsItsCursorsCleared() async throws {
        let store = MemoryStore<Card>()
        try await store.put((0..<5).map { Card("m\($0)", 7000 + $0, "cutover") })
        try await SyncEngine(store: store, transport: FakeRemote(label: "first"), deviceId: "cutover").sync()

        // The cursors describe a position against one particular server.
        let kept = try await SyncEngine(store: store, transport: FakeRemote(label: "second"), deviceId: "cutover").sync()
        XCTAssertEqual(kept.pushed, 0, "carried over, the new server gets nothing at all")

        for key in SyncCursorKeys.all { try await store.setMeta(key, 0) }
        let reset = try await SyncEngine(store: store, transport: FakeRemote(label: "third"), deviceId: "cutover").sync()
        XCTAssertEqual(reset.pushed, 5, "cleared, it uploads the lot")
    }

    func testARecordWrittenWhileASyncRunsIsNotSkipped() async throws {
        // The push high-water mark comes from the records actually sent, not
        // from the remote's head: a record written while the pull was in
        // flight would otherwise sit below the cursor and never go out.
        let server = FakeRemote()
        let store = MemoryStore<Card>()
        let engine = SyncEngine(store: store, transport: server, deviceId: "racer")

        async let syncing: Void = { _ = try await engine.sync() }()
        try await store.put([Card("written-mid-sync", 4000, "racer")])
        try await syncing

        _ = try await engine.sync()
        let uploaded = await server.held("written-mid-sync")
        let settled = try await engine.sync()
        XCTAssertNotNil(uploaded, "it reached the remote")
        XCTAssertEqual(settled.pushed, 0, "and is not sent for ever after")
    }

    func testTheLabelSaysWhichRemote() async throws {
        let engine = SyncEngine(store: MemoryStore<Card>(), transport: FakeRemote(label: "habit"), deviceId: "phone")
        let label = await engine.label
        XCTAssertEqual(label, "habit")
    }

    func testAFastRemoteClockDoesNotSwallowThisDevicesWrites() async throws {
        // `changedSince` also hands back what the pull just merged in, stamped
        // with the writing device's clock. Advancing the push cursor to the
        // high-water mark of all of it parks this device's cursor in the
        // future whenever another one runs fast, and every local write until
        // the clocks meet again falls below it and never goes out — silently,
        // with sync reporting success on every pass.
        let hub = FakeRemote()
        let fastStore = MemoryStore<Card>(name: "fast")
        let slowStore = MemoryStore<Card>(name: "slow")
        let fast = SyncEngine(store: fastStore, transport: hub, deviceId: "fast")
        let slow = SyncEngine(store: slowStore, transport: hub, deviceId: "slow")

        // An hour ahead, which is ordinary for a machine nobody has set up NTP on.
        try await fastStore.put([Card("from-fast", 9_000_000 + 3_600_000, "fast")])
        _ = try await fast.sync()
        _ = try await slow.sync()
        let arrived = try await slowStore.get("from-fast")
        XCTAssertNotNil(arrived, "the fast device's record arrived")

        // Written afterwards, but by the correct clock, so it is an hour
        // "older" than what was just merged in.
        try await slowStore.put([Card("from-slow", 9_000_000, "slow")])
        let out = try await slow.sync()
        XCTAssertEqual(out.pushed, 1, "our own write still goes out")
        _ = try await fast.sync()
        let landed = try await fastStore.get("from-slow")
        XCTAssertNotNil(landed, "and reaches the other device")
    }
}
