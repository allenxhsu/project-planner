# Project Planner MCP

The planner as a set of tools Claude can call: list the plans, read a task
list with its schedule, ask what is due, and add, edit, link, move, assign
or delete tasks — from a Claude Code session, with the plan on screen
updating as each edit lands.

It is a sync device like the Mac or a browser tab. Every call pulls the
workspace first, so what it reads and edits is the newest copy anyone has
pushed; an edit goes through the same model functions the task list uses,
is written as the file format `File ▸ Save` writes, and is pushed. The
server announces the push on its change feed (`/sync/events`), the open
page pulls, and the plan on screen is replaced — unless the page holds
unsaved edits of its own, in which case it asks which to keep, exactly as
it does for any other device.

## Setting it up

1. **Install the SDK** once:

   ```bash
   cd mcp && npm install
   ```

2. **Mint a token.** On the Portal, open Devices and pair a new device
   named for this machine; copy the token it shows. (On a server you run
   yourself, any secret in its `SYNC_TOKENS` for the `project` workspace.)

3. **Register the server** with Claude Code, for every project you open:

   ```bash
   claude mcp add --scope user project-planner \
     -e PROJECT_SYNC_URL=https://<your-portal-host>/w/project \
     -e PROJECT_SYNC_TOKEN=<the token> \
     -- node /absolute/path/to/Project/mcp/server.mjs
   ```

   Or, for sessions opened in this repository only, set the two variables
   in your shell and `.mcp.json` here picks them up.

The device's copy of the workspace and its sync cursors live in
`~/.config/project-planner/mcp-store.db`, so each start pulls only what is
new. `PROJECT_MCP_STORE=memory` keeps nothing between starts.

## The tools

| Tool | What it does |
|---|---|
| `list_plans` | Every plan: name, id, tasks, start → finish, % done |
| `create_plan` | A new, empty plan: name, optional start date and working weekdays (Mon–Fri by default, `[0,6]` for weekends, all seven for every day); it becomes the plan later calls work on |
| `use_plan` | Choose the plan later calls work on; it is remembered for the session |
| `get_plan` | The task list with the schedule: row, name, duration, start, finish, deadline, %, slack, predecessors, resources |
| `find_task` | Which tasks a row number or name fragment means |
| `due_tasks` | Open tasks across every plan that finish, or have a deadline, in a date range (default today) |
| `checks` | The live checks: missed deadlines, negative slack, cycles, overallocation |
| `add_task` | A task at the end, right after a task, or as the last subtask of a summary |
| `edit_task` | Name, duration, work, percent, deadline, start (pins it), constraint, urgency, predecessors, resources, notes, `claude_scheduled`, `schedule` (the time blocks it is laid in, by name), `pin` (fix it to clock time on a day, e.g. `2026-11-09 09:00-13:00`) |
| `link_tasks` / `unlink_tasks` | A dependency: FS, SS, FF or SF, with a lag |
| `move_task` | Up, down, indent, outdent |
| `delete_task` | A task and everything under it |
| `assign_task` / `unassign_task` | A person on a task, at full time or a fraction |
| `add_event` / `list_events` / `delete_event` | Blocked time the work goes around (a trip, a ride day, a drive, an appointment): one day or a span, by clock time or all day; events on any plan count for the whole shelf |
| `sync_calendar` | The planner's layout on Google Calendar, one event per task per day on each plan's own calendar, two weeks out; a dry run by default, `dry_run: false` writes, `plan` narrows it to one plan, `days` sets the horizon. Setup below. |

A task is named by the **row number** the task list shows, or by its
**name** — exact, or a prefix or fragment that fits exactly one task. Two
candidates are an error that lists them; nothing is guessed. A plan is named
by its name, a unique part of it, or its id, once with `use_plan` or on every
call with `plan`.

Dates are `YYYY-MM-DD`. Durations are working days (`3`, `3d`, `2w`; `0d`
is a milestone); work is hours (`12h`). Predecessors and resources are typed
as in the task list: `3FS+2d, 5SS`, `Ana, Ben [50%]`.

## Google Calendar

`sync_calendar` (and `node mcp/gcal.mjs`) talk to the Calendar API with an
OAuth client of your own; nothing is installed.

1. In [Google Cloud](https://console.cloud.google.com/) pick or make a
   project, enable the **Google Calendar API**, and under *APIs & Services ▸
   Credentials* create an **OAuth client ID** of type **Desktop app**. If the
   consent screen is in testing, add the Google account as a test user.
2. Download the client's JSON and save it as
   `~/.config/project-planner/gcal-client.json`.
3. Sign in once; the browser opens, and the refresh token is kept at
   `~/.config/project-planner/gcal-token.json`:

   ```bash
   node mcp/gcal.mjs --auth
   ```

4. Map each plan to its calendar in `mcp/plan-calendars.json` (plan name →
   calendarId, as the calendar's settings page shows it). A plan that is not
   there is reported and skipped; nothing is created for it.

Then, with `PROJECT_SYNC_URL` and `PROJECT_SYNC_TOKEN` set as for the
server:

```bash
node mcp/gcal.mjs --dry-run            # what would change, nothing written
node mcp/gcal.mjs --apply              # write it
node mcp/gcal.mjs --apply --plan "ISEN 616" --days 7
```

The dry run prints the horizon, the counts, and one line per change: `+`
create, `~` update (with where it was), `↺` adopt a hand-made event, `✓` a
done task's event, `-` delete, then `no calendar:` for plans not in the map.

## Testing

```bash
node --test tests/mcp.test.mjs
```

runs the tools against the real sync server (`../sync-kit/server/dist`) on
an ephemeral port, with a second device standing in for the open page.
