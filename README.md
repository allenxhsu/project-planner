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
save panels and vector PDF export. The shell itself is the shared
[ToolkitShell](../shell-kit) package; what is written here is the app's
configuration, its menu table and the Microsoft Project converter. See [macos/README.md](macos/README.md).

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
| Projects | every plan on the shelf as a card: dates, progress, task and resource counts. Open one, start one, or take one off the shelf |
| Kanban | the open plan's tasks as cards, in columns by **stage**, by progress or by resource. Dragging a card is a real edit |
| Calendar | the week, with each task's hours laid into blocks. A task appears when it asks to, in the size of block it asks for, inside the time block it belongs to |
| Priority | what to work on now, ranked by what is late, what has no slack and what is nearest, with work that is waiting on something else kept separate |
| All Tasks | every task in every plan, filtered by late / unfinished / critical / unassigned, searchable, and a row opens the plan it belongs to |

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

## The calendar

The schedule says a task runs Tuesday to Friday and takes 18 hours. The
calendar says *when*: which hours, on which days.

- **A task opts in.** `Show in calendar` on the task's details. A plan holds
  plenty of work nobody schedules hour by hour.
- **Block size** is one of half an hour, one, one and a half, two or four. The
  task's remaining hours — what the plan expects, less what was logged — are
  cut into that many blocks.
- **Time blocks** are the named hours of the week a kind of work is allowed:
  *Study, 06:00–08:00, every day*; *Work, 08:00–17:00, weekdays*; *Deep focus,
  08:00–10:00, weekdays*. A task belongs to one and is released into those
  hours by itself. Blocks live on the plan, under Project ▸ Time blocks.
- **Phases gate the release.** A plan can say which phase it is in — a
  top-level summary such as Design — and then only that phase's tasks reach
  the calendar. There is no point putting build work in next week's mornings
  while the design is still being argued about.
- **Nobody is double-booked.** Two tasks for one person never overlap; two
  people working the same hour sit side by side.
- **A week that does not hold the work says so**, rather than hiding the
  overflow.

Nothing here is stored. Blocks are computed from the plan, as the schedule is,
so logging four hours or moving a task re-lays the week by itself.

**Breaking work up.** A multi-day task — "design the layout" — can be cut into
subtasks from its details, the calendar or the Task menu. The parts divide its
duration, inherit its people and its calendar settings, and run one after
another, so the parent keeps the same span and becomes a summary of them.

## Stages, and time actually spent

Two things the schedule does not have, because they are about how a team works
rather than about arithmetic:

**Stages** are the plan's own Kanban columns — rename them, reorder them, add
and delete them. One or more is marked *finished*, and that flag is what keeps
the board and the schedule honest: dropping a card in a finished column
completes the task, and completing a task moves it there. A plan written before
stages existed opens with the default three, with everything already complete
sitting in Done.

**Timesheets** are hours logged against a task, in the Time section of the task
details. `Work` stays what the plan *expects* (duration × units); `Spent` is
what was logged; `Remaining` is the difference, never below zero. Both roll up
through summary tasks, and both have columns in the Task Sheet.

Neither travels in Microsoft Project XML — MSPDI has no column for either — so
a plan that round-trips through Project keeps its dates and loses its stages
and timesheets. They are in `*.project.json`, and they sync.

## Sync

Every plan carries an `id`, and one plan is one record in a
[sync-kit](../sync-kit) workspace called `project`:

```json
{ "id": "plan_…", "type": "document", "format": "project-planner",
  "name": "Website relaunch", "body": "…the exact bytes File ▸ Save writes…",
  "updatedAt": 1790217036091, "deletedAt": null, "origin": "1d6b1106" }
```

The server never learns what any of it means, so a plan that travelled through
sync and one that travelled on a memory stick are the same plan.

`Settings ▸ Sync…` (the View menu, or the app menu on macOS) takes a server
URL, a token and a switch, and shows what the last sync did. With it on, a sync
runs every 30 seconds, whenever the window comes back to the front, and after
every save. To try it on this machine:

```bash
cd ../sync-kit/server && npm install
PORT=8081 SYNC_TOKENS='project:dev:a-secret-at-least-12-chars' \
  ALLOWED_ORIGINS='http://localhost:8125,project-app://app' \
  STORAGE=sqlite npm run dev
```

Then paste `http://127.0.0.1:8081/w/project` and the secret into Sync… in a
browser tab and in the Mac app; both converge on the same plan. (The
`ALLOWED_ORIGINS` line is what lets a browser tab and the Mac app's
`project-app://` page call it; a deployed server names its own origins.)

Whoever saved last wins — **except** when the plan here has unsaved edits, in
which case the arriving plan does not silently replace them and you are asked
which to keep. Changing the server URL clears both sync cursors, because they
describe a position against one particular server and mean nothing against
another.

**What travels later.** Today the whole plan is one record, which is honest
about how it is edited: a rescheduling touches nearly every task at once. When
this grows to two people editing one plan at the same time, tasks, links,
resources and assignments become per-row records under the plan id, while the
calendar and any baselines stay document-level — they are properties of the
plan as a whole, and splitting them would buy nothing.

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
src/state/sync.js   sync: settings, the engine, and what arrives from elsewhere
src/host.js         bridge to the macOS shell (a vendored copy of ../shell-kit/js/host.js)
tests/              node --test
tools/gantt-svg.mjs the chart as SVG from the command line
tools/mpp2xml.sh    Microsoft Project files in and out, through MPXJ (see tools/README.md)
macos/              the Swift shell
ui-kit/             the shared theme (a vendored copy of ../ui-kit)
sync-kit/           the sync client (a vendored copy of ../sync-kit)
```
