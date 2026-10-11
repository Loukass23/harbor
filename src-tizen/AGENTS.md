# src-tizen AGENTS.md

Samsung Tizen TV target for Harbor. The root `AGENTS.md` still applies; this file adds the
Tizen rules. Read `docs/lessons.md` before changing anything in this folder.

## Target

- Tizen 9.0+ (Chromium 120; reference TV GU43DU7199UXZG), packaged as a `.wgt` web widget loaded over `file://`.
- Same Big Picture UI as Android TV (`BpTvApp`). There is no Tauri and no Rust at runtime.
- Playback: `webapis.avplay` behind Harbor's `PlayerBridge`, with the HTML5 bridge as fallback.
- Optional companion (desktop Harbor or Stremio server on the LAN) for torrents and
  remote control (the TV applies no CORS, so no proxy is needed). The app must work without it.

## Boundary rule

- `src/` is shared with upstream Harbor and never imports `src-tizen/` or touches Tizen APIs
  (`webapis`, `tizen.*`, `tizenhwkey`, AVPlay). `pnpm check:tizen-boundary` enforces this.
- `src-tizen/` may import from `src/` via `@/`.
- When Tizen needs something from shared code, add a small **generic** seam in `src/`
  (a registry, setter or option) that any platform could use, then fill it from `src-tizen/`.
  Keep each seam in its own commit so it can be contributed upstream on its own.
- Never add `isTizen()` branches to shared code.

## Layout

- `main.tsx`: Tizen entry. Installs the platform, then calls `mountTvApp()` from `@/tv-mount`.
- `vite.config.ts`: Tizen build. Reuses the root config and `index-tv.html`, swaps in `main.tsx`,
  inlines `boot-watchdog.js` and fails the build on absolute paths or `crossorigin` on local assets.
- `boot-watchdog.js`: classic script that logs boot errors and shows them if nothing mounts in 30s.
- `platform/`: key registration, back and exit, lifecycle, `BpPlatform` implementation.
- `player/`: AVPlay `PlayerBridge`, codec capabilities, watchdogs.
- `net/`: companion discovery and pairing.
- `streams/`: platform score modifier.
- `config.xml.tpl`: manifest template, filled from `.env.tizen` at package time
  (`scripts/tizen-manifest.mjs`).
- `docs/`: lessons and integration notes. Committed.

## Commands

- `pnpm run check`, `pnpm run typecheck`, `pnpm test`, `pnpm check:tizen-boundary` after every change.
- Device pipeline (`scripts/tizen.mjs`): build, package, install, launch, logs, debug, simulator.
  See `docs/pipeline.md`.
  Settings come from `.env.tizen`; see `.env.tizen.example`.
- `pnpm build` and `pnpm build:tv` must still produce unchanged desktop and Android bundles.

## Working rules

- AVPlay changes need a real TV. The emulator only covers boot, UI and focus.
- Every AVPlay or key-handling fix gets a unit test with a `webapis`/`tizen` stub in
  `tests/tizen-*.test.ts`.
- When you learn a new platform quirk, add it to `docs/lessons.md` in the same commit.
- Don't port code from `origin/tizen-beta` or `beta-tizen` wholesale. Read it, apply the lessons, and rewrite it.
