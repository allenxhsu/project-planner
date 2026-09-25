import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(AuthenticationServices)
import AuthenticationServices
#endif
#if canImport(Security)
import Security
#endif
#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

/// How a native app gets a token for the Portal.
///
/// The browser signs in with Google and keeps a cookie; a Mac or iOS app has
/// no access to that cookie and cannot show Google's page inside its own web
/// view (Google refuses embedded web views, and rightly so). So the app opens
/// the Portal's `/devices/pair` page in `ASWebAuthenticationSession` — Safari's
/// own sandbox, with Safari's cookies, so a person already signed in on this
/// device usually just taps once. The page mints a device token and redirects
/// to `<scheme>://connect?url=<origin>&token=<token>`; the system hands that
/// URL back to the session, and the app keeps the pair in the Keychain.
///
/// ```swift
/// let flow = PairingFlow(portalOrigin: "https://toolkit.example", scheme: "sysml")
/// let paired = try await flow.pair(label: Host.current().localizedName)
/// let transport = HttpTransport<Card>(baseUrl: paired.workspaceURL(for: "sysml"), token: paired.token)
/// ```
///
/// The web half of this is `src/connectLink.ts`: same link, same rules. A
/// desktop app pairing a phone over the LAN builds the same link into a QR
/// code, which is why `ConnectLink` here is separate from the Portal flow —
/// the app that scans a QR code has a link and no sign-in sheet.
public struct PairingFlow: Sendable {
    /// Opens the pairing page and answers with the `<scheme>://connect?…` URL
    /// the page redirected to. The default runs `ASWebAuthenticationSession`;
    /// tests pass a fake that returns a link without a browser.
    public typealias Present = @Sendable (_ page: URL, _ scheme: String) async throws -> URL

    /// The Portal's origin: `https://toolkit.example`, no trailing slash.
    public let portalOrigin: String
    /// The app's own URL scheme, the one its `Info.plist` registers: `sysml`.
    public let scheme: String
    private let store: any PairingStore
    private let present: Present
    private let session: URLSession

    public init(portalOrigin: String,
                scheme: String,
                store: (any PairingStore)? = nil,
                session: URLSession = .shared,
                present: Present? = nil) {
        self.portalOrigin = PairingFlow.trimOrigin(portalOrigin)
        self.scheme = scheme
        self.store = store ?? KeychainPairingStore(service: "\(scheme).connect")
        self.session = session
        self.present = present ?? PairingFlow.webAuthentication
    }

    /// The page the sign-in sheet opens. `scheme` tells the Portal where to
    /// send the person back; it never sends a token anywhere else.
    public var pairingPage: URL {
        var components = URLComponents(string: portalOrigin + "/devices/pair")
        components?.queryItems = [URLQueryItem(name: "scheme", value: scheme)]
        // A configured origin can be anything the person typed into a settings
        // field, so this is a real failure path, not a `!`.
        return components?.url ?? URL(string: "about:blank")!
    }

    /// What the app has already, or nil when this device has never paired.
    public func current() throws -> DevicePairing? { try store.load() }

    /// Sign in: open the Portal's pairing page, take the token it mints, keep it.
    ///
    /// `label` is what the person will see on the Portal's Devices page when
    /// they come to revoke it — the computer's name, normally.
    @discardableResult
    public func pair(label: String? = nil) async throws -> DevicePairing {
        var page = pairingPage
        if let label, !label.isEmpty,
           var components = URLComponents(url: page, resolvingAgainstBaseURL: false) {
            components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "label", value: label)]
            page = components.url ?? page
        }
        let callback = try await present(page, scheme)
        return try accept(callback)
    }

    /// Take a `<scheme>://connect?…` URL the app received by any route — the
    /// sign-in sheet, `application(_:open:)` after a cold launch, a scanned QR
    /// code — and keep it. Wrong-scheme and malformed links throw rather than
    /// overwrite a working pairing with nonsense.
    @discardableResult
    public func accept(_ callback: URL) throws -> DevicePairing {
        guard let pairing = ConnectLink.parse(scheme: scheme, callback.absoluteString) else {
            throw PairingError.malformedCallback(callback.absoluteString)
        }
        try store.save(pairing)
        return pairing
    }

    /// Sign out: tell the Portal to revoke this device, then forget the token.
    ///
    /// The Keychain is cleared whether or not the Portal could be reached — a
    /// person signing out on a plane means it, and a token they can no longer
    /// see is one they cannot revoke later either. `revoked` in the result says
    /// which of the two happened, so a UI can offer "revoke it from the Portal
    /// when you are next online" instead of implying it is already gone.
    @discardableResult
    public func signOut() async throws -> SignOutResult {
        let pairing = try store.load()
        var revoked = false
        var failure: (any Error)?
        if let pairing, let id = pairing.deviceId {
            do { try await revoke(pairing, id: id); revoked = true } catch { failure = error }
        }
        try store.forget()
        return SignOutResult(wasPaired: pairing != nil, revoked: revoked, revocationError: failure)
    }

    /// `DELETE <origin>/auth/devices/<id>`, authenticated with the device's own token.
    private func revoke(_ pairing: DevicePairing, id: String) async throws {
        let escaped = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        guard let url = URL(string: pairing.url + "/auth/devices/" + escaped) else {
            throw PairingError.malformedCallback(pairing.url)
        }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(pairing.token)", forHTTPHeaderField: "Authorization")
        // Signing out must not hang on a captive portal; the Keychain is
        // cleared regardless, so a short wait costs nothing.
        request.timeoutInterval = 10
        let (_, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        // 404 means the Portal has already forgotten it — the outcome we wanted.
        guard (200..<300).contains(status) || status == 404 else {
            throw PairingError.revocationRefused(status: status)
        }
    }

    static func trimOrigin(_ origin: String) -> String {
        var trimmed = origin.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        return trimmed
    }
}

