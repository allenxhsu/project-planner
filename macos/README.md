# Project Planner for macOS

A native shell around the [web app](../README.md). The plan, the scheduler and
every editing rule stay in `../src` — one codebase, so the Mac app and the
browser can never disagree about a date. The shell that supplies what a browser
tab cannot — documents, the menu bar, save panels, PDF — is the shared
[ToolkitShell](../../shell-kit) package.

What is left in this target is what no other app in the suite has:

| File | |
|---|---|
| `App.swift` | the `ShellConfig` (name, `project-app` scheme, `.project.json` suffix), the document's Microsoft Project rules, and the one extra message (`convertExport`) |
| `MainMenu.swift` | the menu table: every `web` item is a command id from `COMMANDS` in `src/ui/toolbar.js` |
| `Converter.swift` | Microsoft Project files through MPXJ |

## Requirements

macOS 14 and a Swift 6 toolchain (Xcode 16 or later, or matching command-line
tools). No other dependencies.

## Building the app

```bash
macos/scripts/build-app.sh
```

produces `macos/build/Project Planner.app` (under 1 MB), ad-hoc signed so a
locally built copy launches without Gatekeeper friction. `CONFIG=debug`,
`OUT_DIR=…` and `VERSION=…` steer it. The script copies `index.html`, `src/`
and the parts of `ui-kit/` the page loads into the bundle, so **rebuild after
changing the web app**.

The app has to run as a bundle: `NSDocument` reads the document types it can
open from `Info.plist`. Under `swift run` the window still comes up — it serves
the web app straight from the repository — but Open and Save are not available.

```bash
cd macos && swift test
```

checks that every menu command id exists in the page's `COMMANDS` table, that
the scheme handler serves nothing outside the web root, and the save-name and
import-sniffing rules.

## How the two halves meet

The page is served from a custom scheme, `project-app://app/…` — ES modules
will not load from `file://`, and a real origin also gives the page its own
`localStorage`, where the shared appearance preference lives.

`src/host.js` is the page's half of the bridge; `EditorWindowController.swift`
is the app's.

| Page → app | |
|---|---|
| `ready` | the page is up; the app hands it the file the document read |
| `changed` `{json, dirty, name}` | sent after every edit. The document keeps the JSON, so saving never has to ask the page and wait |
| `saveFile` `{name, base64}` | an export (XML, CSV, SVG, PNG): the app shows a save panel |
| `convertExport` `{name, xml}` | Project XML to convert with MPXJ into the format `name` ends in (MPX, XER, PMXML, Planner), then a save panel |
| `pdf` `{name, pages: [{svg, w, h}]}` | the app renders the SVG in an offscreen web view and writes a vector PDF the size of the chart |
| `new` `open` `save` | the page's own shortcuts, forwarded to AppKit |

| App → page | |
|---|---|
| `projectHost.load(text, name)` | a `.project.json` plan, Microsoft Project XML, or a CSV task list |
| `projectHost.command(id)` | a menu command — the same ids the web menu bar runs |
| `projectHost.saved(name)` | the document was written; the page clears its unsaved mark |

Hosted, the page hides its HTML menu bar, does not use the browser autosave
(each window is a document, and the app saves it), and suppresses the web
view's own context menu, whose Reload would discard the window's plan.

## Files

`File ▸ Open` reads a `.project.json` plan, a Microsoft Project file
(`.mpp`, `.mpt`, `.mpx` — through MPXJ, bundled with a Java runtime under
`Contents/Resources/converter` when `tools/setup-converter.sh` has run before
the build), Primavera / Planner / GanttProject / ProjectLibre files, Project
XML (`.xml`) or a CSV task list. Imports always arrive as a new, untitled, unsaved document —
they are never written back over the file they came from; use
`File ▸ Export` for that. The app only *writes* `.project.json`, and suggests
the same `plan-name.project.json` the web app gives its downloads.

It registers as an **Alternate** handler for JSON, XML, CSV and `.mpp`: it can open
them, but macOS will not make it the default opener. Choose it per file with
Finder's *Open With*.

## Keys

`⌘Z` / `⇧⌘Z` undo and redo the plan — or the text, while a text field has the
caret. `⌘A` likewise. Delete and Insert are handled by the page and
deliberately have no menu key equivalent. `⌘1`–`⌘5` switch views, `⌘+` `⌘-`
zoom, `⌘0` scrolls to today, `⌘I` opens the task details, `⌘L` links the
selected tasks, `⌘,` opens Appearance, `⇧⌘E` exports the chart as PDF.
