---
name: tizen-debug
description: Inspect Harbor running on a Tizen TV over Chrome DevTools Protocol, including console, heap, screenshots and simulated remote keys. Use for TV smoke tests, memory checks or to reproduce a bug without a person holding the remote.
---

# Debug Harbor on a Tizen TV

1. `node scripts/tizen.mjs debug` launches in debug mode and sets up `sdb forward`. It prints the CDP port.
2. Use `node scripts/tizen-cdp.mjs <command>` against that port:
   - `console`: stream console messages and exceptions.
   - `eval "<expr>"`: evaluate in the page. Read-only inspection only.
   - `keys Down Down Enter Back`: dispatch remote keys (Back = keyCode 10009).
   - `screenshot <file>`: save a PNG to the scratchpad, then read it.
   - `heap`: JS heap size, DOM node count, decoded image bytes.
3. Smoke test after a change:
   - boot to the home row;
   - move focus across two rows;
   - open a title;
   - Back twice: the overlay closes, then the exit prompt appears;
   - `heap` before and after 50 focus moves.

## Rules

- Report numbers (boot ms, heap MB, node count), not impressions.
- AVPlay video is on a hardware plane, so CDP screenshots show it as transparent or black.
  Confirm playback with the player state and position events instead.
- A new platform quirk goes into `src-tizen/docs/lessons.md`.
