# Tizen lessons learned

Distilled from the earlier attempts (`origin/tizen`, `origin/tizen-beta`, `beta-tizen`)
and the uncommitted notes that went with them. Every rule here cost a debugging session.
Do not relearn them. If a rule turns out to be wrong, change it here in the same commit.

## Platform floor

- Minimum is **Tizen 9.0 (Chromium 120)**, verified on GU43DU7199UXZG. `config.xml` uses
  `required_version="9.0"` and the build targets `chrome120`. It was briefly 7.0/`chrome87`, the
  Android TV floor, but no 2022 TV was available to prove it. Earlier attempts swung between
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
- `base: "./"` only fixes URLs that Vite sees: HTML, CSS and imported assets. String
  literals built at runtime, such as `"/avatars/x.webp"` and `"/services/netflix.svg"`
  (about 290 in `src/`), still resolve to `file:///C:/…` and fail. Images fall back, so
  boot survives. They need a shared public-URL seam, not a Tizen patch.
- Vite's lazy-chunk preloader adds `crossorigin` to the `<link>` tags it injects at runtime.
  The Tizen build sets `modulePreload: false` and `cssCodeSplit: false` so it never injects any.
- Big Picture renders through portals next to `#root` and leaves `#root` empty. "Booted"
  means the app took `#boot` down (removed, or `data-leaving`). The first watchdog checked
  `#root` and wiped a working UI after 30s.
- `tz pack -w <dir>` treats the folder as a project. It writes `tizen_web_project.yaml`
  and a full copy of the folder under `Debug/projects/`, and names the package after the
  folder (`Debug/dist.wgt`). Delete those before packing again. `tz set -w <dir> -s <profile>`
  picks the signing profile and creates the yaml. `tz gen` needs a workspace and fails here.
- `tz run -r` (Web Simulator) only accepts a page named `index.html`. Start
  `sec-tv-simulator/simulator.exe --file=<dist>/index-tv.html` directly; `--remote-debugging-port`
  needs `--disableInspector`. The app runs in a child frame of `ripple.html`.
- `tz install` logs the app as `<package>.<wgt file name>` (`kmDHFrYo6a.dist`). That is only
  a label: the real app id is the one in `config.xml` (`kmDHFrYo6a.Harbor`), and that is what
  `sdb shell 0 debug` needs. beta-tizen hardcoded `.dist` because of this log line.
- `sdb dlog` prints nothing on a retail TV in Developer Mode. Read the console over CDP
  (`scripts/tizen.mjs debug`) instead.
- The local Samsung TV emulator (Tizen 10) needs hardware virtualization. Without it, the
  guest crawls and `sdb devices` stays `offline`. `tz emul launch` prints "terminated after
  timeout" even when the VM is still starting.

## Input

- Register media and colour keys via `tizen.tvinputdevice.registerKey`. Earlier code retried
  on DOMContentLoaded, load and +1s because registration silently failed when called too early.
- Back fires as **both** `tizenhwkey` and keydown 10009. Listen to one source and debounce
  250ms. Otherwise one press closes the overlay and the player.
- Unhandled Back lets the OS navigate the webview back, which can kill the app. Always
  handle it, and exit only via `tizen.application.getCurrentApplication().exit()` from the root.
- A ReferenceError inside a keyboard hook blacked out the whole UI on the first keypress.
  Key handlers need tests.
- `registerKeyBatch(names, undefined, onError)` throws `TypeMismatchError`. Callbacks must be
  functions or `null`. That throw at startup stopped `mountTvApp()` from running, so
  `main.tsx` now catches any platform install failure and mounts anyway.
- Only register keys the shared app handles (the media transport keys). Registering a key
  takes it from the system. Tizen's key names (`MediaPlayPause` 10252, `MediaPlay` 415,
  `MediaPause` 19, `MediaStop` 413, `MediaFastForward` 417, `MediaRewind` 412,
  `MediaTrackPrevious` 10232, `MediaTrackNext` 10233) match the DOM `key` values the player
  checks. `src-tizen/platform/keys.ts` re-sends any event that arrives with another `key`.
