# Game mode

Status: **requirements, decided with the owner on 2026-10-01.** No tests or
code yet. Per `AGENTS.md`, the next steps are the failing tests, then the UI
concept, then the code.

## Purpose

Game mode is **another way to feed Flow.** In it, Project Planner does four
things and nothing else:

1. **Select** a task to work on.
2. **Start** it.
3. **Stop** it, answering Flow's finish questions.
4. **Review** what was done.

The game itself — targets, points, Grade, streaks, the shop — lives in Flow.
Planner keeps no score of its own: no project-level score, no bosses, no
leaderboard. A project is too big to play; a task is the unit.

## Switching it on

- A **Game mode** switch in the toolbar and in Settings, off by default. The
  choice is per device (`project-planner:game`, `'on' | 'off'`) and remembered,
  like the home/work mode.
- On, the app opens on the **Play** screen below, drawn in Flow's handheld look
  (cream panels, navy ink, 2 px outlines, hard corners, big bottom buttons).
  Every other view stays reachable, in its usual look.
- Off restores the app exactly as it is today.
- The existing character sheet on People shows only in Game mode, unchanged,
  until Flow retires it as Flow's spec plans.

## 1. Select

The Play screen lists **today's tasks**: the day Planner's calendar laid
(`model/dayplan.js`), the same list Flow already treats as today.

- Each row shows the task, its project, its estimate (the expected work Flow
  already derives from it) and its deadline when it has one.
- **Running** tasks come first, then the rest in the day plan's order.
- At work, home tasks are hidden as they are everywhere else (`state/mode.js`).
- An empty day says so and offers the backlog behind one toggle, as Flow does.

## 2. Start

**Start** on a row is Planner's own **Start task now**: the live block and the
timesheet line it already writes. Nothing new is recorded. Several tasks may
run at once, as Planner already allows; the Play screen shows each running one
with its elapsed time against its estimate.

## 3. Stop

**Stop** on a running task asks, in one step, what Flow needs:

- **Done, or not yet.** *Not yet* is Planner's existing Stop: the time is
  logged and the task stays open. *Done* is Planner's existing Done: 100%,
  `doneAt` set, the running block settled into the timesheet.
- **When done, the finish questions**, stored on the task as
  `finish: { quality, call, value }` and nothing else:
  - **Right-once call** — only for a task whose Flow skill is one-shot
    (Inscription, Summoning, Trial, Deliverance, Parley, Council, Decree,
    Poise): three big buttons, *Clean · Minor fixes expected · This will come
    back*; pressing one finishes the task. This is Flow's call.
  - **Count** — only when the task has a unit (a count measure): one number,
    filled with the last value.
  - **Quality** — defaults to 100%, changed only through Edit.
  - Anything else finishes in **one tap**, as in Flow.

## 4. Review

The **Review** screen lists the tasks finished today, newest first, each with:

- **actual time** (the timesheet hours on that task for that run) against
  **its estimate**, as a percentage over or under;
- the right-once call when one was made;
- **Flow's result** for it — points, pace against Flow's target, a personal
  best — read from Flow's workspace. Until Flow has logged it, the row says
  "waiting for Flow" and shows the Planner numbers only.

A day's summary sits on top: tasks finished, hours spent against hours
estimated.

## The data path

Planner writes **only its own plan**, as today, and reads Flow's workspace
**read-only** for the Review screen. Flow reads the plan, as today.

- Start and Stop are Planner's existing edits; they undo, autosave and sync
  like any other.
- `finish` on a task is the only new field. It is written once at Done and
  cleared when the task is reopened.

Two changes on **Flow's** side make this real (a separate change to Flow's
spec, on its branch):

- A Planner completion's minutes are **the timesheet hours logged on that task
  for the run that finished it**, not the estimate, when there are any.
- Its quality, call and count come from the task's `finish`, when present.

## Screens (concept to agree before code)

- **Play**: today's tasks with Start, the running ones on top with Stop.
- **Stop sheet**: Done / Not yet; then the call buttons or the count.
- **Review**: today's finished tasks, actual vs estimate, Flow's result.
- States: nothing today (offer the backlog), nothing running, Flow not
  connected (Review shows Planner numbers only), Game mode off (none of it).

## Not in Game mode

No baseline, milestone bosses, quest log, project score or team leaderboard:
an earlier draft had them and they were dropped (2026-10-01).
