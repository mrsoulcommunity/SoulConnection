# CLAUDE.md

Guidance for AI assistants working in this repository.

## What this is

**Soul Connection** — a Windows desktop V2Ray/Xray client built with Electron + React.
It wraps a bundled `xray.exe` and manages everything around being connected: profile
parsing (VMess/VLESS/Reality/Trojan/Shadowsocks/SOCKS), subscriptions, a SOCKS/HTTP local
proxy, a system-level TUN tunnel, Windows system-proxy configuration, a firewall kill
switch, per-app/domain routing, anti-DPI tuning, health monitoring with automatic
failover, and self-updating.

Two things shape almost every decision in the codebase:

- **Windows-only.** Routes, the registry, `netsh`, Wintun, NSIS. The app cannot run on
  Linux/macOS — but the unit tests can (see [Testing](#testing)).
- **The UI is Persian and RTL.** `index.html` is `lang="fa" dir="rtl"`. Every
  user-facing string — in the renderer *and* in thrown `Error` messages from the main
  process — is Persian. Code, comments, identifiers and commit messages are English.

## Commands

| Command | What it does | Runs here? |
| --- | --- | --- |
| `npm test` | `node --test test/*.test.cjs` — 98 tests, no deps, no network | ✅ yes |
| `npm run build:ui` | Vite build of the renderer into `dist/` | ✅ yes |
| `npm run dev` / `npm start` | `vite build` then `electron .` | ❌ needs Windows + `bin/` |
| `npm run dist` | `release/setup.exe` — one NSIS installer carrying x64 + ia32 | ❌ Windows |
| `npm run dist:portable` | single-file portable x64 `.exe` | ❌ Windows |
| `npm run dist:publish` | `dist` + publish to GitHub Releases (needs `GH_TOKEN`) | ❌ Windows |

There is **no linter and no formatter** configured. Match surrounding style by hand.

`npx vite` (dev server, port 5173 — see `.claude/launch.json`) runs the renderer in a
plain browser: `src/main.jsx` installs `src/devMock.js` as a fake `window.soul` when
`import.meta.env.DEV && !window.soul`. This is the only way to iterate on UI without
Windows. **When you change the IPC surface, update `devMock.js` too** or the browser
harness silently diverges from the real app.

`bin/` (xray.exe, wintun.dll, geoip.dat, geosite.dat), `dist/`, `release/` and
`node_modules/` are gitignored and absent from a fresh clone. Anything that needs them
cannot be verified in this environment — say so rather than guessing.

## Layout

```
electron/            main process (CommonJS, .cjs, 'use strict')
  main.cjs           the Electron shell: window, tray, IPC, profiles, subs, settings
  preload.cjs        the entire contextBridge surface (window.soul)
  vpn/               THE VPN CORE — everything about being connected
  lib/               leaf mechanics: one concern per file/folder
src/                 renderer (ESM, .jsx/.js, React 18)
  App.jsx            root component; owns nearly all renderer state
  components/        one file per screen/panel; default export, PascalCase
  finder/            Server Finder's test-batch engine (module-level store)
  utils/             pure helpers: format, geo, ping shape, score, session
  index.css          the entire stylesheet (~4.7k lines), CSS variables on :root
test/                node:test suites, all targeting electron/vpn/*
scripts/build-exe.cjs the packaging pipeline
soul server.txt      the curated Soul pool, fetched at runtime from raw.githubusercontent
README.{en,fa,ru}.md three-language README set behind README.md's picker
```

## Architecture

```
React renderer (sandboxed, nodeIntegration off, CSP in index.html)
        │  window.soul  ──  electron/preload.cjs  (contextBridge only)
        ▼
main.cjs ── shell concerns ── createVpnCore() ──► VpnCore  (electron/vpn/)
        │                                            │
        │                                     spawns xray.exe
        └── lib/{store,parsers,update,shield,soulPool,routing,health}
```

### The VPN core (`electron/vpn/`) — read `electron/vpn/README.md` first

Connecting is not one action; it's a process, a routing dispatcher, a network adapter with
routes, the Windows proxy config, a firewall block, three measurement loops and a failover
engine that all have to agree. That coordination used to be ordering rules scattered
across `main.cjs`, and it had races. It now lives behind three ideas:

- **session** (`session.cjs`) — one frozen value describing the live tunnel, with an
  identity. "Is this still the tunnel I was looking at?" is always `a.id === b.id`.
  Every subsystem *follows* the session, so re-broadcasting changes nothing.
- **state machine** (`machine.cjs`) — legal transitions only; illegal ones are refused,
  not applied. An `epoch` marks each attempt so a late result can be discarded.
- **activity** (`machine.cjs`) — the one cancellable span of long work (a selection
  sweep, a reconnect countdown). At most one exists; starting another cancels the first.
  This is what makes "the user pressed disconnect" reliably stop work that hasn't reached
  the connection lock yet.

Two rules hold this together and must not be broken:

1. **`core.cjs` builds nothing.** Every collaborator arrives through the constructor.
   That is what makes ordering, cancellation and rollback testable with no Windows, no
   xray and no network.
2. **`index.cjs` is the only composition root.** It is the only file that knows which
   implementation is the real one. Nothing outside `vpn/` constructs anything from `vpn/`;
   `main.cjs` calls `createVpnCore()` once and consumes the object.

Supporting files: `tunnel.cjs` (xray + dispatcher + routes up/down, in order, with
rollback), `ports.cjs` (the whole port layout allocated in one pass — collisions
impossible by construction), `endpoints.cjs` (probe vs system-proxy vs local-proxy targets
— getting these mixed up produces measurements that are confidently wrong),
`routingPlan.cjs`, `telemetry.cjs`, `tunnelStatus.cjs`, `killSwitchGuard.cjs`,
`reconnect.cjs`, `dispatcherHost.cjs`.

### `electron/lib/` — the leaf mechanics

| Path | Concern |
| --- | --- |
| `store.cjs` | crash-safe JSON store: tmp + fsync + `.bak` snapshot + atomic rename; a damaged file falls back to the backup and is quarantined, never overwritten |
| `parsers.cjs` | link → profile for every supported protocol, plus subscription decoding |
| `xrayConfig.cjs` | the xray config builder (inbounds, outbounds, TUN, DNS, shield splice) |
| `xrayProcess.cjs` | xray's lifetime, its log stream |
| `routing/` | Smart Routing. `rules.cjs` is **pure** and is the single source of rule semantics for both consumers: `dispatcher.cjs` (per-connection, hot path) and `xrayRouting.cjs` (declarative, ahead of time). They must answer identically. |
| `health/` | `monitor.cjs` measures (active tunnel + backup candidates), `failover.cjs` decides. Measurement and policy stay split; failover emits an *intent* and the caller performs the reconnect. |
| `shield/` | Adaptive Shield: `profiles.cjs` is the catalogue of anti-DPI treatments, `tuner.cjs` measures which one this network needs, `index.cjs` remembers the answer keyed by a hashed network fingerprint |
| `update/` | feed → resumable download → SHA-512 verify → installer; one immutable status snapshot per change, pushed to the renderer |
| `soulPool.cjs` | the curated pool, kept out of `profiles`; two-stage funnel (cheap TCP fan-out, then real tunnels through the best few) |
| `systemProxy*.cjs`, `killSwitch.cjs`, `tunNetwork.cjs`, `elevation.cjs` | the Windows-facing edges |

## Conventions

### IPC

- Channels are `domain:verb` — `profiles:list`, `connection:connect`, `routing:saveRule`.
  Push channels are kebab-case nouns — `state-changed`, `traffic-update`, `soul-progress`.
- **Every renderer→main call goes through `preload.cjs`.** Nothing else is exposed;
  `nodeIntegration` is off and the renderer is sandboxed. Adding an endpoint means editing
  `preload.cjs`, `main.cjs`, and `src/devMock.js`.
- Subscription helpers (`onXxx(cb)`) **return an unsubscribe function**. Follow that shape.
- Handlers signal failure by **throwing an `Error` with a Persian message** — it arrives at
  the renderer as a rejected `invoke()` and is shown to the user verbatim. Success returns a
  plain object or the settled value.
- Handlers push state changes rather than making the renderer poll: `sendState()`,
  `sendToWindow(channel, payload)`.

### Settings

`DEFAULT_SETTINGS` in `main.cjs` is both the defaults **and** the whitelist —
`settings:update` drops any key not in it and type/range-validates the rest against the
`BOOLEAN_SETTINGS` / `PORT_SETTINGS` / `RANGED_SETTINGS` / mode-set tables just above the
handler. Adding a setting means: `DEFAULT_SETTINGS` → the matching validation set → a
control in `SettingsView.jsx` (or `NetworkSettings.jsx`) → `devMock.js`'s copy of
`DEFAULT_SETTINGS`. Anything read via `getSettings()` inside `vpn/` is read *live*, so a
change takes effect on the next connect/drop without a restart — preserve that.

The routing rule list lives under its own store key (`routingRules`), not in `settings`:
it's a growing user-edited collection, and the settings whitelist has nothing useful to say
about it. Store keys in use: `profiles`, `subscriptions`, `settings`, `activeProfileId`,
`connectionMode`, `activeMode`, `routingRules`, `soulProfiles`, `soulModeEnabled`,
`soulLastWinner`, `soulProfilesFetchedAt`, `shieldManualKey`, `systemProxy*`.

### Renderer

- Plain JSX, no TypeScript, no CSS framework, no component library. Hand-written CSS in
  `src/index.css` driven by `:root` variables (`--signal` teal = connected, `--idle` rose
  = disconnected). Reuse existing variables and class names instead of adding colors.
- Components: default export, PascalCase file name, props destructured in the signature,
  `React.memo` on the ones that re-render on every telemetry tick (`ConnectHero`,
  `ServerList`, `StatusBar`, `SoulPoolEntry`).
- Settings screens are built from `components/settingsPrimitives.jsx`
  (`Section`, `Toggle`, `SelectField`, `PortField`, `TextField`, `PasswordField`) and are
  searchable through `SettingsFilterContext` — a new card is found automatically by the
  text it renders, so **don't** maintain a keyword list. Persian/Arabic spelling and digit
  folding lives in `normalizeSearch()`.
- Icons come from `components/Icon.jsx` (2px stroke, rounded caps). Add a path there
  rather than inlining an SVG or using an emoji.
- `App.jsx` holds the state; components are presentational and take callbacks. `phase` (a
  renderer-side folding of `connectionState` plus in-flight IPC) is what the hero and
  sidebar render — not the raw main-process state.
- localStorage keys are versioned and namespaced: `soul.session.v1`,
  `soul.finder.results.v1`. Always `try/catch` around access (quota / private mode).
- Numeric/latin runs inside RTL text use `className="mono"` (it forces `direction: ltr`
  and tabular numerals). The titlebar is deliberately `direction: ltr` for Windows layout.

### Code style

- `electron/**` is CommonJS `.cjs`, starts with `'use strict'`, `require` at the top.
  `src/**` is ESM. Do not mix.
- 2-space indent, single quotes, semicolons, trailing commas in multiline literals.
- **Comments explain *why*, at length, and this is the house style — match it.** Most
  non-trivial files open with a prose header describing the failure mode the design exists
  to prevent (see `vpn/machine.cjs`, `vpn/ports.cjs`, `vpn/endpoints.cjs`,
  `lib/shield/profiles.cjs`). When you change one of those designs, update its header;
  when you fix a subtle bug, leave the explanation behind. Don't add comments that restate
  the code.
- Commit messages are a sentence describing the outcome, no prefix, no scope tag:
  *"Make the tunnel restart after it is killed from outside"*, *"Rebuild the VPN as a core
  with one lifecycle, and fix the races that hid in the old one"*.

## Testing

`npm test` runs `test/*.test.cjs` on Node's built-in runner — no dependencies, no
Windows, no network, no xray. Coverage is the coordination layer: `core`, `machine`,
`tunnel`, `ports`, `endpoints`, `routingPlan`, `reconnect`, `telemetry`,
`killSwitchGuard`, `xrayConfig`, `xrayProcess`.

Tests build a `VpnCore` from hand-written fakes (`makeCore()` in `test/core.test.cjs`) and
assert on an ordered `calls` array — so they pin *ordering, cancellation and rollback*,
which is where the historical bugs lived. **Keep new coordination logic injectable**; if a
change to `vpn/` cannot be tested without Windows, the dependency is in the wrong file.

Renderer code and `lib/` OS edges have no automated tests. Verify those by reasoning and
by running the Vite dev harness where possible, and say plainly what you could not verify.

## Gotchas

- **Elevation.** TUN mode and the kill switch require admin. `main.cjs` notifies, then
  calls `relaunchElevated()` — which exits the process, so code after it is unreachable in
  practice (the `return` is there for clarity).
- **Ports are preferences, not facts.** `settings.socksPort`/`httpPort` are *preferred*;
  `vpn/ports.cjs` bumps past anything bound. Read the live session's ports, never the
  settings, when you need the port something is actually listening on.
- **Probe ≠ public port.** With Smart Routing's dispatcher in front, the public port may
  legitimately answer a probe *directly* — reporting the user's real IP as the tunnel's.
  Always go through `vpn/endpoints.cjs`.
- **Packaging is defensive on purpose.** `scripts/build-exe.cjs` retries the NSIS build and
  has a repair path for antivirus dropping files mid-copy, and it fails loudly if
  `app.asar` predates the run (stale app code would otherwise ship silently). Don't
  "simplify" those guards away. `nsis.warningsAsErrors: false` is deliberate — makensis
  warns about any artifact literally named `setup.exe`, and that name is a product decision.
- **The installer is dual-arch, the portable build is x64-only.** Intentional: a portable
  exe has no installer step that could pick a payload.
- **Portable data lives next to the exe.** `PORTABLE_EXECUTABLE_DIR` switches the store to
  `data\profiles.json`; the installed build uses `%APPDATA%\soul-connection\profiles.json`.
- **Profiles are irreplaceable user data.** Any change to `store.cjs`'s write path must keep
  the tmp → fsync → `.bak` → rename sequence and the quarantine-on-corruption behavior.
- **`soul server.txt` is live data**, fetched by `soulPool.cjs` from `main` on GitHub.
  Editing it changes what shipped clients connect to.
