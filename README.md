# Project Planner

A browser-based project scheduler in the manner of Microsoft Project: a task
list with outline levels, a Gantt chart with dependency arrows and the critical
path, a network diagram, resource sheets and usage, live checks, and
interchange with Microsoft Project itself through its XML format.

No build step, no package manager, no dependencies — plain ES modules and SVG,
styled with the shared `ui-kit` HUD theme.

## Running it

```bash
./serve.sh
```

Then open <http://localhost:8125>. (ES modules need `http://`; opening
`index.html` from the filesystem will not work.) The app opens on a worked
sample — a website relaunch. `File ▸ New plan` starts an empty one. Work is
autosaved to the browser; `File ▸ Save` writes a `*.project.json` file.

```bash
node --test tests/
```

runs the calendar, scheduler, outline, checks and file-format tests under Node.

## macOS app

```bash
macos/scripts/build-app.sh
```

builds `macos/build/Project Planner.app`: a native shell that hosts this same
web app, with document windows, a real menu bar, Finder file opening, native
save panels and vector PDF export. See [macos/README.md](macos/README.md).

## How it schedules

Tasks are an ordered list with outline levels, as Project keeps them. A task
followed by a deeper one is a **summary**: its dates are never stored, only
computed from its subtasks. Everything else is the critical path method over a
working calendar:

| Input | Effect |
|---|---|
| Duration | working days (`5d`, `2w`, `8h`); `0d` is a milestone |
| Predecessors | `3`, `3FS+2d`, `5SS-1d`, `7FF`, `2SF` — row numbers, link type, lag or lead |
| A link on a summary | binds every task under it |
| Constraint | As Soon As Possible, Start/Finish No Earlier/Later Than, Must Start/Finish On |
| Deadline | a marker on the chart and a check; a missed deadline shows as negative slack |
| Calendar | working weekdays, hours per day, holidays (Project ▸ Information) |

A forward pass gives early dates, a backward pass late dates; total slack is
the difference, and tasks with none are **critical** (red). Work is duration ×
hours × assignment units; cost adds resource rates and fixed costs. All of it
is recomputed on every edit — nothing is cached in the file.

Typing a **start date** pins the task with a Start No Earlier Than constraint,
as Project does; so does dragging its bar. Typing a **finish date** changes
the duration.

## Views

| View | What it is |
|---|---|
| Gantt Chart | editable task grid beside the timeline: bars, summary brackets, milestones, dependency arrows, progress, deadlines, today. Drag a bar to move it, its right edge to resize, the dot at its end onto another bar to link. Days, weeks or months. |
| Task Sheet | the full column set: WBS, work, cost, slack, critical, constraint, deadline, notes |
| Resource Sheet | people and things: type, max units, rate, group; work and cost roll-ups |
| Resource Usage | hours per resource per week, with each assignment beneath; over-allocated weeks highlighted |
| Network Diagram | one box per task in dependency order, critical path in red |

The details panel on the right edits the selected task (including its
predecessors and assignments), the selected resource, or the project itself.
The bottom panel lists checks — circular links, negative slack, missed
deadlines, over-allocation, tasks with no predecessor or resource, late tasks
— and click-through selects the culprit.

## Files

- `plan.project.json` — the native format, plain JSON.
- **Microsoft Project files** — `.mpp` and `.mpt` from every Project version
  open directly (`File ▸ Open`), as do `.mpx`, Primavera XER and PMXML, Asta,
  GanttProject, ProjectLibre and Planner files. The reading is done by
  [MPXJ](https://mpxj.org) through `tools/mpp2xml.sh`; run
  `tools/setup-converter.sh` once to fetch it and its Java runtime (about
  180 MB, not kept in git). `serve.sh` runs it for the browser; the macOS app
  bundles it.
- **Saving for Microsoft Project** — nothing outside Project itself can write
  `.mpp`, MPXJ included. `File ▸ Save for Microsoft Project (XML)` writes
  Project XML (MSPDI) with the tasks, outline, durations, links with lag,
  constraints, deadlines, progress, notes, resources, rates, assignments and
  calendar; Project opens it as a plan and saves it as `.mpp` from there.
  Older tools take the **MPX** export; Primavera takes **XER** or **PMXML**;
  GNOME **Planner** has its own — all four are written through the converter.
- **CSV** — the task list out, or a plain list in (Name, Duration,
  Predecessors, Resources… columns).
- **SVG / PNG / PDF** — the Gantt chart, drawn on paper colours. The same
  drawing without a browser: `node tools/gantt-svg.mjs plan.project.json > gantt.svg`
  (`--sample`, `--zoom day|week|month`). [doc/sample-gantt.svg](doc/sample-gantt.svg)
  is the sample plan rendered that way.

## Keys

`⌘Z` `⇧⌘Z` undo, redo · `⌘S` save · `⌘O` open · `⌘A` select all · `⌘I` task
details · `⌘F` find · `⌘L` link selected · `⇧⌘L` unlink · `Insert` new task ·
`Delete` delete · `⌥⇧→ ⌥⇧←` indent, outdent · `⌥⇧↑ ⌥⇧↓` move · `Enter` / `F2`
edit the cell (or just type) · `Tab` next cell · `Space` fold a summary ·
`⌘+` `⌘-` zoom · `⌘0` today.

## Layout

```
index.html          the shell
src/main.js         wiring and keyboard shortcuts
src/model/          calendar, plan model and outline, scheduler (CPM), checks, sample
src/state/          store with undo/redo; editing commands
src/ui/             grid, task grid, Gantt, network, resources, inspector, checks, header/menus, dialogs
src/io/             .project.json, Microsoft Project XML, CSV, SVG/PNG/PDF
src/host.js         bridge to the macOS shell
tests/              node --test
tools/gantt-svg.mjs the chart as SVG from the command line
tools/mpp2xml.sh    Microsoft Project files in and out, through MPXJ (see tools/README.md)
macos/              the Swift shell
ui-kit/             the shared theme (a copy of ../ui-kit)
```
