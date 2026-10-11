---
name: avplay-change
description: Checklist to follow before and after changing Tizen AVPlay playback code in src-tizen/player. Use whenever a task touches AVPlay, the Tizen player bridge, subtitles on Tizen or codec ranking.
---

# Changing AVPlay code

Before editing:

1. Read the AVPlay, Codecs and Input sections of `src-tizen/docs/lessons.md`.
2. Read `src/lib/player/bridge.ts` (the `PlayerBridge` contract) and `src/lib/player/html5/bridge.ts`
   (the reference implementation and fallback).

While editing, check every item:

- [ ] Properties are set only in `IDLE`, before `prepareAsync`.
- [ ] No `setSelectTrack("TEXT", …)`. Subtitles go through the DOM overlay.
- [ ] No HEAD or preflight fetch before `avplay.open()`.
- [ ] `BUFFER_SIZE` is used only when `setBufferingParam` is unavailable.
- [ ] `prepareAsync` has a 30s watchdog that reports an error.
- [ ] `setDisplayRect` uses physical pixels.
- [ ] `suspend`/`restore` run on `visibilitychange`.
- [ ] The resume seek waits for a real duration.
- [ ] Failure falls back to the HTML5 bridge.
- [ ] mpv/Tauri behaviour is untouched. No edits in `src/` except a generic seam.

After editing:

- Add or update `tests/tizen-*.test.ts` with a `webapis.avplay` stub that covers the changed path.
- Run `pnpm test`, `pnpm run typecheck` and `pnpm check:tizen-boundary`.
- Tell the user which behaviour needs a real-TV check. Unit tests can't prove decoder behaviour.
