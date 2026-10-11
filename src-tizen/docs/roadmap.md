# Tizen roadmap

## Context

There have been three attempts at a Tizen app:

- **`origin/tizen`:** an early "init" attempt that is now 651 commits behind.
- **`origin/tizen-beta`:** 75 commits, including a 2,333-file merge, scattered `isTizen()` checks, a hardcoded LAN IP and a "thin shell" mode.
- **`beta-tizen`:** the cleanest of the three (95 files). It moved toward plug-in modifiers, but it still edits shared player and scoring code.

Some important fixes were never committed. They live only in the gitignored `plan.md`, `walkthrough.md` and in stashes. Across the three attempts the build target and `required_version` kept changing: es2015 → esnext → chrome87, and 2.3 → 8.0 → 2.3.

The goal is a Tizen app that:

1. Follows beta-branch with cheap, routine merges.
2. Keeps every change to shared code small and generic enough to contribute upstream.
3. Is designed around Tizen's limits from day one: no native backend, a CORS-bound webview, AVPlay quirks, remote-only input, and limited memory.

### Decisions

- **Oldest supported TV:** Tizen 7.0 (2022 TVs, Chromium 94). This allows `required_version="7.0"` and the existing `chrome87` target, so the TV bundle is the same one Android TV ships.
- **Companion:** optional. The app works on its own with debrid/HTTP addons and a remote Stremio server URL. A desktop Harbor or Stremio server found on the LAN adds torrents, a CORS proxy and remote control.
- **Layout:** in-tree `src-tizen/` on a new branch cut from `beta-branch`. Nothing is merged from the old Tizen branches; code is cherry-picked or ported only after review.

### What we start from

- **TV UI already exists.** `index-tv.html` → `src/main-tv.tsx` → `BpTvApp` (Big Picture, the 10-foot UI). It has its own spatial focus system in `src/views/big-picture/bp-focus-core.ts`, `bp-back.ts` and `use-bp-focus.ts`.
- **Most logic runs without Tauri.** Stremio API, addons, library and auth are TypeScript (`src/lib/stremio.ts`, `src/lib/addons.ts`). Stream ranking has a JS path in `src/lib/streams/pipeline.ts`. Settings and secrets fall back to localStorage/IndexedDB.
- **Existing seams:**
  - `BpPlatform` / `setBpPlatform()` in `src/views/big-picture/bp-platform.ts`. Nothing calls it yet.
  - The `PlayerBridge` contract in `src/lib/player/bridge.ts`, with an HTML5 implementation in `src/lib/player/html5/`.
  - `src/lib/platform.ts`, which provides `osClass()`, `isAndroidTv()` and `isWeb()`.
- **Gaps:**
  - About 449 `invoke` command names and around 420 local `isTauri` checks.
  - On the web path, `safe-fetch.ts` falls back to plain `fetch`, so CORS-blocked hosts fail.
  - No handling for keyCode 10009 or `tvinputdevice`.
  - `harbor-core` builds to WASM in CI, but the TypeScript app doesn't use it.

## Architecture

```
src/                  shared app (upstream). Never imports src-tizen or mentions Tizen
  tv-mount.tsx        NEW: mountTvApp() pulled out of main-tv.tsx (upstreamable)
  ...seams            small, generic registration points (see below)
src-tizen/            Tizen-only; may import from src/ via @/
  AGENTS.md, CLAUDE.md  Tizen rules for humans and AI
  config.xml.tpl      manifest template (id, version, privileges, required_version=7.0)
  main.tsx            entry: installTizenPlatform() → mountTvApp()
  platform/           bp-platform impl, key registration, lifecycle, device caps
  player/             avplay-bridge.ts (implements PlayerBridge), codec caps, watchdog
  net/                companion discovery and pairing, fetch proxy resolver
  streams/            platform score modifier (DV, DTS, TrueHD penalties)
  docs/               lessons.md, avplay.md, pipeline.md (committed: whitelist in .gitignore)
scripts/tizen.mjs     build | package | install | launch | logs | debug | seed
tests/tizen-*.test.ts unit tests with webapis/tizen stubs
```

### Rules

- **Inversion of control.** `src/` exposes registries; `src-tizen/` fills them at boot. No `isTizen()` checks inside `src/`. This is what keeps beta-branch merges easy and the seams upstreamable.
- **Enforced boundary.** A new `pnpm check:tizen-boundary` script fails if anything under `src/` imports `src-tizen` or uses `webapis`, `tizen.` or `avplay`. It runs in CI and via a Claude hook.

