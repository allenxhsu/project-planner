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

builds `~/Library/Caches/ProjectPlanner/build/Project Planner.app` (outside
the repository, where Spotlight will not index it into Launchpad as a second
app; `OUT_DIR=` puts it elsewhere): a native shell that hosts this same
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
| Duration | how long the task is **open** — working days (`5d`, `2w`); `0d` is a milestone |
| Urgency | `Do it now`, `High`, `Normal`, `Low` — a person's judgement, which the dates cannot supply. It decides who gets the earliest hours when two tasks want the same morning, and weighs into the Priority ranking. `Do it now` starts today and puts the task on the calendar |
| Work | how many **hours** are actually spent in that time. Left blank it is duration × hours × units, the full-time assumption; said plainly (`12h`) it is the effort, and the difference is what "a five-day task that is three hours a day" means |
| Predecessors | `3`, `3FS+2d`, `5SS-1d`, `7FF`, `2SF` — row numbers, link type, lag or lead |
| A link on a summary | binds every task under it |
| Constraint | As Soon As Possible, Start/Finish No Earlier/Later Than, Must Start/Finish On |
| Deadline | a marker on the chart and a check; a missed deadline shows as negative slack |
| Calendar | working weekdays, hours per day, holidays (Project ▸ Information) |

Work matters beyond the total: it is what the resource checks measure (twelve
hours over five days is a third of someone's day, not all of it, so it no
longer reads as over-allocated), and it is what the calendar lays out — twelve
hours in two-hour blocks is one block a day across the days the task is open,
not three full days and two idle ones.

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
| People | everyone in the shared directory: hours, tasks and plans across the whole shelf, the rate that every plan uses, and the profile summary from Profiler |
| Projects | every plan in hand as a card, with finished ones folded into the archive: dates, progress, task and resource counts. Open one, start one, or take one off the shelf |
| Kanban | the open plan's tasks as cards, in columns by **stage**, by progress or by resource. Dragging a card is a real edit |
| Calendar | a day, the working week, the whole week including the weekend, or a month. Each task's hours are laid into blocks: a task appears when it asks to, in the size of block it asks for, inside the time block it belongs to |
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
  08:00–10:00, weekdays*. A task may belong to several and is released into
  whichever has room first. Blocks are shared by every project.
- **Phases gate the release.** Phases are named by hand in Project ▸ Phases —
  design, build, launch — and a task or a heading is put in one, everything
  under a heading inheriting it. The plan then says which phase it is in, and
  only that phase's tasks reach the calendar. There is no point putting build
  work in next week's mornings while the design is still being argued about. A
  task in no phase is released whatever the plan is working on, because saying
  nothing cannot mean "not yet".

  Phases used to be read off the outline: every top-level summary was one. That
  offered "Kick-off meeting with the customer" and "Trade study of rotary" as
  phases of a project, which they are not. An outline is how work is grouped; a
  phase is where the project has got to.
- **A gap, if you want one.** Project ▸ details sets the breathing room after
  every block — none, 5, 10, 15 or 30 minutes — so the day is not back to back.
  It costs a block a day and the work moves on rather than vanishing.
- **One calendar, every plan.** The hours of a week are shared by everything a
  person is working on, so all the plans on the shelf are laid out together.
  Each block carries the person's initials in their own colour and the plan it
  came from; clicking one from another plan opens it there. **Calendar for**
  narrows to one person, and a second menu to the open project alone. People
  are matched across plans by the shared directory (below), falling back to
  their name.
- **Nobody is double-booked.** A task books the hours of *everyone* on it, so
  two tasks that share a person never overlap; two people working the same hour
  sit side by side.
- **A week that does not hold the work says so**, rather than hiding the
  overflow.

Nothing here is stored. Blocks are computed from the plan, as the schedule is,
so logging four hours or moving a task re-lays the week by itself.

**Work breakdown.** A multi-day task — "design the layout" — can be cut into
subtasks from its details, the calendar or the Task menu. The parts divide its
duration **and its hours**, inherit its people and its calendar settings, and
run one after another, so the parent keeps the same span and becomes a summary
of them — which is the WBS: the elapsed span at the top, the hours underneath.

## Workspaces

Work, personal and school are different lives that happen to use the same
tool. Keeping them apart is not a filing preference: a Saturday on a course
should not read as capacity for a customer's job, and a customer's deadline
has no business in a personal week.

