import AppKit
import WebKit
import UniformTypeIdentifiers

/// A document window: a web view showing the planner, and the message channel
/// between the page and the document. `src/host.js` is the page's half.
final class EditorWindowController: NSWindowController, WKScriptMessageHandler, WKNavigationDelegate {
    private var webView: WKWebView!
    private var pageReady = false
    private var pdfExporter: PDFExporter?

    private var model: ModelDocument? { document as? ModelDocument }

    init() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.minSize = NSSize(width: 1100, height: 640)
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(red: 0.04, green: 0.06, blue: 0.09, alpha: 1)
        window.tabbingMode = .preferred
        window.setFrameAutosaveName("ProjectEditor")
        window.center()
        super.init(window: window)
        shouldCascadeWindows = true

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: WebRoot.scheme)
        config.userContentController.add(WeakMessageHandler(self), name: "project")
        // Page errors would otherwise vanish; send them to the app's log.
        config.userContentController.addUserScript(WKUserScript(source: """
            window.addEventListener('error', (e) => webkit.messageHandlers.project.postMessage({ type: 'log', text: String(e.message) + ' @ ' + e.filename + ':' + e.lineno }));
            window.addEventListener('unhandledrejection', (e) => webkit.messageHandlers.project.postMessage({ type: 'log', text: 'unhandled: ' + String(e.reason) }));
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        webView = WKWebView(frame: window.contentLayoutRect, configuration: config)
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = false
        webView.setValue(false, forKey: "drawsBackground")
        #if DEBUG
        webView.isInspectable = true
        #endif
        window.contentView = webView
        window.initialFirstResponder = webView
        webView.load(URLRequest(url: WebRoot.indexURL))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    // MARK: Page → app

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            pageReady = true
            deliverPendingText()
        case "changed":
            if let json = body["json"] as? String {
                model?.pageDidChange(json: json, dirty: body["dirty"] as? Bool ?? false, name: body["name"] as? String ?? "Untitled project")
            }
        case "saveFile":
            if let name = body["name"] as? String, let base64 = body["base64"] as? String, let data = Data(base64Encoded: base64) {
                saveExport(data, suggestedName: name)
            }
        case "pdf":
            exportPDF(body)
        case "convertExport":
            // Our Project XML → MPX / XER / PMXML / Planner through MPXJ, then a save panel.
            if let name = body["name"] as? String, let xml = body["xml"] as? String {
                let ext = (name as NSString).pathExtension.lowercased()
                do {
                    let data = try Converter.convert(Data(xml.utf8), from: "xml", to: ext.isEmpty ? "mpx" : ext)
                    saveExport(data, suggestedName: name)
                } catch {
                    if let window { NSAlert(error: error).beginSheetModal(for: window) }
                }
            }
        case "new": NSDocumentController.shared.newDocument(nil)
        case "open": NSDocumentController.shared.openDocument(nil)
        case "save": model?.save(nil)
        case "log": NSLog("Project Planner page: %@", body["text"] as? String ?? "")
        default: break
        }
    }

    // MARK: App → page

    /// Give the page the text the document read, once both exist.
    func deliverPendingText() {
        guard pageReady, let model, let text = model.pendingText else { return }
        let name = model.pendingName ?? ""
        webView.callAsyncJavaScript("return window.projectHost.load(text, name)", arguments: ["text": text, "name": name],
                                    in: nil, in: .page) { [weak model] _ in
            model?.didDeliverPendingText()
        }
    }

    func documentWasSaved(as fileName: String) {
        webView.callAsyncJavaScript("window.projectHost.saved(name)", arguments: ["name": fileName], in: nil, in: .page) { _ in }
    }

    /// Menu items carry a web command id as their represented object.
    @objc func runWebCommand(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        window?.makeFirstResponder(webView)
        webView.callAsyncJavaScript("window.projectHost.command(id)", arguments: ["id": id], in: nil, in: .page) { _ in }
    }

    @objc func validateMenuItem(_ item: NSMenuItem) -> Bool {
        item.action == #selector(runWebCommand(_:)) ? pageReady : true
    }

    // MARK: Exports

    private func saveExport(_ data: Data, suggestedName: String) {
        guard let window else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedName
        if let type = UTType(filenameExtension: (suggestedName as NSString).pathExtension) { panel.allowedContentTypes = [type] }
        panel.isExtensionHidden = false
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url else { return }
            do { try data.write(to: url, options: .atomic) } catch { NSAlert(error: error).beginSheetModal(for: window) }
        }
    }

    private func exportPDF(_ body: [String: Any]) {
        let pages = (body["pages"] as? [[String: Any]] ?? []).compactMap { page -> PDFExporter.Page? in
            guard let svg = page["svg"] as? String, let w = page["w"] as? Double, let h = page["h"] as? Double else { return nil }
            return PDFExporter.Page(svg: svg, size: CGSize(width: w, height: h))
        }
        guard !pages.isEmpty else { return }
        let name = body["name"] as? String ?? "gantt.pdf"
        let exporter = PDFExporter(pages: pages)
        pdfExporter = exporter
        exporter.run { [weak self] data in
            self?.pdfExporter = nil
            if let data { self?.saveExport(data, suggestedName: name) }
        }
    }

    // MARK: Navigation

    /// The window shows the planner and nothing else; a link out opens in the browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if url.scheme == WebRoot.scheme || url.scheme == "about" { decisionHandler(.allow); return }
        if url.scheme == "http" || url.scheme == "https" { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("Project Planner page failed to load: %@", error.localizedDescription)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        NSLog("Project Planner page failed to load: %@", error.localizedDescription)
    }
}

/// `WKUserContentController` retains its handlers; this keeps the window controller out of that cycle.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
