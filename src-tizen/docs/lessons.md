# Tizen lessons learned

Distilled from the earlier attempts (`origin/tizen`, `origin/tizen-beta`, `beta-tizen`)
and the uncommitted notes that went with them. Every rule here cost a debugging session.
Do not relearn them. If a rule turns out to be wrong, change it here in the same commit.

## Platform floor

- Minimum is **Tizen 7.0 (2022 TVs, Chromium 94)**. `config.xml` uses `required_version="7.0"`,
  and the build uses the same `chrome87` target as Android TV. Earlier attempts swung between
  es2015, esnext and chrome87, and between 2.3 and 8.0, without ever settling. Don't reopen this
  without a documented reason.
- `AbortSignal.timeout` and other recent APIs may be missing. Feature-detect, never assume.

## Boot and packaging

- The app loads over `file://`, so it needs Vite `base: "./"`. Absolute asset paths and
  `crossorigin` attributes both give a black screen at boot.
- Keep a boot watchdog that removes the boot overlay and logs, so a failed module load
  shows something.
- The package id is exactly 10 alphanumeric characters. Anything else fails at install
  with `Load archive info fail [118,-4]`.
- The TV's DUID must be in the distributor certificate, and Developer Mode
  ("Permit to install applications") must be on.
- The signing profile, TV address and credentials live in `.env.tizen` (gitignored).
  Never commit them. `tizen-beta` committed a LAN IP (`192.168.178.89`) as the default.

## Input

- Register media and colour keys via `tizen.tvinputdevice.registerKey`. Earlier code retried
  on DOMContentLoaded, load and +1s because registration silently failed when called too early.
- Back fires as **both** `tizenhwkey` and keydown 10009. Listen to one source and debounce
  250ms. Otherwise one press closes the overlay and the player.
- Unhandled Back lets the OS navigate the webview back, which can kill the app. Always
  handle it, and exit only via `tizen.application.getCurrentApplication().exit()` from the root.
- A ReferenceError inside a keyboard hook blacked out the whole UI on the first keypress.
  Key handlers need tests.

## AVPlay

- Properties (buffering, streaming, DRM) can only be set in the `IDLE` state, before `prepareAsync`.
- `setDisplayRect` takes physical panel pixels, not CSS pixels. Video renders on a plane
  _behind_ the webview, so every container above it must be transparent (`html.harbor-avplay`).
- **Never** call `setSelectTrack("TEXT", ...)`. It crashes the native decoder on streams
  without sidecar subtitles. Subtitles always use Harbor's DOM overlay (`snap.subText`).
- **Never** send a HEAD request before `open()`. Debrid and torrent servers answer 405/403 or
  lack CORS. Pass the URL straight to `avplay.open()` and let the native stack follow redirects.
- Don't combine `setStreamingProperty("BUFFER_SIZE")` with `setBufferingParam`. Together they
  corrupt buffering state. Use `BUFFER_SIZE` only when `setBufferingParam` is unavailable.
- `prepareAsync` can hang forever on older firmware when a manifest doesn't parse. Wrap it in a
  30s watchdog that reports an error.
- `duration` reads 0 right after prepare. Wait for a real duration before the resume seek.
- On `visibilitychange`, call `suspend()` when hidden and `restore()` when visible, or
  multitasking (Smart Hub and back) kills the decoder.
- On AVPlay failure, fall back to the HTML5 bridge instead of showing a black screen.

## Codecs (stream ranking)

- DTS and TrueHD: no audio on most models. Dolby Vision profile 5 without an HDR10 fallback
  shows wrong colours.
- Prefer DD+, AAC and HEVC/AV1.
- Apply these as a **platform score modifier** registered from `src-tizen/`. Editing the shared
  scorer (`harbor-core/src/scoring.rs` or `src/lib/streams/scoring/`) was tried and reverted
  (beta-tizen 9e518c25 → c62096b5).

## Network

- There is no native backend. CORS applies to every fetch. Hosts that need a proxy go through
  the optional companion (desktop Harbor / Stremio server on the LAN) via the `safe-fetch`
  proxy seam.
- The TV can't receive UDP or mDNS. Find the companion with an HTTP sweep of the subnet,
  which needs the `network.public` privilege.
- Typing on a remote is painful. Get configuration onto the TV by pairing or import, never
  by typing long URLs.

## Memory and performance

- Use virtualised rows and translate3d-only focus movement.
- Desktop-only payloads (games, music, face detection, onnx, mediapipe) must stay out of the
  Tizen module graph.
- Measure heap, image and layer counts over CDP (`sdb forward`). Don't guess.

## Process

- Commit fixes. Several critical ones existed only in gitignored notes and stashes.
- Never merge the old Tizen branches. Port code from them deliberately, one reviewed change at a time.
- Merge `beta-branch` often and in small steps. `tizen-beta` became unreviewable after a
  2,333-file merge.
- Shared `src/` never mentions Tizen (`pnpm check:tizen-boundary`).
