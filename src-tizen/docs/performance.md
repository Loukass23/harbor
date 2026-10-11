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

## Open

- Home takes about 23 s to take focus after launch, against 2.3 s to the first render. The
  time goes before the first row is focusable (catalog and library fetches). This is the
  largest user-visible cost and the next thing to profile.
- The boot chunk still carries `@tauri-apps/api` (about 110 KiB with `core` and `dpi`), the
  manga plugin prelude and the Together client. Splitting them means changes to shared
  imports.
- The hint bar draws over the first row's posters at 1080p. It did before phase 5 too.
