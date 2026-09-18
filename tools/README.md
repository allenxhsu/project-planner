# tools

| File | What it is |
|---|---|
| `gantt-svg.mjs` | the Gantt chart as SVG from the command line, no browser |
| `mpp2xml.sh` | converts project files with MPXJ: `.mpp` in, Project XML out — or XML in, MPX / XER / Planner out |
| `setup-converter.sh` | downloads what `mpp2xml.sh` needs into `mpxj/` and `jre/` (not kept in git) |

## Microsoft Project files

`.mpp` is a proprietary binary format. [MPXJ](https://mpxj.org) (LGPL) reads
every version of it, plus MPX, Primavera XER and PMXML, Asta, GanttProject,
ProjectLibre and Planner files. **Nothing outside Microsoft Project writes
`.mpp`** — MPXJ included — so the app saves for Project as **Project XML**
(MSPDI), which Project opens directly (`File ▸ Open`, choose the XML) and then
saves as `.mpp` itself. Older Project versions and many other tools take MPX,
which the converter writes.

MPXJ is a Java library, so a runtime is bundled beside it (`jre/`, Temurin 21).
`serve.sh` calls the script for the browser; the macOS app calls it directly
and carries a copy of both inside its bundle.