### Seams to add in `src/`

Each one is generic, small and its own PR-able commit:

| Seam                                                              | Location                                               | Purpose                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------- |
| `mountTvApp()`                                                    | split out of `src/main-tv.tsx`                         | a second entry can boot the same app                             |
| Player engine registry, `registerPlayerEngine("avplay", factory)` | next to `src/lib/player/bridge.ts` / `html5.ts`        | AVPlay plugs in without editing the player hooks                 |
| Extra back keys and key-registration hook                         | `src/views/big-picture/bp-back.ts`, `bp-player-key.ts` | 10009 → back, colour and media keys                              |
| `setFetchProxy(resolver)`                                         | `src/lib/safe-fetch.ts` (non-Tauri path)               | send CORS-blocked hosts through the companion when it is present |
| Configurable Stremio server URL                                   | `src/lib/stremio-server.ts`                            | remote or companion server instead of `127.0.0.1:11470`          |
| `setPlatformScoreModifier()`                                      | `src/lib/streams/scoring/`                             | the pattern from beta-tizen c62096b5; shared scorer untouched    |
| `BpPlatform`                                                      | existing `setBpPlatform`                               | `lanAddress`, `fetchImageBytes` through the companion or `fetch` |

## Lessons to encode as rules (`src-tizen/docs/lessons.md` + `src-tizen/AGENTS.md`)

**Boot and packaging**

- Vite `base: "./"`, with no absolute paths and no `crossorigin` attributes, because the app loads over `file://`.
- Keep a boot watchdog.
- The package id must be 10 alphanumeric characters. The TV's DUID must be in the distributor certificate. Signing settings come from `.env.tizen` (gitignored), never from committed files.

**Input**

- Register keys through `tizen.tvinputdevice`.
- Back arrives as both `tizenhwkey` and keydown 10009. Use a single source with a 250ms debounce.
- Exit only via `tizen.application.getCurrentApplication().exit()` at the root.

**AVPlay**

- Properties can only be set in the IDLE state.
- The display rect uses physical panel pixels.
- Use transparent containers via `html.harbor-avplay`.
- Never call `setSelectTrack("TEXT")`; subtitles use the DOM overlay.
- Never send a HEAD request before `open()`.
- Don't combine `BUFFER_SIZE` with `setBufferingParam`.
- Wrap `prepareAsync` in a 30s watchdog.
- Call `suspend()`/`restore()` on `visibilitychange`.
- `duration` reads 0 at start, so wait before the resume seek.
- Fall back to the HTML5 bridge on failure.

**Codecs**

- Penalise Dolby Vision without an HDR10 fallback, DTS and TrueHD.
- Prefer DD+, AAC and HEVC/AV1.

**Memory**

- Virtualised rows and translate3d-only navigation.
- Exclude desktop-only modules from the Tizen graph: games, music, face detection, onnx, mediapipe.

**Process**

- Commit fixes; never leave them only in ignored notes.
- No mega-merges: merge `beta-branch` in small steps, with the boundary check run on every merge.

## Development phases

Each phase is a separate session or worktree, with its own PR into the Tizen branch.

0. **Setup and hygiene**
   - Branch `tizen-next` cut from `beta-branch` (`origin/tizen` is the stale first attempt).
   - Fix the placeholder `allowBuilds` entries in `pnpm-workspace.yaml`.
   - Move `plan.md`/`walkthrough.md` findings into `src-tizen/docs/lessons.md`, and whitelist `src-tizen/**/*.md` in `.gitignore`.
   - Install Tizen Studio CLI (`tz`, `sdb`) and a certificate profile, and add `.env.tizen.example`.
1. **Shell and pipeline**
   - Add a Vite `tizen` mode (`base: "./"`, target `chrome87`, entry `src-tizen/index.html` → `src-tizen/main.tsx`, outDir `src-tizen/dist` (already gitignored)).
   - Add the `config.xml` template and `scripts/tizen.mjs`, porting the useful parts of `beta-tizen:scripts/tizen-pipeline.mjs`.
   - Add the `mountTvApp()` seam.
   - **Done when:** the app boots to the home row on the TV.
2. **Input and lifecycle**
   - Key registration, back/exit, and `visibilitychange`.
   - Add the boundary check and its CI step.
