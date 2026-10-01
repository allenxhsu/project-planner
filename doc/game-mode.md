# Game mode

Status: **requirements, decided with the owner on 2026-10-01.** No tests or
code yet. Per `AGENTS.md`, the next steps are the failing tests, then the UI
concept, then the code.

## Purpose

Game mode turns **the plan** into a game: milestones are bosses, the critical
path is the main quest, finishing on time scores, and the team has a
leaderboard. It is a game about the project, not about the person. The game
about the person lives in Flow, which this app feeds through one result per
finished project (see "Flow").

## Switching it on

- A **Game mode** switch in the toolbar and in Settings. Off by default.
- The choice is per device (`project-planner:game`, `'on' | 'off'`) and is
  remembered, like the home/work mode. It changes how the plan is shown,
  never the plan.
- In Game mode every view takes Flow's **handheld look** (cream panels, navy
  ink, 2 px outlines, hard corners, no glows; big bottom tab buttons on a
  phone) and the game panels below appear. Switching off restores the HUD.
- The existing **character sheet** on People (quests, stamina and magic,
  skills from `model/skills.js`) shows **only in Game mode**. Its rules do not
  change. Flow may still retire it later, as Flow's spec plans.

## The baseline

The schedule score needs the plan as it was promised. Project Planner gains
Microsoft Project's **baseline**, whether Game mode is on or not.

- **Project ▸ Set baseline** saves, for every task, `baseline: { start,
  finish, work }` (work in hours, null when the task has none), plus
  `plan.baselineAt`. Setting it again replaces all of it, after the in-page
  confirmation "Replace the baseline set on <date>?".
- **Set baseline for selected tasks** saves only those tasks', for work added
  after the baseline.
- A task without a baseline is **unscored** and is left out of every game
  number, and the game panel says how many such tasks there are.
- **Clear baseline** removes it, with confirmation.
- The baseline is part of the plan: it is saved, synced and undoable like any
  edit, and it travels through the MS Project XML (MSPDI `Baseline` elements,
  number 0) both ways.
- The Gantt in either mode may draw the baseline as a thin bar under each task
  (a toggle, off by default).

## Milestone bosses

- **Every milestone is a boss.** Its **troops** are every task that leads to
  it through dependencies, transitively, leaving out summary tasks and other
  milestones.
- **HP** = the remaining work hours of its troops: `work × (1 − percent/100)`
  for each. **Max HP** is the troops' total work. A troop with no work counts
  one hour, so a plan without work estimates still has bosses.
- Finishing work on a troop is **damage**: the HP bar drops as percent
  complete rises.
- **Beaten** when HP reaches 0 and the milestone itself is done.
  - By its baseline finish: **beaten on time**, gold.
  - After it: **beaten late**, with the days late.
- **Late but still standing:** past its baseline finish with HP left, the boss
  turns red and shows "N days late". It can still be beaten. Nothing is lost.
- A milestone without a baseline is a boss with no date: it can be beaten,
  never on time or late.
- Days late count working days on the plan's calendar.

## The quest log

- The **main quest** is the critical path: the critical tasks in order of
  start. Its progress is the critical work done over the critical work total.
- **Side quests** are the tasks with slack, grouped under the boss they feed
  (or "unaligned" when they feed none).
- A side quest that becomes critical moves to the main quest, and back, as
  the schedule changes. The log follows the scheduler; it never stores its
  own copy.

## The schedule score

- A task scores when it is **finished** (100%; `doneAt` set) and has a
  baseline.
  - Finished by its baseline finish: **its baseline work hours** as points,
    **doubled when the task was critical** when it was finished.
  - Finished after it: **0**. A score never goes negative.
- "When it was finished" is recorded at the moment it reaches 100%:
  `scored: { points, critical, onTime }` on the task, written once, so later
  schedule changes cannot rewrite a past score. Reopening the task (below
  100%) removes it; finishing it again scores again.
- The plan's score is the sum. It is shown with the share of baselined work
  finished on time.

## The leaderboard

- One row per **work resource** with baselined work assigned.
- Ranked by **the share of their own assigned baselined work finished on
  time** — on-time hours over assigned hours — so part-timers and small
  assignments are not punished. Ties break on on-time hours.
- A resource with no finished baselined work shows "—" and sorts last.
- **Who sees it:** only a device with Game mode on. It never appears in a
  print, an image export, a CSV, the JSON file's view state or the MS Project
  file. It is computed on screen from the plan and stored nowhere.

## Flow

When a project's **last task finishes** (every leaf task at 100%), the plan
writes **one** result into Flow's sync workspace, the mirror of the
`flow.op` records Flow writes here:

`{ id, type: 'planner.result', plan, name, finishedAt, baselineFinish, onTime, daysLate }`

- That is Flow's **Deliverance** skill: its unit is a project, its meter is
  on time against the date given at kickoff (here, the baseline finish).
- It is written once per plan. Reopening a task and finishing again does not
  write a second result.
- A plan without a baseline writes `baselineFinish: null, onTime: null`, and
  Flow counts the unit without grading it.
- Nothing else goes to Flow. Flow's side is a separate change to Flow's spec.

## Screens (concept to agree before code)

- **Game panel** beside the Gantt (below it on a phone): the score, the main
  quest bar, and the next boss with its HP bar, date and state.
- **Bosses**: every milestone as a card (HP, troops left, baseline date,
  on time / late / beaten).
- **Quest log**: main quest and side quests, each line linking to its task.
- **Leaderboard**: the ranked rows above.
- **People**: the existing character sheet.
- States: no baseline yet (a prompt to set one), no milestones (no bosses,
  the quest log still works), all beaten (a finish screen), Game mode off
  (none of it shown).

## Open for the tests

All of the above was decided. The tests will pin down these details, chosen
here as the obvious reading; change any of them before the tests are written:

- "Critical when finished" uses the scheduler's `critical` at the moment of
  reaching 100%.
- A troop with no work counts as one hour of HP.
- Late days are working days on the plan calendar.
