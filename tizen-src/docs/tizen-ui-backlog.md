# Tizen UI & D-pad Custom Mappings Backlog

This document tracks all custom key mappings, input handlers, and UI/UX behaviors added or validated specifically for Samsung Tizen OS during the QA phase.

---

## 1. Existing Tizen-Specific Key Mappings & Implementations

The following custom mappings and Tizen platform hooks are currently implemented in the codebase:

### Tizen Input Registration

- **Location:** [`src/main-tv.tsx`](file:///c:/Users/lucas/Documents/Dev/2026/sworm/harbor/src/main-tv.tsx#L21-L68) (`registerTizenKeys`)
- **Registered Keys:**
  - **Media Controls:** `MediaPlay`, `MediaPause`, `MediaPlayPause`, `MediaStop`, `MediaFastForward`, `MediaRewind`, `MediaTrackPrevious`, `MediaTrackNext`
  - **Color Function Buttons:** `ColorF0Red`, `ColorF1Green`, `ColorF2Yellow`, `ColorF3Blue`
  - **Numpad:** Digits `0` through `9`
- **Purpose:** Samsung Tizen TVs do not automatically dispatch DOM keyboard events for remote media or color keys unless registered via `window.tizen.tvinputdevice.registerKey(key)`.

### Hardware Back / Return Key

- **Key Code:** `10009` (Samsung Tizen hardware Return key)
- **Implemented Locations:**
  - [`src/lib/keyboard-navigation.ts`](file:///c:/Users/lucas/Documents/Dev/2026/sworm/harbor/src/lib/keyboard-navigation.ts#L67): Included in `BACK_KEYCODES` set (`27, 4, 461, 10009, 166`) for global back navigation.
  - [`src/lib/keyboard-navigation/geometry.ts`](file:///c:/Users/lucas/Documents/Dev/2026/sworm/harbor/src/lib/keyboard-navigation/geometry.ts#L46): Included in `BACK_KEYCODES` set for focus geometry.
  - [`src/views/big-picture/use-bp-focus.ts`](file:///c:/Users/lucas/Documents/Dev/2026/sworm/harbor/src/views/big-picture/use-bp-focus.ts#L565): Handled in D-pad focus routing (`e.keyCode === 10009 || e.which === 10009`) to trigger `onBack()`.

### Directional & Selection Keys

- **DPad Center / Select:** Handled via keycodes `13` (Enter), `23` (DPad Center), and `32` (Space).
- **DPad Arrows:** Standard Arrow keys (`37` Left, `38` Up, `39` Right, `40` Down) and Android equivalents (`19`, `20`, `21`, `22`).

### Platform Detection & Viewport

- **Location:** [`src/lib/platform.ts`](file:///c:/Users/lucas/Documents/Dev/2026/sworm/harbor/src/lib/platform.ts#L59-L84)
- **Logic:** `isTizen()` detects `window.tizen` or User-Agent matching `"tizen"` / `"smart-tv"`. Automatically marks `isAndroidTv()` as `true` to activate the 10-foot Big Picture UI and safe-area overscan margins.

---

## 2. QA Issue Tracking (To Be Added During Testing)

Use the table below during manual QA sessions to log missing key handlers, navigation traps, or focus quirks.

| ID     | View / Component                   | Input / Action     | Observed Behavior                 | Expected Behavior           | Status |
| :----- | :--------------------------------- | :----------------- | :-------------------------------- | :-------------------------- | :----- |
| TIZ-01 | _Example: Player OSD_              | _Return (10009)_   | _Closes whole app instead of OSD_ | _Dismiss OSD overlay first_ | Open   |
| TIZ-02 | _Example: Search Virtual Keyboard_ | _D-pad Left/Right_ | _Focus jumps past space key_      | _Smooth 2D grid navigation_ | Open   |

---

## 3. Policy on Fixes & Mutualization

- **Phase 1 (Current):** Document all findings and missing mappings in this log. Keep Tizen-specific workarounds isolated.
- **Phase 2 (Subsequent):** Batch-resolve all navigation and key mapping issues together, and evaluate mutualization with the common spatial navigation system (`src/lib/keyboard-navigation.ts`).