- Back (10009, `XF86Back`) is re-sent as Escape from the first capture listener on `window`.
  Big Picture's layers (focus, dialogs, trailer, gallery, player confirm) all close on
  Escape, so no shared key check changes. Big Picture's own window listener stops
  propagation, so a test probe on `document` never sees the Escape; probe on `window`.
- The on-screen keyboard opens as soon as a writable input takes focus, which breaks "focus is
  not activation". `BpOnboardField` holds the field `readOnly` with `inputmode="none"` until OK
  on Android and on any `isTelevision()` target; `installTizenPlatform()` marks Tizen through
  `markTelevision()`. After the lock drops, `focus()` on the input that already has focus does
  not open the keyboard. It takes a real `blur()` and then `focus()`. The keyboard
  shrinks `innerHeight` from 642 to 338 CSS px. Wait about a second before a screenshot: an
  immediate one misses the keyboard. Back closes the keyboard and also
  reaches the app as Escape, so one press closes both the keyboard and the pane behind it.
  Never keep an unsaved draft that only a second Back would protect: the streaming server pane
  saves its draft when it closes.
- At the root, Back opens the shared exit confirm. "Close" calls `BpPlatform.exit` →
  `tizen.application.getCurrentApplication().exit()`. Nothing else exits the app.

## AVPlay

- Properties (buffering, streaming, DRM) can only be set in the `IDLE` state, before `prepareAsync`.
- `setDisplayRect` takes screen pixels, not CSS pixels. Video renders on a plane
  _behind_ the webview, so every container above it must be transparent (`html.harbor-avplay`).
- The webview lays out at 1140×642 CSS px on a 1920×1080 screen with `devicePixelRatio` **1**
  (GU43DU7199UXZG, Tizen 9.0). Scale by `screen.width / innerWidth`, never by the pixel ratio:
  that draws the video at 60% in the top-left corner.
- `webapis` exists only after the page loads `$WEBAPIS/webapis/webapis.js`; the Tizen Vite build
  adds that tag. CDP screenshots show the video plane as white, so check playback with
  `webapis.avplay.getState()` and `getCurrentTime()` instead.
- AVPlay starts on the container's default audio track, which is often not the first one in
  `getTotalTrackInfo()` (a Silo MKV started on track 7 of 7). Read the playing track from
  `getCurrentStreamInfo()`. The `index` field, not the array position, is what
  `setSelectTrack` takes. AVPlay also marks an embedded text track as current on its own;
  that is harmless as long as Harbor never selects one.
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
  multitasking (Smart Hub and back) kills the decoder. On GU43DU7199UXZG a bare `restore()`
  still leaves AVPlay in `IDLE` at 0:00 with nothing prepared, so when the state after restore
  is not `READY`/`PAUSED`/`PLAYING`, reopen the source at the saved position, paused.
- `PLAYER_DISPLAY_MODE_LETTER_BOX` stretched a 3840×1606 (2.39:1) picture to fill 16:9. Fit the
  display rect to the video's own aspect and use `PLAYER_DISPLAY_MODE_FULL_SCREEN` inside it.
- `setSelectTrack("AUDIO", n)` throws `InvalidStateError` in `READY`, which is exactly when the
  player picks the preferred language. Hold the choice and apply it on the first
  `oncurrentplaytime` once the state is `PLAYING` or `PAUSED`.
- Every `webapis.productinfo` call (`isUdPanelSupported`, `getModel`, ...) throws `SecurityError`
  without `http://developer.samsung.com/privilege/productinfo` in `config.xml`. Wrap panel
  queries on their own: inside the open sequence a throw failed every HLS/DASH stream.
- `getCurrentStreamInfo()` throws `InvalidStateError` while AVPlay is still preparing. Call it on
  its own: a throw that also empties the track list stops the player choosing the preferred
  audio language, and the viewer gets the container default (Russian, on one Silo release).
- On AVPlay failure, fall back to the HTML5 bridge instead of showing a black screen.

## Codecs (stream ranking)

- DTS and TrueHD: no audio on most models. Dolby Vision profile 5 without an HDR10 fallback
  shows wrong colours.
