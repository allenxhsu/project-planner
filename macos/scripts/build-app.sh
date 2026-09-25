#!/bin/sh
# Build "Project Planner.app" from the Swift package and the web app beside it.
#
#   macos/scripts/build-app.sh            # release build into macos/build/
#   CONFIG=debug macos/scripts/build-app.sh
#
# NSDocument takes the document types it can open from Info.plist, so the app
# must run as a bundle: the bare executable cannot open or save plans.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$PKG/.." && pwd)"
CONFIG="${CONFIG:-release}"
# Out of the way of Spotlight. A bundle anywhere under ~/Documents is indexed
# and shows up in Launchpad and in search beside the installed copy — two
# Project Planners, one of them a build artifact. ~/Library/Caches is not
# indexed, and OUT_DIR still overrides this for anyone who wants it elsewhere.
OUT="${OUT_DIR:-$HOME/Library/Caches/ProjectPlanner/build}"
APP="$OUT/Project Planner.app"
VERSION="${VERSION:-1.0}"

# The vendored kit copies must match their sources before they are bundled.
# A kit that does not exist yet (or has no copy script yet) is skipped, not failed.
check_copy() {  # <kit dir> <copy-script args…>
  kit="$REPO/../$1"; shift
  if [ -f "$kit/scripts/copy-into.mjs" ]; then
    (cd "$REPO" && node "$kit/scripts/copy-into.mjs" --check "$@") || { echo "refresh the $kit copy first"; exit 1; }
  else
    echo "skipped: $kit has no scripts/copy-into.mjs yet"
  fi
}
check_copy ui-kit ui-kit
check_copy shell-kit src/host.js
[ -d "$REPO/sync-kit" ] && check_copy sync-kit sync-kit
# Pairing ends in a project://connect?… link that Launch Services delivers only
# to a bundle claiming the scheme.
URL_TYPES="$(node "$REPO/../shell-kit/scripts/url-types.mjs" project 'Project Planner')"

swift build --package-path "$PKG" -c "$CONFIG" --product ProjectPlanner
BIN_DIR="$(swift build --package-path "$PKG" -c "$CONFIG" --show-bin-path)"

mkdir -p "$OUT"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web"
cp "$BIN_DIR/ProjectPlanner" "$APP/Contents/MacOS/Project Planner"

# The Dock icon: the PJ badge the app wears in its own header. Rendered from
# macos/scripts/make-icon.mjs, then turned into the sizes macOS asks for.
if command -v node >/dev/null 2>&1; then
  node "$HERE/make-icon.mjs" "$OUT/icon.png" >/dev/null
  SET="$OUT/AppIcon.iconset"
  rm -rf "$SET" && mkdir -p "$SET"
  for size in 16 32 128 256 512; do
    sips -z $size $size "$OUT/icon.png" --out "$SET/icon_${size}x${size}.png" >/dev/null
    sips -z $((size * 2)) $((size * 2)) "$OUT/icon.png" --out "$SET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns"
  rm -rf "$SET"
else
  echo "no node: the app is built without its icon"
fi

# The web app, exactly as the browser gets it. Only what the page loads:
# the kit's build scripts, Swift theme and template stay behind.
WEB="$APP/Contents/Resources/web"
cp "$REPO/index.html" "$WEB/"
cp -R "$REPO/src" "$WEB/src"
mkdir -p "$WEB/ui-kit"
for part in css js fonts; do cp -R "$REPO/ui-kit/$part" "$WEB/ui-kit/$part"; done
[ -d "$REPO/sync-kit/js" ] && mkdir -p "$WEB/sync-kit" && cp -R "$REPO/sync-kit/js" "$WEB/sync-kit/js"

# The Microsoft Project converter: MPXJ and its Java runtime (about 180 MB),
# when tools/setup-converter.sh has fetched them. CONVERTER=0 leaves it out.
if [ "${CONVERTER:-1}" != 0 ] && [ -x "$REPO/tools/jre/Contents/Home/bin/java" ] && [ -f "$REPO/tools/mpxj/mpxj.jar" ]; then
  CONV="$APP/Contents/Resources/converter"
  mkdir -p "$CONV"
  cp "$REPO/tools/mpp2xml.sh" "$CONV/"
  cp -R "$REPO/tools/mpxj" "$CONV/mpxj"
  cp -R "$REPO/tools/jre" "$CONV/jre"
  echo "bundled the Microsoft Project converter"
else
  echo "no converter bundled (run tools/setup-converter.sh to read .mpp files)"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Project Planner</string>
  <key>CFBundleDisplayName</key><string>Project Planner</string>
  <key>CFBundleIdentifier</key><string>org.projectplanner.app</string>
  <key>CFBundleExecutable</key><string>Project Planner</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <!-- Sync talks to a server over plain HTTP when that server is on this
       machine or this network; App Transport Security blocks that by default. -->
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <!-- A plan file is plain JSON, as the web app writes it. Alternate
           rank: the app opens JSON when asked, but never claims all of it. -->
      <key>CFBundleTypeName</key><string>Project Plan</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>public.json</string></array>
      <key>NSDocumentClass</key><string>ProjectPlanner.ModelDocument</string>
    </dict>
    <dict>
      <!-- Microsoft Project XML opens as a new, untitled plan; it is never written back over. -->
      <key>CFBundleTypeName</key><string>Microsoft Project XML</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>public.xml</string></array>
      <key>NSDocumentClass</key><string>ProjectPlanner.ModelDocument</string>
    </dict>
    <dict>
      <!-- Microsoft Project's own files, read through MPXJ; never written. -->
      <key>CFBundleTypeName</key><string>Microsoft Project File</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>org.projectplanner.mpp</string></array>
      <key>NSDocumentClass</key><string>ProjectPlanner.ModelDocument</string>
    </dict>
    <dict>
      <key>CFBundleTypeName</key><string>Project Plan (other planners)</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>org.projectplanner.plan-import</string></array>
      <key>NSDocumentClass</key><string>ProjectPlanner.ModelDocument</string>
    </dict>
    <dict>
      <key>CFBundleTypeName</key><string>Task List (CSV)</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>public.comma-separated-values-text</string></array>
      <key>NSDocumentClass</key><string>ProjectPlanner.ModelDocument</string>
    </dict>
  </array>
  <key>UTImportedTypeDeclarations</key>
  <array>
    <dict>
      <key>UTTypeIdentifier</key><string>org.projectplanner.mpp</string>
      <key>UTTypeDescription</key><string>Microsoft Project File</string>
      <key>UTTypeConformsTo</key><array><string>public.data</string></array>
      <key>UTTypeTagSpecification</key>
      <dict><key>public.filename-extension</key><array><string>mpp</string><string>mpt</string></array></dict>
    </dict>
    <dict>
      <key>UTTypeIdentifier</key><string>org.projectplanner.plan-import</string>
      <key>UTTypeDescription</key><string>Project Plan (MPX, XER, PMXML, Planner, GanttProject, ProjectLibre)</string>
      <key>UTTypeConformsTo</key><array><string>public.data</string></array>
      <key>UTTypeTagSpecification</key>
      <dict><key>public.filename-extension</key><array><string>mpx</string><string>xer</string><string>pmxml</string><string>pod</string><string>gan</string><string>planner</string><string>pp</string><string>prx</string></array></dict>
    </dict>
  </array>
$URL_TYPES
</dict>
</plist>
PLIST
node "$REPO/../shell-kit/scripts/url-types.mjs" --check "$APP/Contents/Info.plist" project

# An ad-hoc signature, so macOS will launch a locally built bundle.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || codesign --force --sign - "$APP" >/dev/null
echo "$APP"
