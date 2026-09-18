import AppKit
import WebKit
import PDFKit

/// Turns exported SVG diagrams into one vector PDF, a page per diagram, each
/// page exactly the size of its diagram. WebKit draws the SVG, so the PDF
/// matches the SVG export line for line.
final class PDFExporter: NSObject, WKNavigationDelegate {
    struct Page {
        let svg: String
        let size: CGSize
    }

    private var remaining: [Page]
    private let output = PDFDocument()
    private var webView: WKWebView?
    private var completion: ((Data?) -> Void)?

    init(pages: [Page]) { remaining = pages }

    func run(completion: @escaping (Data?) -> Void) {
        self.completion = completion
        renderNext()
    }

    private func renderNext() {
        guard let page = remaining.first else {
            completion?(output.pageCount > 0 ? output.dataRepresentation() : nil)
            completion = nil
            webView = nil
            return
        }
        let view = WKWebView(frame: CGRect(origin: .zero, size: page.size))
        view.navigationDelegate = self
        webView = view
        let html = """
            <!doctype html><html><head><meta charset="utf-8">
            <style>html,body{margin:0;background:#fff}svg{display:block;width:\(page.size.width)px;height:\(page.size.height)px}</style>
            </head><body>\(page.svg)</body></html>
            """
        view.loadHTMLString(html, baseURL: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let page = remaining.removeFirst()
        let config = WKPDFConfiguration()
        config.rect = CGRect(origin: .zero, size: page.size)
        webView.createPDF(configuration: config) { [weak self] result in
            guard let self else { return }
            if case .success(let data) = result, let doc = PDFDocument(data: data), let first = doc.page(at: 0) {
                self.output.insert(first, at: self.output.pageCount)
            }
            self.renderNext()
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        remaining.removeFirst()
        renderNext()
    }
}