/// What `signOut()` managed to do.
public struct SignOutResult: Sendable {
    /// False when the app was not paired to begin with — the menu item was stale.
    public let wasPaired: Bool
    /// True when the Portal confirmed the device is revoked.
    public let revoked: Bool
    /// Why revocation did not happen: offline, refused, or no device id in the link.
    public let revocationError: (any Error)?

    public init(wasPaired: Bool, revoked: Bool, revocationError: (any Error)? = nil) {
        self.wasPaired = wasPaired
        self.revoked = revoked
        self.revocationError = revocationError
    }
}

// MARK: - The pairing itself

/// One paired device's half of the deal: where the Portal is, and the token
/// that proves this device may talk to it.
public struct DevicePairing: Sendable, Equatable, Codable {
    /// The Portal's origin, `https://toolkit.example`, with no trailing slash.
    public var url: String
    /// The device token. A bearer credential: Keychain, never a file, never a log.
    public var token: String
    /// The Portal's id for this device, for `DELETE /auth/devices/<id>`.
    ///
    /// Optional because the connect link is older than runtime pairing: a link
    /// from a QR code pairing a phone to a desktop app on the LAN has no
    /// Portal and no device row behind it. Signing out without one still
    /// forgets the token locally; it just cannot revoke it remotely.
    public var deviceId: String?

    public init(url: String, token: String, deviceId: String? = nil) {
        self.url = url
        self.token = token
        self.deviceId = deviceId
    }

    /// The workspace URL to hand `HttpTransport`: `<origin>/w/<workspace>`.
    public func workspaceURL(for workspace: String) -> String { "\(url)/w/\(workspace)" }
}

/// The connect link, in Swift. The rules are `src/connectLink.ts`'s rules, and
/// they have to stay the same rules: one link format serves the Portal's
/// Devices page, a desktop app's QR code and every app that scans one.
public enum ConnectLink {
    /// Accepts `sysml` or `sysml:`, so callers need not remember which.
    private static func protocolOf(_ scheme: String) -> String {
        scheme.hasSuffix(":") ? scheme : scheme + ":"
    }

    public static func parse(scheme: String, _ raw: String) -> DevicePairing? {
        guard let parsed = URLComponents(string: raw), let parsedScheme = parsed.scheme else { return nil }
        // `sysml://connect?…` puts "connect" in the host; `sysml:connect?…`,
        // which some senders produce, puts it in the path.
        let action = parsed.host ?? String(parsed.path.drop(while: { $0 == "/" }))
        guard protocolOf(parsedScheme) == protocolOf(scheme), action == "connect" else { return nil }
        let items = parsed.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        var url = value("url") ?? ""
        while url.hasSuffix("/") { url.removeLast() }
        let token = value("token") ?? ""
        // A bare origin: scheme, host and optional port. A path or a query in
        // here would be a redirect someone smuggled into the link.
        guard url.wholeMatch(of: /https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?/) != nil, !token.isEmpty else { return nil }
        let deviceId = value("device").flatMap { $0.isEmpty ? nil : $0 }
        return DevicePairing(url: url, token: token, deviceId: deviceId)
    }

    public static func build(scheme: String, origin: String, token: String, deviceId: String? = nil) -> String {
        var components = URLComponents()
        components.scheme = protocolOf(scheme).replacingOccurrences(of: ":", with: "")
        components.host = "connect"
        components.queryItems = [URLQueryItem(name: "url", value: PairingFlow.trimOrigin(origin)),
                                 URLQueryItem(name: "token", value: token)]
        if let deviceId { components.queryItems?.append(URLQueryItem(name: "device", value: deviceId)) }
        return components.url?.absoluteString ?? ""
    }
}

public enum PairingError: LocalizedError, Equatable {
    /// The redirect was not a connect link for this app's scheme.
    case malformedCallback(String)
    /// The person closed the sign-in sheet.
    case cancelled
    /// The sign-in sheet could not be shown at all.
    case cannotPresent(String)
    case revocationRefused(status: Int)
    case keychain(status: Int32)