3. **Network**
   - Fetch proxy resolver, Stremio server URL setting, `BpPlatform` implementation.
   - Standalone flow verified with a debrid addon.
4. **AVPlay player**
   - Add `src-tizen/player/avplay-bridge.ts` implementing `PlayerBridge`, ported from `beta-tizen:src/lib/player/tizen-avplay.ts` with every lesson applied.
   - Add the engine registry seam and the score modifier.
   - Write unit tests with a `webapis` stub.
5. **Performance pass**
   - Set a bundle and heap budget, measured over CDP (reuse `docs/measure-tv.sh`).
   - Lazy-load or exclude heavy modules; add `check:tizen-budget`.
6. **Companion (optional features)**
   - LAN discovery via HTTP sweep (`network.public` privilege), with pairing by code or QR.
   - Torrents through the companion's Stremio server.
   - Settings import from desktop/phone instead of typing on the remote.
   - Requires a small upstream endpoint in `src-tauri/src/web_server.rs`.
7. **CI and release**
   - Workflow that builds an unsigned `.wgt` and runs `tests/tizen-*`.
   - Signed builds stay local.
8. **Upstream**
   - Offer each `src/` seam as a standalone PR to `harborstremio/harbor`, then the `src-tizen/` folder as an optional target.

## AI development configuration

Committed unless marked local:

1. **`src-tizen/AGENTS.md`, plus `src-tizen/CLAUDE.md` containing `@AGENTS.md`**
   - Covers Tizen constraints, the lessons above, the boundary rule and per-task commands.
   - Claude loads it automatically when it works in `src-tizen/`.
   - Add one line to the root `AGENTS.md` pointing to it. That line is upstreamable.
2. **`.claude/settings.json`**
   - **Allow:** `pnpm run check|typecheck|test|build:tizen`, `node scripts/tizen.mjs *`, `sdb devices|connect|forward`, `git diff|log|status`.
   - **Deny:** `sdb shell rm*`, signing-profile edits, `tsc -b`.
   - Certificate passwords and the TV IP go in `.claude/settings.local.json` and `.env.tizen` (both gitignored).
3. **`.claude/skills/`**
   - `tizen-deploy`: build → package → install → launch → stream logs. Reports failure codes such as 118.
   - `tizen-debug`: `sdb forward` plus a small CDP script (`scripts/tizen-cdp.mjs`) for console, heap, screenshot and key injection. This lets Claude run smoke tests without a person holding the remote.
   - `upstream-sync`: merge `beta-branch` into `tizen`, run the boundary check, typecheck and tests, and list conflicts in seam files.
   - `avplay-change`: checklist that re-reads `lessons.md` before touching the player.
4. **`.claude/agents/tizen-reviewer.md`:** a read-only subagent that reviews diffs against `lessons.md`, the boundary rule and the "seam is generic" rule. Run it before each PR.
5. **Hook (PostToolUse on Edit/Write under `src/`):** runs `check:tizen-boundary` and reports violations straight away.
6. **Workflow per phase**
   - Plan mode → implement in a worktree.
   - Run `pnpm run check`, `typecheck`, `test` and `check:tizen-boundary`.
   - Then `/tizen-deploy` and `/tizen-debug` smoke test, `tizen-reviewer`, and the PR.
   - Real TV runs are needed for AVPlay; the emulator is only good for UI and boot.
7. **Memory:** record the decisions (Tizen 7.0 minimum, optional companion, in-tree layout, never merge old branches).

## Verification

- **Per change:** `pnpm run check`, `pnpm run typecheck`, `pnpm test` (including `tests/tizen-*.test.ts`) and `pnpm check:tizen-boundary`.
- **Desktop is unaffected:** `pnpm build` and `pnpm build:tv` produce an unchanged desktop bundle, which `main-tv.tsx`'s own comment requires.
- **On device** (`scripts/tizen.mjs install && launch`, then CDP smoke script):
  - boots in under N seconds;
  - home row is focusable;
  - back closes overlays, then asks before exiting;
  - debrid HLS/MP4 plays via AVPlay;
  - a DTS source falls back or ranks lower;
  - subtitles render in the DOM;
  - suspend/resume through Smart Hub works;
  - heap stays within budget after 30 minutes of browsing.
- **Upstream sync:** each `beta-branch` merge passes the same suite with no edits to `src-tizen/` caused by shared-code drift beyond the seams.
