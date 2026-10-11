---
name: tizen-debug
description: Inspect Harbor running on a Tizen TV over Chrome DevTools Protocol, including console, heap, screenshots and simulated remote keys. Use for TV smoke tests, memory checks or to reproduce a bug without a person holding the remote.
---

# Debug Harbor on a Tizen TV

1. `node scripts/tizen.mjs debug` launches in debug mode and sets up `sdb forward`. It prints the CDP port.
2. Use `node scripts/tizen-cdp.mjs <command>` with `HARBOR_CDP_PORT` set to that port:
   - `console`: stream console messages and exceptions.
   - `eval "<expr>"`: evaluate in the page. Read-only inspection only.
   - `keys Down Down Enter Back`: dispatch remote keys (Back = keyCode 10009).
   - `focus`: the focused element's label and Home row, to steer `keys` without screenshots.
   - `player`: AVPlay state and position, since screenshots can't see the video plane.
   - `screenshot <file>`: save a PNG to the scratchpad, then read it.
   - `heap`: JS heap (exact, from the inspector) after a GC, DOM node count, decoded image MB.
   - `measure [n]`: relaunch n times, read boot marks, heap at idle and after a fixed key
     walk, and print mean and spread. Needs a seeded, onboarded app (Home must take focus).
     From a worktree, set `HARBOR_TIZEN_ROOT` to the checkout that has `.env.tizen`.
3. Smoke test after a change:
   - boot to the home row;
   - move focus across two rows;
   - open a title;
   - Back twice: the overlay closes, then the exit prompt appears;
   - `heap` before and after 50 focus moves.

## Rules

- Report numbers (boot ms, heap MB, node count), not impressions. A difference smaller
  than the spread `measure` prints is noise.
- Compare two builds only after seeding and onboarding both the same way.
- AVPlay video is on a hardware plane, so CDP screenshots show it as transparent or black.
  Confirm playback with the player state and position events instead.
- A new platform quirk goes into `src-tizen/docs/lessons.md`.
