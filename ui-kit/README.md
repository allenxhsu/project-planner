# ui-kit

The shared interface for the toolkit apps: **Heptabase**, **IDEF0**, **Pyramid** and
**Metropolis**. It gives them one sci-fi HUD look, with brushed-metal panels,
chamfered controls, lit edges, corner brackets and HUD typography. The same kit
works whether an app is built with React, plain HTML, or SwiftUI.

```
ui-kit/
  tokens/tokens.json     single source of truth: palettes, fonts, spacing, app colours
  scripts/build-tokens.mjs  regenerates css/tokens.css + swift/SCTheme.swift
  css/kit.css            one stylesheet: fonts + tokens + base + components
  js/theme.js            runtime: skin, palette, effects (no dependencies)
  js/theme-picker.js     <sc-theme-picker> — the same appearance controls everywhere
  adapters/              map each existing app's own CSS variables onto the kit
  swift/SCTheme.swift    the same palette for SwiftUI apps
  fonts/                 Orbitron, Exo 2, Share Tech Mono (OFL, bundled for offline)
  template/              starter app shell + live gallery of every component
```

See it:

```bash
cd /Users/allenxu/Documents/ClaudWorkSpace/ui-kit && python3 -m http.server 8130
```

Then open <http://localhost:8130/template/>.

---

## How it switches on

Nothing on a page changes until `<html>` carries `data-sc`. `js/theme.js` manages
four attributes, and all the CSS keys off them:

| Attribute | Values | Effect |
| --- | --- | --- |
| `data-sc` | present / absent | HUD skin on, or the app's own classic styling |
| `data-race` | `steel` `crystal` `chitin` | Palette |
| `data-app` | `heptabase` `idef0` `pyramid` `metropolis` | The app's identity colour (`--sc-app`) |
| `data-sc-effects="off"` | | Removes the scanlines and glow overlays |

Every app shows appearance preferences through the same `<sc-theme-picker>` and
stores them under `ui-kit.*` in localStorage. Apps served from the same origin
therefore share one choice.

**Palettes**

| | Panels | Accent | Secondary |
| --- | --- | --- | --- |
| Steel (default) | brushed steel | cyan | amber |
| Crystal | deep crystal blue | bright cyan | warm gold |
| Chitin | dark chitin | violet | acid orange |

The palettes use neutral names on purpose. The look is inspired by sci-fi
strategy-game HUDs, but options and labels shouldn't use any game's faction
names or other trademarks. Values stored under the kit's first names migrate
automatically.

**App identity colours** are the same ones Metropolis already uses for its sources.
A Heptabase object is purple in Metropolis, and so is Heptabase's own brand badge.

---

## Adopting it

### A single-file app with no filesystem access (Pyramid)

Pyramid (`ClaudWorkSpace/../Pyramid`, or wherever its own repo lives — see its
own README) ships as one self-contained HTML file, published two ways: as a
Claude artifact and as a native macOS app that bundles the page at build time.
Neither host can `<link>` a sibling folder, so the usual adoption paths below
don't apply. Instead Pyramid inlines a verbatim copy of `tokens.css` +
`base.css` + `components.css` + `adapters/pyramid.css` directly into its own
`<style>` blocks, and a plain (non-module) port of `theme.js`'s logic into its
own `<script>` — same localStorage keys (`ui-kit.*`), same `data-sc` /
`data-race` / `data-app` / `data-sc-effects` attribute contract, same
`ui-kit:change` event, just no `import`. `adapters/pyramid.css` here stays the
canonical source; re-copy it into Pyramid's HTML by hand when it changes.

**The one gotcha this ran into:** Pyramid's own dark-mode selectors
(`:root:not([data-theme="light"])`, `:root[data-theme="dark"]`) sit at CSS
specificity (0,0,2,0). A naive `html[data-sc] { --accent: var(--sc-accent); }`
adapter block is only (0,0,1,1) and silently loses that fight — the custom
properties never actually change and nothing looks wrong until you inspect
computed styles. Any adapter for an app with its own `:root`-level dark-mode
rules should write its token remap as `:root[data-sc] { … }` to match or beat
that specificity, not `html[data-sc]`.

### An existing no-build app (IDEF0, Metropolis)

Add the kit and the app's adapter. Nothing in the app's own CSS has to change:

```html
<link rel="stylesheet" href="../ui-kit/css/kit.css">
<link rel="stylesheet" href="../ui-kit/adapters/idef0.css">
<script type="module">
  import { initTheme } from '../ui-kit/js/theme.js';
  initTheme({ app: 'idef0' });
</script>
```

The adapter maps the app's existing variables (`--ink`, `--panel`, `--accent`, …)
onto kit tokens, so every existing screen restyles at once. From there, screens
can move to `sc-*` components one at a time. Removing `data-sc` shows the
original look again at any point.

Notes:
- **IDEF0:** the adapter themes the on-screen diagram sheet dark. Before shipping,
  confirm that SVG/PNG/PDF export sets its own sheet colours and doesn't read
  `--sheet`.
