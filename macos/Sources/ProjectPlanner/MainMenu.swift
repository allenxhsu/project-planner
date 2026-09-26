import AppKit
import ToolkitShell

/// The menu table. Every `web` item is a command id from `COMMANDS` in
/// src/ui/toolbar.js — the same table the web app's own menu bar runs, checked
/// against it by ShellTests.
enum MainMenu {
    static func build() -> NSMenu {
        ShellMenu.mainMenu(
            appMenuExtras: [
                ShellMenu.web("Appearance…", "view.appearance", ","),
                ShellMenu.web("Sync…", "view.sync"),
            ],
            menus: [
                ShellMenu.submenu("File", ShellMenu.documentItems() + [
                    ShellMenu.web("New Project…", "file.newProject", "n", [.command, .shift]),
                    ShellMenu.web("Open the Sample Plan", "file.sample"),
                    .separator(),
                ] + [
                    ShellMenu.item("Close", #selector(NSWindow.performClose(_:)), "w"),
                    // Save is the cloud, as it is in the browser; Save As… is
                    // AppKit's, and writes the file this document came from.
                    ShellMenu.web("Save to the Cloud", "file.save", "s"),
                    ShellMenu.item("Save As…", #selector(NSDocument.saveAs(_:)), "s", [.command, .shift]),
                    ShellMenu.item("Revert to Saved", #selector(NSDocument.revertToSaved(_:))),
                ] + [
                    .separator(),
                    ShellMenu.web("Import from Motion (Export ZIP)…", "file.importMotion"),
                    ShellMenu.item("Import Microsoft Project or CSV…", #selector(NSDocumentController.openDocument(_:)), "i", [.command, .shift]),
                    ShellMenu.web("Import Everything…", "file.importAll"),
                    ShellMenu.web("Export Everything…", "file.exportAll"),
                    ShellMenu.web("Export This Week as Calendar (.ics)…", "file.exportIcs"),
                    ShellMenu.submenu("Export", [
                        ShellMenu.web("Microsoft Project XML…", "file.exportXml"),
                        ShellMenu.web("Microsoft Project MPX…", "file.exportMpx"),
                        ShellMenu.web("Primavera XER…", "file.exportXer"),
                        ShellMenu.web("Primavera PMXML…", "file.exportPmxml"),
                        ShellMenu.web("GNOME Planner…", "file.exportPlanner"),
                        .separator(),
                        ShellMenu.web("Task List as CSV…", "file.exportCsv"),
                        .separator(),
                        ShellMenu.web("Gantt Chart as SVG…", "export.svg"),
                        ShellMenu.web("Gantt Chart as PNG…", "export.png"),
                        ShellMenu.web("Gantt Chart as PDF…", "export.pdf", "e", [.command, .shift]),
                    ]),
                ]),
                ShellMenu.submenu("Edit", ShellMenu.editItems(selectAllTitle: "Select All Tasks") + [
                    .separator(),
                    // No key equivalent: the page handles Delete itself, and a menu
                    // shortcut would take the key away from text fields.
                    ShellMenu.web("Delete", "edit.delete"),
                ]),
                ShellMenu.submenu("Task", [
                    ShellMenu.web("Task Information…", "task.info", "i"),
                    .separator(),
                    ShellMenu.web("New Task Below", "task.new"),
                    ShellMenu.web("New Task Above", "task.newAbove"),
                    ShellMenu.web("New Milestone", "task.milestone"),
                    .separator(),
                    ShellMenu.web("Indent", "task.indent"),
                    ShellMenu.web("Outdent", "task.outdent"),
                    ShellMenu.web("Move Up", "task.up"),
                    ShellMenu.web("Move Down", "task.down"),
                    .separator(),
                    ShellMenu.web("Link Selected Tasks", "task.link", "l"),
                    ShellMenu.web("Unlink Selected Tasks", "task.unlink", "l", [.command, .shift]),
                    .separator(),
                    ShellMenu.web("Toggle Milestone", "task.toggleMilestone"),
                    ShellMenu.web("Mark 100% Complete", "task.complete"),
                    .separator(),
                    ShellMenu.web("Show in Calendar", "task.calendar"),
                    ShellMenu.web("Break into Subtasks…", "task.breakUp"),
                ]),
                ShellMenu.submenu("Resource", [
                    ShellMenu.web("Resource Information…", "resource.info"),
                    .separator(),
                    ShellMenu.web("New Resource", "resource.new"),
                    ShellMenu.web("Delete Resource", "resource.delete"),
                ]),
                ShellMenu.submenu("View", [
                    ShellMenu.web("Projects", "view.projects", "1"),
                    ShellMenu.web("Gantt Chart", "view.gantt", "2"),
                    ShellMenu.web("Kanban", "view.kanban", "3"),
                    ShellMenu.web("All Tasks", "view.alltasks", "4"),
                    ShellMenu.web("Calendar", "view.calendar", "5"),
                    ShellMenu.web("Team Schedule", "view.team"),
                    ShellMenu.web("People", "view.people"),
                    ShellMenu.web("Priority", "view.priority", "6"),
                    ShellMenu.web("Task Sheet", "view.sheet", "7"),
                    ShellMenu.web("Resource Sheet", "view.resources", "8"),
                    ShellMenu.web("Resource Usage", "view.usage", "9"),
                    ShellMenu.web("Network Diagram", "view.network"),
                    .separator(),
                    ShellMenu.web("Zoom In", "view.zoomIn", "+"),
                    ShellMenu.web("Zoom Out", "view.zoomOut", "-"),
                    ShellMenu.web("Go to Today", "view.today", "0"),
                    .separator(),
                    ShellMenu.web("Expand All", "view.expandAll"),
                    ShellMenu.web("Collapse All", "view.collapseAll"),
                    .separator(),
                    ShellMenu.web("Checks Panel", "view.checks"),
                    .separator(),
                    ShellMenu.fullScreenItem(),
                ]),
                ShellMenu.submenu("Project", [
                    ShellMenu.web("Project…", "project.sheet"),
                    ShellMenu.web("Project Settings — Working Time & Scheduling…", "project.info"),
                    ShellMenu.web("Custom Fields…", "project.fields"),
                    ShellMenu.web("Archive Project", "project.archive"),
                    ShellMenu.web("Statistics", "project.stats"),
                ]),
            ],
            helpItems: [ShellMenu.web("Working with the Planner", "help.guide", "?")])
    }
}