- Prefer DD+, AAC and HEVC/AV1.
- Apply these as a **platform score modifier** registered from `src-tizen/`. Editing the shared
  scorer (`harbor-core/src/scoring.rs` or `src/lib/streams/scoring/`) was tried and reverted
  (beta-tizen 9e518c25 → c62096b5).

## Network

- There is no native backend, but there is also **no CORS**. Measured on GU43DU7199UXZG
  (Tizen 9.0, Chromium 120) from `file://` with `<access origin="*" subdomains="true">`: every
  response is `type: "basic"` with all headers readable, including hosts that send no
  `Access-Control-Allow-Origin` (api.strem.io, api.real-debrid.com, metahub, TMDB images). A
  `PUT` with `Authorization` and a custom header goes through with no preflight failure, and
  plain `http://` LAN hosts load. So `safeFetch` falls through to plain `fetch` and needs no
  proxy. Earlier notes said "CORS applies to every fetch"; that was never measured. Re-measure
  before adding any proxy, and keep the `<access>` element.
- The remote Stremio server URL is the shared `remoteStreamServerUrl` setting, set from Big
  Picture → Settings → Setup → Remote streaming server.
- The TV can't receive UDP or mDNS. Find the companion with an HTTP sweep of the subnet
  (`src-tizen/net/`). Reading the TV's own address (`webapis.network.getIp()`) needs the
  `network.public` privilege; `tizen.systeminfo` `ETHERNET_NETWORK`/`WIFI_NETWORK` is the
  fallback. The sweep is capped at the TV's /24, 24 probes at a time, 700 ms each.
- Typing on a remote is painful. Configuration arrives by pairing with Harbor on a computer
  (Settings → Setup → Pair with a computer, or the onboarding step). The Remote streaming
  server pane stays as the manual fallback.
- The pairing payload (Stremio auth key, debrid keys) crosses the LAN as plain HTTP, like the
  phone hand-off. It is sent only after someone approves the matching code on the computer,
  and can be collected until the request expires (2 minutes), so a dropped response is not
  lost. The trust model is the LAN: the torrent server, once started, answers anyone on it, and
  the instance id the TV re-finds by is public. The companion routes send no CORS headers, so
  a web page on the computer cannot drive pairing.
- The computer only answers while Serve Harbor on your network is on. Its torrent engine on
  `:11470` is started by the approval, and again by the TV at launch with its pairing token.

## Memory and performance

- Use virtualised rows and translate3d-only focus movement.
- Desktop-only payloads (games, music, face detection, onnx, mediapipe) must stay out of the
  Tizen module graph.
- Measure heap, image and layer counts over CDP (`sdb forward`). Don't guess.
  `scripts/tizen-cdp.mjs measure` does it over a fixed key path; see `performance.md`.
- `performance.memory` is bucketed in Chromium: two different heaps read the same. Read
  `Runtime.getHeapUsage` over CDP instead.
- Compare builds only in the same app state. Every install wipes the app, and a seeded,
  onboarded profile has more rows and art than an empty one (idle heap 17 MB against 28 MB).
  Seed and onboard the same way before each measurement.
- `tizen.mjs seed` right after an install can find no profile yet. Wait about ten seconds and run it again.
  The seed reload then opens onboarding.
- Size, not heap, was the cost of the unused payloads: X-Ray's face engine (mp-wasm, ort,
  models) and the 14 non-English catalogs were never loaded at runtime, but they made up most
  of the 90 MB `.wgt`. The Tizen build stubs them (`src-tizen/build/`) and leaves those public
  folders out (`PUBLIC_EXCLUDED` in `vite.config.ts`). Face matching can't work here anyway: the
  AVPlay plane can't be captured into a canvas.
- Turning Vite's `publicDir` off to filter `public/` also stops it rewriting `/favicon.png`-style
  URLs to relative ones, which file:// needs. Remove the excluded entries after the copy instead.

## Process

- Commit fixes. Several critical ones existed only in gitignored notes and stashes.
- Never merge the old Tizen branches. Port code from them deliberately, one reviewed change at a time.
- Merge `beta-branch` often and in small steps. `tizen-beta` became unreviewable after a
  2,333-file merge.
- Shared `src/` never mentions Tizen (`pnpm check:tizen-boundary`).