- **Metropolis** (folder `MindMap/`): its Node server needs to serve the `ui-kit`
  folder, or a copy can go under `app/ui/`. Metropolis already has its own HUD
  skin in `app/ui/styles.css`. On adoption, trim it to Metropolis-only shapes, or
  it will fight the adapter over the same variables. The adapter leaves the source
  colours (`--osm`, `--str`, `--yt`) and the validated chart palette (`--viz-*`) untouched.

### A bundled app (Heptabase)

```bash
npm install ../ui-kit
```

```ts
import { initTheme, detectMacDesktop } from 'ui-kit/theme';
import 'ui-kit/theme-picker';
import 'ui-kit/css/kit.css';
import 'ui-kit/adapters/heptabase.css';

initTheme({ app: 'heptabase', macInset: detectMacDesktop() });
```

With Vite, allow the linked folder: `server: { fs: { allow: ['..'] } }`.
Heptabase adds `src/theme/hud.css` for shapes that are specific to its own
components, such as whiteboard cards and section plates.

### A SwiftUI app (IDEF0 macOS, Habit, HomeOrg)

Add `swift/SCTheme.swift` to the target:

```swift
@AppStorage("ui-kit.race") var race: SCRace = .steel

var body: some View {
  content
    .foregroundStyle(race.palette.text)
    .background(race.palette.bg)
    .tint(race.palette.accent)
}

Text("WORKSPACE").font(SCFont.display(11, weight: .semibold))
```

Bundle the TTF versions of Orbitron, Exo 2 and Share Tech Mono (Google Fonts, OFL).
The woff2 files in `fonts/` only work on the web.

---

## Components

All classes use the `sc-` prefix. Stateful classes use `is-` (`is-active`,
`is-collapsed`). The gallery in `template/` renders every one of these.

| Area | Classes |
| --- | --- |
| Shell | `sc-shell` `sc-sidebar` `sc-titlebar` `sc-brand` `sc-brand-mark` `sc-nav` `sc-nav-item` `sc-nav-icon` `sc-sidebar-foot` `sc-main` `sc-header` `sc-header-title` `sc-content` |
| Surfaces | `sc-panel` (`--raised` `--glass` `--lit`) `sc-card` `sc-brackets` (`--hover`) `sc-chamfer` `sc-hexgrid` `sc-starfield` |
| Controls | `sc-button` (`--primary` `--ghost` `--danger` `--icon` `--sm`) `sc-input` `sc-select` `sc-textarea` `sc-check` `sc-field` |
| Navigation | `sc-tabs` `sc-tab` `sc-list-item` `sc-menu` `sc-menu-item` `sc-menu-sep` |
| Data | `sc-table` `sc-badge` (`--alert`) `sc-pill` `sc-resource` (`--alt`) `sc-meter` `sc-kbd` |
| Feedback | `sc-alert` (`--warning` `--danger` `--success`) `sc-overlay` `sc-dialog` `sc-dialog-head` `sc-dialog-body` `sc-boot` |
| Type | `sc-display` `sc-label` `sc-section-title` `sc-mono` `sc-glow-text` `sc-muted` `sc-faint` |

Colouring a single instance: `sc-pill`, `sc-nav-icon` and `sc-alert` read `--tint`,
so `style="--tint: var(--sc-accent-2)"` recolours just that element.

### Tokens

Use variables, never raw colours, so all three palettes work:

- surfaces: `--sc-void` `--sc-bg` `--sc-panel` `--sc-panel-2` `--sc-raised` `--sc-sunken`
- lines: `--sc-line` `--sc-line-strong`
- text: `--sc-text` `--sc-text-2` `--sc-text-3`
- accents: `--sc-accent` `--sc-accent-2` `--sc-glow` `--sc-app`
- status: `--sc-danger` `--sc-warning` `--sc-success` `--sc-info`
- alpha: every colour also has an `-rgb` triplet, e.g. `rgb(var(--sc-accent-rgb) / 0.2)`
- fonts: `--sc-font-display` `--sc-font-ui` `--sc-font-mono`

To change a colour, edit `tokens/tokens.json` and run `npm run tokens` (or
`node scripts/build-tokens.mjs`). Never hand-edit `css/tokens.css` or
`swift/SCTheme.swift`.

---

## Rules that keep the apps consistent

1. **Pressable things are chamfered, and framing things get brackets.** Don't
   round corners.
2. **Orbitron is for labels, buttons and headings only.** Anything read at
   length (notes, descriptions, table cells) uses Exo 2.
3. **One glowing element per region.** The active item and the primary action
   glow; nothing else does.
4. **Status colours carry meaning.** Don't use `--sc-danger` for decoration.
5. **Keep the effects subtle.** Scanlines stay at their opacity, and everything
   decorative respects `data-sc-effects="off"` and `prefers-reduced-motion`.
