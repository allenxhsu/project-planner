import AppKit

@main
enum ProjectPlannerApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.mainMenu = MainMenu.build()
        app.run()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }
}

/// The menu bar. Document commands (New, Open, Save, Revert, Close) are
/// AppKit's own; everything about the model is a web command id that the
/// front window's `EditorWindowController.runWebCommand` hands to the page —
/// the same ids the web app's own menu bar runs (`COMMANDS` in src/ui/toolbar.js).
enum MainMenu {
    static func build() -> NSMenu {
        let main = NSMenu()
        main.addItem(submenu("Project Planner", [
            item("About Project Planner", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            web("Appearance…", "view.appearance", ","),
            .separator(),
            item("Hide Project Planner", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit Project Planner", #selector(NSApplication.terminate(_:)), "q"),
        ]))
        main.addItem(submenu("File", [
            item("New", #selector(NSDocumentController.newDocument(_:)), "n"),
            item("Open…", #selector(NSDocumentController.openDocument(_:)), "o"),
            recentMenu(),
            web("Open the Sample Plan", "file.sample"),
            .separator(),
            item("Close", #selector(NSWindow.performClose(_:)), "w"),
            item("Save…", #selector(NSDocument.save(_:)), "s"),
            item("Save As…", #selector(NSDocument.saveAs(_:)), "s", [.command, .shift]),
            item("Revert to Saved", #selector(NSDocument.revertToSaved(_:))),
            .separator(),
            item("Import Microsoft Project XML or CSV…", #selector(NSDocumentController.openDocument(_:)), "i", [.command, .shift]),
            submenuItem("Export", [
                web("Microsoft Project XML…", "file.exportXml"),
                web("Task List as CSV…", "file.exportCsv"),
                .separator(),
                web("Gantt Chart as SVG…", "export.svg"),
                web("Gantt Chart as PNG…", "export.png"),
                web("Gantt Chart as PDF…", "export.pdf", "e", [.command, .shift]),
            ]),
        ]))
        main.addItem(submenu("Edit", [
            web("Undo", "edit.undo", "z"),
            web("Redo", "edit.redo", "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            web("Select All Tasks", "edit.selectAll", "a"),
            .separator(),
            // No key equivalent: the page handles Delete itself, and a menu
            // shortcut would take the key away from text fields.
            web("Delete", "edit.delete"),
        ]))
        main.addItem(submenu("Task", [
            web("Task Information…", "task.info", "i"),
            .separator(),
            web("New Task Below", "task.new"),
            web("New Task Above", "task.newAbove"),
            web("New Milestone", "task.milestone"),
            .separator(),
            web("Indent", "task.indent"),
            web("Outdent", "task.outdent"),
            web("Move Up", "task.up"),
            web("Move Down", "task.down"),
            .separator(),
            web("Link Selected Tasks", "task.link", "l"),
            web("Unlink Selected Tasks", "task.unlink", "l", [.command, .shift]),
            .separator(),
            web("Toggle Milestone", "task.toggleMilestone"),
            web("Mark 100% Complete", "task.complete"),
        ]))
        main.addItem(submenu("Resource", [
            web("Resource Information…", "resource.info"),
            .separator(),
            web("New Resource", "resource.new"),
            web("Delete Resource", "resource.delete"),
        ]))
        main.addItem(submenu("View", [
            web("Gantt Chart", "view.gantt", "1"),
            web("Task Sheet", "view.sheet", "2"),
            web("Resource Sheet", "view.resources", "3"),
            web("Resource Usage", "view.usage", "4"),
            web("Network Diagram", "view.network", "5"),
            .separator(),
            web("Zoom In", "view.zoomIn", "+"),
            web("Zoom Out", "view.zoomOut", "-"),
            web("Go to Today", "view.today", "0"),
            .separator(),
            web("Expand All", "view.expandAll"),
            web("Collapse All", "view.collapseAll"),
            .separator(),
            web("Details Panel", "view.inspector"),
            web("Checks Panel", "view.checks"),
            .separator(),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ]))
        main.addItem(submenu("Project", [
            web("Project Information & Working Time…", "project.info"),
            web("Statistics", "project.stats"),
        ]))
        let window = submenu("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
            .separator(),
            item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))),
        ])
        main.addItem(window)
        NSApplication.shared.windowsMenu = window.submenu
        let help = submenu("Help", [web("Working with the Planner", "help.guide", "?")])
        main.addItem(help)
        NSApplication.shared.helpMenu = help.submenu
        return main
    }

    /// Every web command id the menu bar can send, for the test that checks them against the page.
    static func webCommandIDs(in menu: NSMenu = build()) -> [String] {
        menu.items.flatMap { item -> [String] in
            var ids = item.submenu.map { webCommandIDs(in: $0) } ?? []
            if item.action == #selector(EditorWindowController.runWebCommand(_:)), let id = item.representedObject as? String { ids.append(id) }
            return ids
        }
    }

    private static func item(_ title: String, _ action: Selector, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
        let it = NSMenuItem(title: title, action: action, keyEquivalent: key)
        it.keyEquivalentModifierMask = mods
        return it
    }

    private static func web(_ title: String, _ id: String, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
        let it = item(title, #selector(EditorWindowController.runWebCommand(_:)), key, mods)
        it.representedObject = id
        return it
    }

    private static func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
        let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let menu = NSMenu(title: title)
        items.forEach(menu.addItem)
        holder.submenu = menu
        return holder
    }
    private static func submenuItem(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem { submenu(title, items) }

    private static func recentMenu() -> NSMenuItem {
        let holder = NSMenuItem(title: "Open Recent", action: nil, keyEquivalent: "")
        let menu = NSMenu(title: "Open Recent")
        // AppKit fills a menu with this private-but-stable name from the recent documents list.
        let setName = NSSelectorFromString("_setMenuName:")
        if menu.responds(to: setName) { menu.perform(setName, with: "NSRecentDocumentsMenu") }
        menu.addItem(item("Clear Menu", #selector(NSDocumentController.clearRecentDocuments(_:))))
        holder.submenu = menu
        return holder
    }
}
