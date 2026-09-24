import AppKit
import ToolkitShell

/// The whole app: ToolkitShell's shell around the web app in ../../../src,
/// configured for Project Planner. What is left here is what no other app in
/// the suite has — Microsoft Project files, which MPXJ converts on the way in
/// and on the way out (Converter.swift).

/// A plan. `.project.json` is the only thing ever written; everything else
/// MPXJ can read opens as an untitled, unsaved plan.
final class ModelDocument: WebDocument {
    override func makeWindowControllers() {
        addWindowController(PlannerWindowController())
    }

    override func read(from data: Data, ofType typeName: String) throws {
        // A Microsoft Project file (or another planner's) is not text at all:
        // MPXJ turns it into Project XML, which the page knows how to import.
        if Converter.handles(fileURL) || Converter.looksLikeOLE(data) {
            let xml = try Converter.convert(data, from: fileURL?.pathExtension.lowercased() ?? "mpp", to: "xml")
            guard let text = String(data: xml, encoding: .utf8) else { throw CocoaError(.fileReadInapplicableStringEncoding) }
            let stem = (fileURL?.lastPathComponent as NSString?)?.deletingPathExtension
            deliver(text: text, name: stem.map { "\($0).xml" } ?? "plan.xml", imported: true)
            return
        }
        try super.read(from: data, ofType: typeName)
    }

    /// Project XML and a CSV task list are both imports; only `.project.json` is native.
    override func isImport(text: String, name: String?) -> Bool {
        Self.looksLikeXML(text) || Self.looksLikeCSV(text, name: name)
    }

    /// A CSV is anything that is neither XML nor a JSON object.
    static func looksLikeCSV(_ text: String, name: String?) -> Bool {
        if name?.lowercased().hasSuffix(".csv") == true { return true }
        let body = text.drop(while: { $0.isWhitespace || $0 == "\u{FEFF}" })
        return !body.hasPrefix("<") && !body.hasPrefix("{")
    }
}

/// The document window, plus the one message the kit does not know: an export
/// the page cannot write itself, because only MPXJ can.
final class PlannerWindowController: EditorWindowController {
    override func handleMessage(type: String, body: [String: Any]) -> Bool {
        guard type == "convertExport" else { return false }
        // Our Project XML → MPX / XER / PMXML / Planner through MPXJ, then a save panel.
        if let name = body["name"] as? String, let xml = body["xml"] as? String {
            let ext = (name as NSString).pathExtension.lowercased()
            do {
                let data = try Converter.convert(Data(xml.utf8), from: "xml", to: ext.isEmpty ? "mpx" : ext)
                saveExport(data, suggestedName: name)
            } catch {
                // Not the kit's presentError: NSResponder has one of its own, and
                // the two names are ambiguous at the call site.
                if let window { NSAlert(error: error).beginSheetModal(for: window) }
            }
        }
        return true
    }
}

enum PlannerApp {
    /// …/macos/Sources/ProjectPlanner/App.swift → the repository root.
    static let repositoryRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    static let config = ShellConfig(
        appName: "Project Planner", handlerName: "project", scheme: "project-app", fileSuffix: ".project.json",
        documentNoun: "plan",
        importedTypes: ["public.xml", "public.comma-separated-values-text", "org.projectplanner.mpp", "org.projectplanner.plan-import"],
        defaultPDFName: "gantt.pdf", repositoryRoot: repositoryRoot,
        minimumWindowSize: CGSize(width: 1100, height: 640), windowFrameAutosaveName: "ProjectEditor")
}

@main
enum ProjectPlannerApp {
    static func main() {
        ShellApp.run(config: PlannerApp.config) { MainMenu.build() }
    }
}
