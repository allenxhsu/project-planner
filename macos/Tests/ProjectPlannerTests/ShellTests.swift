import XCTest
@testable import ProjectPlanner

final class ShellTests: XCTestCase {
    /// The repository root, from …/macos/Tests/ProjectPlannerTests/ShellTests.swift.
    private var repo: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
    }

    /// A menu item whose id the page does not know would do nothing, silently.
    func testEveryMenuCommandExistsInThePage() throws {
        let source = try String(contentsOf: repo.appendingPathComponent("src/ui/toolbar.js"), encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "export const COMMANDS = {"))
        let end = try XCTUnwrap(source.range(of: "};", range: start.upperBound..<source.endIndex))
        let table = String(source[start.upperBound..<end.lowerBound])
        let known = Set(table.matches(of: #/'([a-z]+\.[A-Za-z]+)':/#).map { String($0.1) })
        XCTAssertFalse(known.isEmpty)
        let sent = MainMenu.webCommandIDs()
        XCTAssertFalse(sent.isEmpty)
        for id in sent { XCTAssertTrue(known.contains(id), "the page has no command “\(id)”") }
    }

    func testSaveNameMatchesTheWebApp() {
        XCTAssertEqual(ModelDocument.fileName(forModelNamed: "Website relaunch"), "website-relaunch.project.json")
        XCTAssertEqual(ModelDocument.fileName(forModelNamed: "  Pump / v2 (draft) "), "pump-v2-draft.project.json")
        XCTAssertEqual(ModelDocument.fileName(forModelNamed: "…"), "untitled.project.json")
    }

    func testImportsAreToldFromJSON() {
        XCTAssertTrue(ModelDocument.looksLikeXML("\u{FEFF}\n <?xml version=\"1.0\"?><xmi:XMI/>"))
        XCTAssertFalse(ModelDocument.looksLikeXML("  {\"format\":\"project-planner\"}"))
        XCTAssertTrue(ModelDocument.looksLikeCSV("Name,Duration\nPlan,3d", name: nil))
        XCTAssertTrue(ModelDocument.looksLikeCSV("{\"x\":1}", name: "tasks.csv"))
        XCTAssertFalse(ModelDocument.looksLikeCSV("  {\"format\":\"project-planner\"}", name: "plan.project.json"))
    }

    func testTheSchemeServesOnlyTheWebRoot() throws {
        let root = repo
        let index = try XCTUnwrap(WebRoot.file(for: URL(string: "project-app://app/")!, under: root))
        XCTAssertEqual(index.lastPathComponent, "index.html")
        XCTAssertTrue(FileManager.default.fileExists(atPath: index.path))
        XCTAssertNotNil(WebRoot.file(for: URL(string: "project-app://app/src/main.js")!, under: root))
        XCTAssertNil(WebRoot.file(for: URL(string: "project-app://app/../IDEF0/index.html")!, under: root))
        XCTAssertNil(WebRoot.file(for: URL(string: "project-app://app/src/../../secret")!, under: root))
    }

    func testConverterRecognisesProjectFiles() {
        XCTAssertTrue(Converter.handles(URL(fileURLWithPath: "/x/plan.MPP")))
        XCTAssertTrue(Converter.handles(URL(fileURLWithPath: "/x/plan.xer")))
        XCTAssertFalse(Converter.handles(URL(fileURLWithPath: "/x/plan.project.json")))
        XCTAssertFalse(Converter.handles(URL(fileURLWithPath: "/x/plan.xml")))
        XCTAssertTrue(Converter.looksLikeOLE(Data([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0, 0])))
        XCTAssertFalse(Converter.looksLikeOLE(Data("{}".utf8)))
    }

    /// With the converter fetched (tools/setup-converter.sh), a real .mpp turns into Project XML.
    func testConverterReadsAnMPP() throws {
        try XCTSkipUnless(Converter.isAvailable, "run tools/setup-converter.sh first")
        let mpp = try Data(contentsOf: repo.appendingPathComponent("tests/fixtures/baseline-project2010.mpp"))
        let xml = try Converter.convert(mpp, from: "mpp", to: "xml")
        let text = try XCTUnwrap(String(data: xml, encoding: .utf8))
        XCTAssertTrue(text.contains("<Project xmlns=\"http://schemas.microsoft.com/project\">"))
        XCTAssertTrue(text.contains("<Name>Subtask 1</Name>"))
    }

    func testModulesGetAJavaScriptType() {
        XCTAssertEqual(WebRoot.mimeType(for: URL(fileURLWithPath: "/x/main.js")), "text/javascript")
        XCTAssertEqual(WebRoot.mimeType(for: URL(fileURLWithPath: "/x/kit.css")), "text/css")
        XCTAssertEqual(WebRoot.mimeType(for: URL(fileURLWithPath: "/x/exo.woff2")), "font/woff2")
    }
}