A plan belongs to a **workspace**, chosen from the button beside the app's
name. Switching changes what every screen counts — the projects on the shelf,
the rows in All Tasks, the hours on the calendar, and what each person is
carrying. **All workspaces** shows everything at once, and a card then says
which workspace it is filed under.

A plan started while a workspace is in front belongs to it. Any plan can be
moved from its card's menu. A plan filed under nothing is unfiled and shows up
wherever you are, which is what a plan made before workspaces existed is.
Deleting a workspace keeps its plans and unfiles them.

Workspaces are records like plans and people, so they travel between devices.
Which one is in front is each device's own business and does not sync: the Mac
can be on Work while the browser is on School.

## People

A person is not a per-project thing. The shelf keeps a **directory of people**
alongside the plans, and a plan's resource points at an entry in it, so the
same Uma Chen in three projects is one person whose hours cannot be promised
twice. Adding someone offers the people already known before it offers a blank
row, and a name typed into a task's Resource Names joins the directory too.

The plan still carries each person's name, rate and type, so a
`*.project.json` opened on its own is still a whole plan. A resource with no
directory entry — everything written before this — is identified by name.

### The People screen

The **People** view is where that directory is kept. One card per person, with
what they are carrying across every plan on the shelf: hours, tasks, the plans
they are on, and what those hours cost. Editing someone there is the point of
it — the change goes into the directory *and* into every plan that points at
them, so a rate is set once rather than in four places.

A plan written before the directory existed names its people and links to
nobody. Those are matched by name so the screen still reads as one person, and
a banner offers to link them for real, which is the one-off that makes editing
reach them. Only an exact name match is linked; a near miss would merge two
different people. Someone who is in a plan but not the directory is shown
separately, marked *Not shared*, with an action to add them.

### Profiles come from Profiler

Who someone *is* belongs to [Profiler](../Profiler), the suite's stakeholder
profiling app, not here. A person in the directory can carry the **summary** of
a profile Profiler exported: the headline of each instrument (`INTJ`,
`High D / High C`), its confidence and its caveats, with `Profiler ↗` to open
the app itself.

The link is Profiler's own export file, read through the contract it documents
as stable — `format`, `formatVersion`, `subject`, and per instrument `id`,
`headline`, `codes`, `confidence`, `caveats`. Its `detail` blob is documented
as unstable and is ignored, and the raw item responses are never copied: a plan
is not the place to keep someone's answers. Profiler's `subject.team` and
`subject.role` come across, because otherwise they would be typed twice.

Nothing is read out of Profiler's storage and nothing is written back to it.
On the Portal origin, where every app is served from one place, `Profiler ↗`
goes to `/profiler/`; elsewhere it falls back to the `profiler://` scheme the
Mac app registers.

### How much of it is on screen

Five ranges, from the toolbar or the View menu. **Day** is one day hour by
hour. **3 days** is that day and the next two, starting where you are rather
than at a Monday. **Work week** is the plan's own working days, which is not
Monday to Friday by decree — it follows the working days in Project
information. **Week** is all seven, for when the weekend is being worked.
**Month** is a different drawing: a cell a day, each listing what is on it with the hours it
holds, because thirty days of an hour grid is unreadable. Double-clicking a
day, or its "+n more", opens that day. The arrows move by whatever is on
screen: a day, a week or a month.

A day has one column and room to spare, so each block reads as a line: the
hours it runs, who is on it, the task, the project it belongs to, how long it
takes, its urgency, how far along it is and any deadline. A block too short to stack a time, a name and a project — half an hour is
about twenty pixels — puts them on one line instead, so a week still says what
each block is rather than only when it is.

**Colour by** is person, project, or automatic. Colour by person answers who
is in three places at once, which is the question when several people share a
calendar. Colour by project answers what the week is going into, which is the
question when the calendar is one person's and the projects are many — and one
person's calendar coloured by person is one colour, which says nothing.
Automatic picks whichever the week actually is.

Each project's colour is spaced a long way from the ones beside it — the hue
circle walked by the golden angle, in a fixed order, so adding a project never
recolours the others. A project can name its own hue in Project information,
and a legend above the grid says which colour is which; clicking a project
there opens it.

