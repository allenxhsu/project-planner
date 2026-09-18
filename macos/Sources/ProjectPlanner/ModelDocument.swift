import AppKit
import UniformTypeIdentifiers

/// One plan, one window. The page in the window holds the live plan and
/// posts its JSON after every edit, so the document always has the bytes to
/// write without asking the page and waiting.
final class ModelDocument: NSDocument {
    static let jsonType = UTType.json.identifier
    static let fileSuffix = ".project.json"

    /// Text read from disk that the page has not been given yet.
    private(set) var pendingText: String?
    private(set) var pendingName: String?
    /// The plan as the page last reported it.
    private var latestJSON: String?
    /// Microsoft Project XML and CSV come in as a new plan: they are never written back over.
    private var cameFromImport = false
    private var modelName = "Untitled project"

    override class var autosavesInPlace: Bool { false }
    static let projectFileType = "org.projectplanner.mpp"
    static let otherPlanType = "org.projectplanner.plan-import"
    override class var readableTypes: [String] { [jsonType, UTType.xml.identifier, UTType.commaSeparatedText.identifier, projectFileType, otherPlanType] }
    override class var writableTypes: [String] { [jsonType] }
    override class func isNativeType(_ type: String) -> Bool { type == jsonType }

    private var editor: EditorWindowController? { windowControllers.first as? EditorWindowController }

    override func makeWindowControllers() {
        addWindowController(EditorWindowController())
    }

    // MARK: Reading

    override func read(from data: Data, ofType typeName: String) throws {
        let name = fileURL?.lastPathComponent
        // A Microsoft Project file (or another planner's): MPXJ turns it into Project XML first.
        if Converter.handles(fileURL) || Converter.looksLikeOLE(data) {
            let xml = try Converter.convert(data, from: fileURL?.pathExtension.lowercased() ?? "mpp", to: "xml")
            guard let text = String(data: xml, encoding: .utf8) else { throw CocoaError(.fileReadInapplicableStringEncoding) }
            pendingText = text
            pendingName = (name as NSString?)?.deletingPathExtension.appending(".xml") ?? "plan.xml"
            cameFromImport = true
            editor?.deliverPendingText()
            return
        }
        guard let text = String(data: data, encoding: .utf8) else {
            throw CocoaError(.fileReadInapplicableStringEncoding)
        }
        pendingText = text
        pendingName = name
        cameFromImport = Self.looksLikeXML(text) || Self.looksLikeCSV(text, name: pendingName)
        // Revert: the window already exists, so hand the text over now.
        editor?.deliverPendingText()
    }

    static func looksLikeXML(_ text: String) -> Bool {
        text.drop(while: { $0.isWhitespace || $0 == "\u{FEFF}" }).hasPrefix("<")
    }

    /// A CSV is anything that is neither XML nor a JSON object.
    static func looksLikeCSV(_ text: String, name: String?) -> Bool {
        if name?.lowercased().hasSuffix(".csv") == true { return true }
        let body = text.drop(while: { $0.isWhitespace || $0 == "\u{FEFF}" })
        return !body.hasPrefix("<") && !body.hasPrefix("{")
    }

    /// The page took the text. An imported model becomes an unsaved, untitled document.
    func didDeliverPendingText() {
        pendingText = nil
        pendingName = nil
        guard cameFromImport else { return }
        cameFromImport = false
        fileURL = nil
        fileType = Self.jsonType
        updateChangeCount(.changeDone)
    }

    // MARK: Changes from the page

    func pageDidChange(json: String, dirty: Bool, name: String) {
        latestJSON = json
        modelName = name
        if dirty { updateChangeCount(.changeDone) }
    }

    // MARK: Writing

    override func data(ofType typeName: String) throws -> Data {
        guard let json = latestJSON else {
            throw CocoaError(.fileWriteUnknown, userInfo: [NSLocalizedDescriptionKey: "The plan has not finished loading yet. Try again in a moment."])
        }
        return Data(json.utf8)
    }

    override func prepareSavePanel(_ panel: NSSavePanel) -> Bool {
        panel.allowedContentTypes = [.json]
        panel.isExtensionHidden = false
        panel.nameFieldStringValue = Self.fileName(forModelNamed: modelName)
        return true
    }

    /// "Website relaunch" → "website-relaunch.project.json", the name the web app gives its downloads.
    static func fileName(forModelNamed name: String) -> String {
        let slug = name.lowercased().unicodeScalars
            .map { CharacterSet.alphanumerics.contains($0) && $0.isASCII ? String($0) : "-" }.joined()
            .split(separator: "-", omittingEmptySubsequences: true).joined(separator: "-")
        return (slug.isEmpty ? "untitled" : slug) + fileSuffix
    }

    override func save(to url: URL, ofType typeName: String, for operation: NSDocument.SaveOperationType,
                       completionHandler: @escaping (Error?) -> Void) {
        super.save(to: url, ofType: typeName, for: operation) { [weak self] error in
            if error == nil, operation != .autosaveElsewhereOperation {
                self?.editor?.documentWasSaved(as: url.lastPathComponent)
            }
            completionHandler(error)
        }
    }
}
