# Motion, walked through — what to duplicate

A study of Motion's web app (app.usemotion.com, 26 Sep 2026), made by
navigating it and creating one sample project with one sample task in *My
Private Workspace*: "Claude UI study (sample - safe to delete)" and "Sample
task (safe to delete)". Delete both in Motion when this is no longer needed.

Each section says what Motion shows, how a person moves through it, and what
Project Planner has or lacks. The last section is the build order.

---

## 1. The frame

Every page shares one frame: a **left sidebar**, the **page**, and — on the
calendar and the agenda — a **right panel**.

### Left sidebar (≈ 210 px)

Top to bottom:

| Row | What it is | How it behaves |
|---|---|---|
| Account avatar ▾ · « · ⚙ · **＋ New** | account, collapse sidebar, settings, create | New opens: New Task · New Doc · New Sheet · New Project · New Meeting or Event |
| **Now** — e.g. "Sleep 11:00 PM", "test task 10:16 PM" | the event or task happening now, or the task started with *Start task now* | click opens it |
| **AI Chat ⌘/** · 🔍 | assistant, search | |
| Inbox `29` | notifications: "project X entered stage Y", grouped by day, All / Unread, Mark all as read | |
| AI Agenda `3` | today's document (see §3) | badge = tasks needing attention |
| Calendar `Sat Sep 26` | the calendar (§2) | shows today's date on the right |
| Projects & Tasks | the task database (§4) | |
| AI Meeting Notes | | |
| **Favorites ▾** | pinned projects *and* saved views (My Tasks, ACCT 640, Project Timelines, Team Schedule) | hover shows ⋯ and ＋ on a row |
| **Workspaces ▾ ＋** | tree: workspace (count) › folder › project | click a project opens it; ＋ makes a workspace |
| Invite team members · 📖 | footer | |

### Page header

Page icon + title, a ⋯ menu, and page actions on the right (Create Dashboard,
tutorial). Views of a page are **tabs under the title**: Navigate · Task List ·
My Tasks · Project Timelines · Team Schedule · ✎ · ＋ (new view). Search sits at
the right of the tab row.

---

## 2. Calendar

**Top bar:** `Today` · ‹ › · **Sep 2026** (month bold, year light) … `Booking
links` · `Display options` · `Refresh all tasks` · ＋ · `Week ▾` · `Close »`
(hides the right panel).

**Display options** (popover): Start week on (Sunday) · Hide declined events ·
Show tasks in calendar · Show completed tasks · Hide tasks in future stages ·
Auto-scheduling settings ⚙ · Calendar settings ⚙.

**Grid:** time-zone label (`PDT ＋`) over the hour gutter; day heads read
`Sun 20`, today as a blue pill `Sat [26]`; an all-day row above the hours
("Stay at MODERNE HOSTEL"); events in the calendar's colour; tasks as cards
with a ring checkbox, title, time, and a red dot when at risk; the current
time as a line.

**Right panel (≈ 240 px):** mini month (Su–Sa, today ringed, `Today`, ‹ ›) ·
**Calendars** ＋ Add calendar · Search teammates · **My calendars (9)** — each
calendar with its colour chip and account icon (Google, Microsoft) ·
Frequently met with (2) · Accounts (2).

**On the grid:** right-click or drag empty time → Create event / Create task
(fixed time); right-click a task → complete, start now, change dates, add
time, do later / ASAP, duplicate, create project, save as template,
unschedule, archive, delete (all built already).

## 3. AI Agenda

A document per day in a breadcrumb path (`My Private… / … / Sep / Fri Sep
25`): **New tasks for today** (numbered) · **Today's tasks** · **Tasks past
deadline**, each row a ring checkbox, name, due date in red when late, and
duration. The right panel is the day's timeline (`Today · Sat Sep 26`, ‹ ›).

## 4. Projects & Tasks

**Navigate:** the workspace tree as a page (workspace ▸ with counts).

**Task List:** `Group by: Workspace › Project › Stage › Task` · Sort Groups ·
`List | Kanban | Gantt` · Sort Tasks · `Workspace: All` · Filters (n) ·
`TASKS: 14` · "Only show scheduled past deadline" · "Show resolved tasks".
Columns: Name · ETA · Assignee · Project · Completed at · Duration · Deadline ·
Completed. Group rows carry the auto-schedule icon, ETA, assignee, duration
total and deadline span; each group ends in `＋ Add task` and a summary row.

**My Tasks:** Kanban grouped by deadline week (`Mon Sep 21 – Sun Sep 27 ·
Current`), cards showing project, priority flag, status, date, the
auto-schedule toggle, `0m of 30m`, deadline, assignee, `＋ Add label`.

**Project Timelines:** Gantt of projects grouped by workspace, today marked,
`Quarter` · `Jump to date` · `Today`, "Show completed projects".

**Team Schedule:** Kanban by scheduled date › assignee.

## 5. Project

**Create:** New ▸ Project → gallery with a workspace picker: *Create Project
Template with AI* · *Create Project from Scratch* · templates of that
workspace, each with its stages and task counts · New Project Workflow
Template. (Built as the New project wizard.)

**From scratch** opens the **project sheet**, three columns once saved:

1. Title, description (rich text), **Docs** (Create doc / Add doc),
   **Attachments**, **Activity** with a comment box.
2. A status banner ("No ETA because there are no auto-scheduled tasks in this
   project"), then Workspace, Folder, Assignee, Status, Start date, Deadline,
   Priority, Color, Labels, ＋ Add custom field.
3. **Tasks** ↗ ＋, grouped by stage (`No Stage` · Convert to stage).

Project ⋯: Copy link ⌘L · Add to Favorites · Save as template · Delete.

**Project page:** title, stage pill (`Week 9`), status (`Open`), ⋯, Project
info · Create Dashboard · Workspace Settings; tabs Navigate (docs) · Task List
· saved views.

## 6. Task

**Quick add** (＋ in a project's Tasks): name, description, then chips —
priority, labels, assignee, duration (30 min), due (the project deadline),
"Blocked by 0 tasks" — the auto-schedule switch, Cancel / Save ⌘↵.

**Task sheet** (opens over the project sheet): Mark complete · duplicate · ⋯;
right column: status banner (On track), Workspace, Folder, Project [Open],
"Auto-scheduled on Sat Sep 26 at 8 AM", Assignee, Status, Priority, Duration
`0 min of 30 min` › Min chunk, Start date, Deadline 🔔 › Hard deadline,
Schedule, Labels, ＋ Add custom field, **Blocked By**, **Blocking**. Left:
description, Attachments, Activity + comment.

Option lists:

- **Status:** Backlog · Blocked · Cancelled · Completed · In Progress · Todo ·
  ＋ Add status.
- **Duration:** Reminder · 15 min · 30 min · 45 min · 1 hour · 2 hours · 4
  hours · 8 hours, or type one.
- **Min chunk:** No Chunks · then only sizes smaller than the duration.
- **Schedule:** every schedule with an ✎, and ＋ Add schedule.

---

## 7. Where Project Planner stands

| Motion | Project Planner today |
|---|---|
| Left sidebar with nav, Favorites, Workspaces tree | **Missing** — views are a tab row; workspaces are a header menu |
| "Now" row in the sidebar | Running-task chip in the header (only a started task) |
| Calendar top bar (Today ‹ › **Sep 2026** … Display options · Refresh · Week ▾ · Close ») | Toolbar of buttons + a filter row above the grid |
| Day heads `Sun 20`, today as a pill, time zone over gutter | `SUN / 20 Sep`, no time zone |
| Right panel: mini month + Calendars | Right panel is the inspector on every view |
| Display options popover | Filters are always on screen |
| AI Agenda document + day timeline | Today page — same content, built |
| Task List grouped Workspace › Project › Stage › Task with columns | All Tasks grouped Project › Phase — no ETA/Completed columns |
| My Tasks kanban by deadline week | Kanban is by stage only |
| Project Timelines (Gantt of projects) | Gantt is of one project's tasks |
| Project sheet (3 columns, Tasks panel, ETA banner) | Projects shelf cards + wizard; no project sheet |
| Task sheet, quick-add chips, statuses, durations, chunks, schedules, blocked by / blocking | Built (task sheet, new-task panel, blockers) — statuses are Stages; no Backlog/Blocked/Cancelled |
| Inbox of stage changes | Missing |
| Docs, attachments, AI chat, booking links, meeting notes | Out of scope |

## 8. Build order

1. **Frame:** left sidebar (New, Now, search, nav, Favorites = pinned
   projects, Workspaces tree with projects), view tabs removed.
2. **Calendar chrome:** Motion top bar with Display options popover and a
   range menu; day heads and time zone; right panel with mini month and
   Calendars (connected calendars, people, projects with colours).
3. **Projects & Tasks:** Navigate tree; Task List grouped Workspace ›
   Project › Stage with ETA / Completed columns; My Tasks kanban by deadline
   week; Project Timelines (projects on a Gantt).
4. **Project sheet:** three columns with the Tasks panel and the ETA banner;
   stage pill and status on a project page.
5. **Statuses** beyond stages (Backlog, Blocked, Cancelled) and an **Inbox**
   of stage changes.