### Why a day is not full

Under the grid, the calendar says what it placed and why there is not more:
how many hours went on, how much room is left at the plan's daily limit, how
many released tasks are not due to start until later, and how many unfinished
tasks are not on the calendar at all. An empty afternoon is then a fact with a
reason rather than a thing to wonder about.

Three things keep work off an afternoon. A task is not on the calendar until
it asks to be. A task is never placed before the day its plan schedules it to
start. And a task belongs to a time block, so one in **Deep focus,
08:00–10:00** can only ever land in those two hours, however free the rest of
the day looks. A task can belong to **several** time blocks — late evenings *and* the
weekend — and is placed in whichever of them has room first, in order of the
clock. That is what makes a block a constraint worth setting rather than a
cage: an essay that may be done any evening or at any hour of the weekend says
exactly that, and the calendar fills the evenings before it takes a Saturday.

Time blocks are **shared by every project**, because they are hours in your
week and not properties of a plan: study from six, work from eight, deep focus
until ten, the weekend. Editing one changes it everywhere at once. They are
edited in Project information, reachable from **Time blocks…** on the calendar
toolbar and from **Edit time blocks…** beside a task's own time block. Each
plan still carries a copy of the list, so a `*.project.json` opened on its own
schedules exactly as it did here.

### Why a week is not full

Duration is how long a task is open. Work is how much of that time goes into
it. A five-day design task is rarely five days of doing it, so a task that does
not state its work is put on the calendar at **half its duration** by default,
not all of it. State a task's work and that number is used exactly as given.
The plan's own figure is in Project information, from a quarter to full time.

On top of that, no day is filled wall to wall: the calendar places at most
**six hours** of planned work per person per day, again a plan setting. Work
that does not fit runs on into the days after, which is the calendar telling
you the truth about the week rather than hiding it.

Two kinds of plan are not work in hand, and neither reaches the calendar, All
Tasks, or what a person is carrying:

- A **template** is a pattern to copy. Making one marks it, and any plan can be
  marked or unmarked from its card.
- An **archived** plan is finished or shelved. Archiving is not deleting: every
  task, assignment and logged hour is kept, the plan stays on the shelf and in
  sync, and it comes back whole. The Projects screen keeps archived plans
  behind one click, with the date each was archived on its card.

## Connecting Google and Outlook calendars

Real meetings become busy hours the calendar schedules around, so a stand-up
at 09:15 pushes the morning's work to 09:30 rather than being double-booked.

This reads a calendar's **private iCalendar address**, which both providers
hand out and neither requires an OAuth app for:

- **Google Calendar** — Settings ▸ *Settings for my calendars* ▸ pick the
  calendar ▸ *Integrate calendar* ▸ **Secret address in iCal format**.
- **Outlook** — Settings ▸ Calendar ▸ *Shared calendars* ▸ **Publish a
  calendar**, choose *Can view all details*, and copy the **ICS** link.

Paste it into Project ▸ *Connected calendars* ▸ Connect a calendar, and say
whose hours it is. Repeating events are expanded (daily, weekly with named
days, monthly, yearly, with `INTERVAL`, `COUNT` and `UNTIL`); anything marked
*free*, and anything cancelled, is ignored.

Two things to know. The page fetches through `serve.sh`, because Google and
Outlook serve those addresses without CORS headers and no browser can read one
directly — so **refresh in a browser tab**; the events travel with the plan, so
the Mac app shows them without fetching anything. And this is read-only: it
takes your meetings into account, it does not write tasks back into Google or
Outlook. Writing back, and live two-way sync, need an OAuth client registered
in your own Google Cloud and Microsoft Entra consoles.

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
src/io/             .project.json, Microsoft Project XML, CSV, SVG/PNG/PDF, Profiler profiles
src/state/sync.js   sync: settings, the engine, and what arrives from elsewhere
src/host.js         bridge to the macOS shell (a vendored copy of ../shell-kit/js/host.js)
tests/              node --test
tools/gantt-svg.mjs the chart as SVG from the command line
tools/mpp2xml.sh    Microsoft Project files in and out, through MPXJ (see tools/README.md)
macos/              the Swift shell
ui-kit/             the shared theme (a vendored copy of ../ui-kit)
sync-kit/           the sync client (a vendored copy of ../sync-kit)
```
