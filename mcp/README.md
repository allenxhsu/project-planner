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
| `use_plan` | Choose the plan later calls work on; it is remembered for the session |
| `get_plan` | The task list with the schedule: row, name, duration, start, finish, deadline, %, slack, predecessors, resources |
| `find_task` | Which tasks a row number or name fragment means |
| `due_tasks` | Open tasks across every plan that finish, or have a deadline, in a date range (default today) |
| `checks` | The live checks: missed deadlines, negative slack, cycles, overallocation |
| `add_task` | A task at the end, right after a task, or as the last subtask of a summary |
| `edit_task` | Name, duration, work, percent, deadline, start (pins it), constraint, urgency, predecessors, resources, notes |
| `link_tasks` / `unlink_tasks` | A dependency: FS, SS, FF or SF, with a lag |
| `move_task` | Up, down, indent, outdent |
| `delete_task` | A task and everything under it |
| `assign_task` / `unassign_task` | A person on a task, at full time or a fraction |

A task is named by the **row number** the task list shows, or by its
**name** — exact, or a prefix or fragment that fits exactly one task. Two
candidates are an error that lists them; nothing is guessed. A plan is named
by its name, a unique part of it, or its id, once with `use_plan` or on every
call with `plan`.

Dates are `YYYY-MM-DD`. Durations are working days (`3`, `3d`, `2w`; `0d`
is a milestone); work is hours (`12h`). Predecessors and resources are typed
as in the task list: `3FS+2d, 5SS`, `Ana, Ben [50%]`.

## Testing

```bash
node --test tests/mcp.test.mjs
```

runs the tools against the real sync server (`../sync-kit/server/dist`) on
an ephemeral port, with a second device standing in for the open page.
