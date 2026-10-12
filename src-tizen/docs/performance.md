# Tizen performance

Budgets and how to measure them. The numbers are from GU43DU7199UXZG (Tizen 9.0), 2026-10-11.

## Size budget (checked on every build)

`pnpm build:tizen` ends with `pnpm check:tizen-budget`, which compares the build against
`src-tizen/budget.json`. The limits are the phase 5 sizes plus about 10% headroom.

| Item               | Before phase 5 | After phase 5 | Budget |
| ------------------ | -------------- | ------------- | ------ |
| `.wgt`             | 90.0 MB        | 37.3 MB       | n/a    |
| dist (app files)   | 164 MB         | 51 MB         | 56 MB  |
| Boot chunk         | 2,430 KiB      | 1,620 KiB     | 1,780  |
| Boot chunk, gzip   | 708 KiB        | 479 KiB       | 530    |
| Largest lazy chunk | 2,211 KiB      | 2,211 KiB     | 2,430  |
| All JavaScript     | n/a            | 10,430 KiB    | 11,500 |
| CSS                | 869 KiB        | 869 KiB       | 960    |

What went:

- X-Ray's face engine: `public/mp-wasm`, `public/ort`, `public/models` and a second copy of the
  ort wasm in `assets/`, about 70 MB in total. It is stubbed (`src-tizen/build/face-engine.ts`) and
  switched off with `setFaceIdAvailable(false)`. AVPlay video can't be captured anyway.
- The 14 non-English catalogs, 1.3 to 2.3 MB each. They are stubbed
  (`src-tizen/build/empty-catalog.ts`), and the pickers offer English only
  (`restrictUiLanguages(["en"])`).
- `public/` folders only non-TV views use: listed in `PUBLIC_EXCLUDED` in `vite.config.ts`. The
  build fails if the bundle, the HTML or a copied file refers to one.
- hls.js and mpegts.js left the boot chunk: the HTML5 fallback is imported lazily. They still
  load with the player chunk.

`src-tizen/.stats/bundle.json` (gitignored, written by every Tizen build) lists each chunk with
its 40 biggest modules. Start there when the budget fails. The rest of the boot chunk is mostly
react-dom (540 KiB), the English catalog, tldts, `@tauri-apps/api/window`, themes and
providers that `bp-tv-app.tsx` imports statically.

## Runtime (checked by hand on the TV)

`node scripts/tizen-cdp.mjs measure 5` relaunches the app five times. For each run it reads
the boot marks, then the heap after a GC at idle Home (15 s after Home takes focus). It reads
the heap again after a fixed walk: Down ×2, Right ×5, open a title, Back, then 50 focus moves.
It needs a seeded, onboarded app. Readings are only comparable in the same app state; see
`lessons.md`.

Both builds were measured after a fresh install, the same seed and the same onboarding choices:

| Reading            | Before (4 runs) | After (5 runs) |
| ------------------ | --------------- | -------------- |
| `render-called`    | 2.50 s (±16%)   | 2.30 s (±25%)  |
| Home takes focus   | 24.0 s (±4%)    | 23.2 s (±11%)  |
| Idle JS heap       | 28.6 MB (±1%)   | 28.3 MB (±2%)  |
| Idle DOM nodes     | 1,810           | 1,792          |
| JS heap after walk | 45.1 MB (±1%)   | 45.3 MB (±5%)  |
| Decoded images     | 34.1 MB         | 33.9 MB (±21%) |

There is no runtime change beyond the spread. The removed payloads were never loaded at
runtime; they cost package size, install time and storage. Treat these as the heap budget:
idle under 32 MB and the walk under 50 MB. Check them after any change to Home, rows or art.

## Home focus (2026-10-12)

`measure` counts Home as ready when focus sits inside a row. Home picks its seed row only once
Continue Watching (the Stremio library) and the catalog have both settled, so that is when the
ring appears. The rows themselves draw from the cached snapshot several seconds earlier.

What delays it, measured with CDP traces, in-page fetch and long-task logging, and reloads with
CSS injected before load (`Page.addScriptToEvaluateOnNewDocument`):

- **Long tasks.** On this TV a `Commit` blocks the main thread until raster finishes, so paint
  cost is main-thread time. Between about 5 s and 13 s the main thread runs 2–2.7 s tasks, and
  every async step of the library and catalog loads waits behind them. Hiding the ambient
  backdrop roughly halves raster; no single part of it dominates, and the rows carry the rest.
- **The hero backdrop rastered in software.** Its compositing hint was keyed on `isAndroidTv()`.
  On `isTelevision()` it becomes a directly composited image: raster over 12 focus moves
  dropped from 59 s to 20 s and the longest commit from 1.7 s to 0.5 s.
- **The seed pass expired.** `useBpFocusRoot` stopped trying after 6 s, before Continue Watching
  was ready, so focus landed only when a later layout change happened to recover it (seed
  present at 9.2 s, focus at 17.3 s in one run). It now keeps trying, seed only, while nothing
  is focused and the user has not moved, clicked or scrolled, for up to 60 s.
- **The library took two round trips.** `datastoreMeta` then `datastoreGet`. One
  `datastoreGet` with empty `ids` and `all: true` returns the same items (stremio-core does the
  same on login). The request now leaves at about 4 s instead of about 12 s.
- **The catalog gate.** The two top-rated TMDB rows wait for a slot in the 6-request scheduler,
  and a slot stays held until each response has been parsed, so they start around 13 s.

Same account, scripted onboarding and seed for every build:

| Build                                 | Home ready (mean, runs) |
| ------------------------------------- | ----------------------- |
| Before                                | 24.2 s (3, ±11%)        |
| Hero backdrop composited on every TV  | 23.4 s (3, ±25%)        |
| + seed pass held, one-request library | 23.8 s (7, 22.1–26.6 s) |

The focus time is within noise of where it was: it stays bound by the long tasks and the
catalog gate. What changed is navigation (a third of the raster), a library that arrives about
8 s sooner, and a seed pass that can no longer stall. The two composited backdrops cost graphics memory (about 12 MB on Android TV); that was not
measured on Tizen. Heap is not comparable with the phase 5
table: this account has more rows and addons (idle 49 MB, walk 63 MB).

### Home snapshot

`bp-home-cache.ts` keeps last session's shelves in IndexedDB so a cold start can draw them at
once. For a profile with a TMDB key it never saved: TMDB rows carry their page fetcher, the put
threw `DataCloneError`, and the save swallows errors. Once fixed, the snapshot was 18.7 MB, 17 MB
of it episode lists that two TMDB-addon series catalogs put in their catalog metas. The stored
rows now drop both (`bpSnapshotRows`): 1.4 MB.

Home focus with the snapshot working: 22.3 s (5 runs, 20.8–24.2 s), within noise of before.
Reading it back still takes about 9 s during boot against about 200 ms at idle, at 1.4 MB as at
18.7 MB, so the cost is the starved worker threads, not the size. Holding the ambient art
until first focus halves raster but did not move focus either (22.6 s and 23.7 s); that
experiment was not kept.

## Open

- Home still takes about 24 s to show the focus ring. Next: hold the ambient art on a television
  until Home has focus, and let the snapshot satisfy the seed gate instead of the live catalog.
- The boot chunk still carries `@tauri-apps/api` (about 110 KiB with `core` and `dpi`), the
  manga plugin prelude and the Together client. Splitting them means changes to shared
  imports.
- The hint bar draws over the first row's posters at 1080p. It did before phase 5 too.