    public var errorDescription: String? {
        switch self {
        case .malformedCallback(let raw): "pairing did not return a usable connect link (\(raw))"
        case .cancelled: "pairing was cancelled"
        case .cannotPresent(let why): "the sign-in sheet could not be shown: \(why)"
        case .revocationRefused(let status): "the Portal refused to revoke this device: HTTP \(status)"
        case .keychain(let status): "the Keychain refused the pairing: OSStatus \(status)"
        }
    }
}

// MARK: - Storage

/// Where a pairing lives between launches. One implementation ships here; a
/// test or a CLI that wants a file supplies its own.
public protocol PairingStore: Sendable {
    func load() throws -> DevicePairing?
    func save(_ pairing: DevicePairing) throws
    func forget() throws
}

#if canImport(Security)
/// The Keychain, one generic-password item per app.
///
/// URL and token go in together as one JSON payload rather than two items: a
/// token pointing at the wrong origin is worse than no token, and two items
/// can be half-written or half-deleted. The item is `ThisDeviceOnly` — a
/// device token identifies *this* device to the Portal, so following it into
/// an iCloud backup and out onto a restored machine would hand a second
/// machine the first one's identity.
public struct KeychainPairingStore: PairingStore {
    public let service: String
    public let account: String

    public init(service: String, account: String = "pairing") {
        self.service = service
        self.account = account
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    public func load() throws -> DevicePairing? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw PairingError.keychain(status: status) }
        // An item written by an older build, or by something else under the
        // same name, reads as "not paired" rather than as a crash.
        return try? JSONDecoder().decode(DevicePairing.self, from: data)
    }

    public func save(_ pairing: DevicePairing) throws {
        let data = try JSONEncoder().encode(pairing)
        let update: [String: Any] = [kSecValueData as String: data,
                                     kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let updated = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw PairingError.keychain(status: updated) }
        let added = SecItemAdd(query.merging(update) { $1 } as CFDictionary, nil)
        guard added == errSecSuccess else { throw PairingError.keychain(status: added) }
    }

    public func forget() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw PairingError.keychain(status: status)
        }
    }
}
#endif

/// For tests and for a CLI run with `--no-keychain`.
public final class MemoryPairingStore: PairingStore, @unchecked Sendable {
    private let lock = NSLock()
    private var pairing: DevicePairing?

    public init(_ pairing: DevicePairing? = nil) { self.pairing = pairing }

    public func load() throws -> DevicePairing? { lock.withLock { pairing } }
    public func save(_ pairing: DevicePairing) throws { lock.withLock { self.pairing = pairing } }
    public func forget() throws { lock.withLock { pairing = nil } }
}

// MARK: - The sign-in sheet

#if canImport(AuthenticationServices) && (os(macOS) || os(iOS))
extension PairingFlow {
    /// The real thing: Safari's sandbox, Safari's cookies, no browser window.
    @Sendable
    static func webAuthentication(page: URL, scheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            Task { @MainActor in
                let session = ASWebAuthenticationSession(url: page, callbackURLScheme: scheme) { callback, error in
                    if let callback {
                        continuation.resume(returning: callback)
                    } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                        continuation.resume(throwing: PairingError.cancelled)
                    } else {
                        continuation.resume(throwing: error ?? PairingError.cancelled)
                    }
                }
                let anchor = PairingAnchor()
                session.presentationContextProvider = anchor
                // Shared, not ephemeral: the point of the sheet is that a
                // person already signed in to Google in Safari signs in here
                // with one tap instead of typing a password again.
                session.prefersEphemeralWebBrowserSession = false
                // The anchor has to outlive this scope or the sheet has nobody
                // to hang from; the session holds it weakly.
                objc_setAssociatedObject(session, &PairingAnchor.key, anchor, .OBJC_ASSOCIATION_RETAIN)
                guard session.start() else {
                    continuation.resume(throwing: PairingError.cannotPresent("no window to present from"))
                    return
                }
            }
        }
    }
}

/// `ASWebAuthenticationSession` insists on being told which window to hang the
/// sheet from. The front window is the right answer in a document app and the
/// only answer in a single-window one.
@MainActor
private final class PairingAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
    nonisolated(unsafe) static var key: UInt8 = 0

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if os(macOS)
        return NSApplication.shared.keyWindow ?? NSApplication.shared.windows.first ?? ASPresentationAnchor()
        #else
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let windows = scenes.flatMap(\.windows)
        return windows.first { $0.isKeyWindow } ?? windows.first ?? ASPresentationAnchor()
        #endif
    }
}

#else
extension PairingFlow {
    @Sendable
    static func webAuthentication(page: URL, scheme: String) async throws -> URL {
        throw PairingError.cannotPresent("this platform has no ASWebAuthenticationSession")
    }
}
#endif
