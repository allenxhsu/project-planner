import Foundation
import WebKit
import UniformTypeIdentifiers

/// Where the web app's files are, and the custom scheme that serves them.
///
/// ES modules will not load from `file://`, so the page is served from
/// `project-app://app/…` instead: a real origin, which also gives the page its
/// own `localStorage` (where the shared appearance preference lives).
enum WebRoot {
    static let scheme = "project-app"
    static let indexURL = URL(string: "\(scheme)://app/index.html")!

    /// The bundled copy in a built app; the repository itself under `swift run` and `swift test`.
    static let directory: URL = {
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("web"),
           FileManager.default.fileExists(atPath: bundled.appendingPathComponent("index.html").path) {
            return bundled
        }
        // …/macos/Sources/ProjectPlanner/WebRoot.swift → the repository root
        return URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
    }()

    /// The file a request names, or nil when it points outside the web root.
    static func file(for url: URL, under root: URL = directory) -> URL? {
        let path = url.path.isEmpty || url.path == "/" ? "/index.html" : url.path
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        let base = root.standardizedFileURL.path
        guard file.path == base || file.path.hasPrefix(base.hasSuffix("/") ? base : base + "/") else { return nil }
        return file
    }

    static func mimeType(for file: URL) -> String {
        switch file.pathExtension.lowercased() {
        case "js", "mjs": return "text/javascript"
        case "css": return "text/css"
        case "html": return "text/html"
        case "json": return "application/json"
        case "svg": return "image/svg+xml"
        case "woff2": return "font/woff2"
        default: return UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}

final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, let file = WebRoot.file(for: url),
              let data = try? Data(contentsOf: file) else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": WebRoot.mimeType(for: file) + (file.pathExtension == "woff2" ? "" : "; charset=utf-8"),
            "Content-Length": String(data.count),
            "Cache-Control": "no-store",
        ])!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
