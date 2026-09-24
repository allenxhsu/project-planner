import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A name for a workspace URL that a person would recognise.
///
/// The same rule as `nameOf` in `src/http.ts`, and it has to stay the same
/// rule: the label is what a status view shows, so a phone and a browser tab
/// pointed at one server should not call it two different things. The
/// workspace segment of `https://host/w/habit` says everything useful and
/// nothing sensitive — a whole URL can carry a token, and does not belong on
/// screen. A string that is not a URL is handed back as it came, because a
/// wrong label is better than no sync.
func nameOf(_ baseUrl: String) -> String {
    guard let url = URL(string: baseUrl), let hostname = url.host else { return baseUrl }
    if let workspace = url.path.split(separator: "/").last { return String(workspace) }
    // The port is part of what distinguishes two loopback servers, which is
    // exactly the case where an app has no workspace segment to show.
    return url.port.map { "\(hostname):\($0)" } ?? hostname
}

/// HTTP transport on `URLSession`.
///
/// `baseUrl` is the workspace URL — `https://host/w/habit` — and the routes are
/// appended, so pointing a phone at the desktop app on the LAN or at the hosted
/// service is the same one-line change it is on the web side.
public struct HttpTransport<Record: SyncRecord>: SyncTransport {
    public let label: String
    private let baseUrl: String
    private let token: String?
    private let session: URLSession

    public init(baseUrl: String, token: String? = nil, label: String? = nil, session: URLSession = .shared) {
        // A trailing slash would produce `//sync/pull`, which some proxies
        // redirect and URLSession then re-sends as a GET.
        self.baseUrl = baseUrl.hasSuffix("/") ? String(baseUrl.dropLast()) : baseUrl
        self.token = token
        self.label = label ?? nameOf(baseUrl)
        self.session = session
    }

    private func call<Request: Encodable, Response: Decodable>(_ route: String, _ body: Request) async throws -> Response {
        guard let url = URL(string: baseUrl + route) else {
            throw SyncTransportError(route: route, status: 0)
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.httpBody = try JSONEncoder().encode(body)
        // A phone that just left Wi-Fi would otherwise sit on "Syncing…" for
        // minutes; a bounded wait fails fast and the next trigger retries.
        request.timeoutInterval = 20

        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw SyncTransportError(route: route, status: status)
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }

    public func pull(_ request: PullRequest) async throws -> PullResponse<Record> {
        try await call(SyncRoutes.pull, request)
    }

    public func push(_ request: PushRequest<Record>) async throws -> PushResponse {
        try await call(SyncRoutes.push, request)
    }
}
