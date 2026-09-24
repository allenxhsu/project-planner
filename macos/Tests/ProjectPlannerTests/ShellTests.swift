import XCTest
import ToolkitShell
@testable import ProjectPlanner

/// What is left to test here is what is left in this target: the menu table,
/// the document's own rules about Microsoft Project files, and the converter.
/// The shell itself (path guard, MIME table, save panel, PDF) is covered by
/// shell-kit's own tests.
final class ShellTests: XCTestCase {
    override func setUp() { ShellConfig.current = PlannerApp.config }

    /// A menu item whose id the page does not know would do nothing, silently.
    func testEveryMenuCommandExistsInThePage() throws {
        let source = try String(contentsOf: PlannerApp.repositoryRoot.appendingPathComponent("src/ui/toolbar.js"), encoding: .utf8)
        let known = ShellMenu.commandIDs(inJavaScript: source)
        XCTAssertFalse(known.isEmpty)
        let sent = ShellMenu.webCommandIDs(in: MainMenu.build())
        XCTAssertFalse(sent.isEmpty)
        for id in sent { XCTAssertTrue(known.contains(id), "the page has no command “\(id)”") }
    }

    func testTheKitServesThisRepositoryAndNamesSavedPlans() {
        let index = WebRoot.file(for: URL(string: "project-app://app/")!, under: PlannerApp.repositoryRoot)
        XCTAssertTrue(FileManager.default.fileExists(atPath: index!.path))
        XCTAssertEqual(WebDocument.fileName(forModelNamed: "Website relaunch"), "website-relaunch.project.json")
        XCTAssertEqual(WebDocument.fileName(forModelNamed: "  Pump / v2 (draft) "), "pump-v2-draft.project.json")
        XCTAssertEqual(WebDocument.fileName(forModelNamed: "…"), "untitled.project.json")
    }

    /// Only `.project.json` is written back over; everything else opens as a new plan.
    func testImportsAreToldFromJSON() {
        XCTAssertTrue(WebDocument.looksLikeXML("\u{FEFF}\n <?xml version=\"1.0\"?><Project/>"))
        XCTAssertFalse(WebDocument.looksLikeXML("  {\"format\":\"project-planner\"}"))
        XCTAssertTrue(ModelDocument.looksLikeCSV("Name,Duration\nPlan,3d", name: nil))
        XCTAssertTrue(ModelDocument.looksLikeCSV("{\"x\":1}", name: "tasks.csv"))
        XCTAssertFalse(ModelDocument.looksLikeCSV("  {\"format\":\"project-planner\"}", name: "plan.project.json"))
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
        let mpp = try Data(contentsOf: PlannerApp.repositoryRoot.appendingPathComponent("tests/fixtures/baseline-project2010.mpp"))
        let xml = try Converter.convert(mpp, from: "mpp", to: "xml")
        let text = try XCTUnwrap(String(data: xml, encoding: .utf8))
        XCTAssertTrue(text.contains("<Project xmlns=\"http://schemas.microsoft.com/project\">"))
        XCTAssertTrue(text.contains("<Name>Subtask 1</Name>"))
    }
}
