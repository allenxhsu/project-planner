#!/bin/sh
# Convert between project file formats with MPXJ (https://mpxj.org), using the
# Java runtime bundled beside it:
#
#   tools/mpp2xml.sh plan.mpp plan.xml      # Microsoft Project → Project XML (MSPDI)
#   tools/mpp2xml.sh plan.xml plan.mpx      # the other way: MPX, Planner, XER, PMXML…
#
# The output format follows the output file's extension. MPXJ reads MPP, MPT,
# MPX, MSPDI XML, Primavera XER/PMXML, Asta, GanttProject, ProjectLibre, Planner
# and more; it writes everything except MPP (nothing outside Microsoft can).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
JAVA="$HERE/jre/Contents/Home/bin/java"
[ -x "$JAVA" ] || JAVA="$(command -v java || true)"
[ -n "$JAVA" ] || { echo "No Java runtime: expected tools/jre (see tools/README.md)" >&2; exit 2; }
exec "$JAVA" -Djava.awt.headless=true -cp "$HERE/mpxj/mpxj.jar:$HERE/mpxj/lib/*" org.mpxj.sample.MpxjConvert "$1" "$2"
