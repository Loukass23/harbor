# Tizen TV (Samsung Smart TV) Pipeline & Architecture

This document covers the build, deployment, debugging, and diagnostics pipeline for running Harbor on Samsung Smart TVs running Tizen OS (3.0+ / 9.0+).

---

## 1. Architecture Overview

Harbor on Tizen runs as a native Tizen Web Application (packaged as a `.wgt` widget):

- **Shared TV UI**: Reuses Harbor's Big Picture TV interface (`index-tv.html` / `src/main-tv.tsx`) built with standard React, Tailwind CSS, and TanStack Router.
- **Isolated Platform Wrapper**: Following the project's separation pattern (`src-tauri/` for desktop, `android-native/` for mobile), all Tizen-specific packaging metadata resides in `src-tizen/`.
- **Relative Path Bundling**: In `tizen` build mode, Vite targets `base: "./"` and outputs to `src-tizen/dist/`. This ensures local script, style, and asset references resolve under Tizen's `file:///` widget sandbox.
- **Clean Source Tree**: All developer utilities (backup preloading, device targeting, CDP diagnostics) are decoupled from `src/` and orchestrated via Node scripts in `scripts/`.

---

## 2. Directory Layout

```text
harbor/
├── src-tizen/
│   ├── config.xml             # Tizen widget manifest, permissions & TV metadata
│   └── icon.png               # Launcher icon (512x512)
├── scripts/
│   ├── tizen-pipeline.mjs     # Build, package, install, run & diag orchestrator
│   └── harbor-diag.mjs        # CDP memory, DOM & image profiler (cross-platform)
├── harbor-backups/            # Optional .harbx backups for dev config preloading
└── vite.config.ts             # Contains tizen mode build configuration
```

---

## 3. Manifest & Permissions (`src-tizen/config.xml`)

Samsung Smart TVs enforce strict sandboxing. The manifest declares necessary privileges and network rules:

- **Network Access**:

  ```xml
  <access origin="*" subdomains="true"></access>
  <tizen:privilege name="http://tizen.org/privilege/internet"></tizen:privilege>
  ```

  Enables HTTP/HTTPS requests and remote asset loading (TMDB posters, Stremio addon catalogs, streams). Without these, external images fail silently or throw CSP violations.

- **Remote Input**:

  ```xml
  <tizen:privilege name="http://tizen.org/privilege/tv.inputdevice"></tizen:privilege>
  ```

  Grants access to TV remote keys, D-pad events, and media controls.

- **TV Form Factor**:
  ```xml
  <tizen:profile name="tv-samsung"></tizen:profile>
  <feature name="http://tizen.org/feature/screen.size.normal.1080.1920"></feature>
  <tizen:metadata key="http://tizen.org/metadata/app_ui_type/base_screen_resolution" value="extensive"></tizen:metadata>
  ```

---

## 4. Pipeline Commands

All operations are run through `pnpm`:

| Command                                         | Description                                                                             |
| :---------------------------------------------- | :-------------------------------------------------------------------------------------- |
| `pnpm run tizen:build`                          | Compiles TypeScript (`tsc -b`) and bundles web assets via Vite in `tizen` mode.         |
| `pnpm run tizen:deploy`                         | End-to-end deployment: runs build, packages signed `.wgt`, and installs onto target TV. |
| `pnpm run tizen:debug`                          | Launches app in debug mode (`tz run -d`), opens CDP port forward, and outputs URL.      |
| `pnpm run tizen:seed`                           | Injects the latest `.harbx` backup into the TV's `localStorage` over CDP and reloads.   |
| `pnpm run tizen:diag [counts\|bigimgs\|layers]` | Runs Harbor's CDP diagnostics suite against the active TV session.                      |

> **Advanced / Granular usage:**
> Individual lifecycle steps are also accessible directly via script flags:
> `node scripts/tizen-pipeline.mjs --package` (package only), `--install` (install only), `--run` (launch without debugger).

---

## 5. Configuration & Environment Overrides

Copy `.env.example` to `.env` to configure your development setup. The pipeline script (`scripts/tizen-pipeline.mjs`) automatically detects attached devices and forwarded ports, but honors overrides from `.env`:

```env
# Target TV serial, IP or DUID (defaults to auto-detection from 'sdb devices')
HARBOR_TIZEN_TARGET=GU43DU7199UXZG

# SDB serial address for Wi-Fi or USB connected TV (defaults to auto-detection)
HARBOR_TIZEN_SERIAL=192.168.178.26:26101

# Samsung certificate signing profile (defaults to SwormHarbor)
HARBOR_TIZEN_PROFILE=SwormHarbor

# Chrome DevTools Protocol port (defaults to auto-detection from 'sdb forward --list')
HARBOR_CDP_PORT=45159

# Custom backup path for dev seeding
HARBOR_TIZEN_BACKUP=harbor-backups/my-backup.harbx
```

You can also pass flags directly to the script:

```bash
node scripts/tizen-pipeline.mjs --target <TARGET> --profile <PROFILE> --deploy
```

---

## 6. Remote Control & Navigation Behavior

- **Remote Keys Registered**: When launched on Tizen, Harbor registers Samsung TV remote keys (`MediaPlayPause`, `MediaPlay`, `MediaPause`, `MediaStop`, `MediaFastForward`, `MediaRewind`, `Search`, `Back`) via the Tizen TV InputDevice API.
- **Back Key Flow**:
  - In Big Picture menus/detail screens, the remote Back key steps back through history or closes modals.
  - When pressed on the top-level home screen, Tizen prompts to exit the application cleanly via `tizen.application.getCurrentApplication().exit()`.
  - During stream loading or playback, pressing Back or clicking Cancel safely tears down the player bridge and returns cleanly to Big Picture without UI freezes or leaving the shell hidden.

---

## 7. Developer Workflows

### Live Debugging & Web Inspector

1. Ensure the TV is connected via SDB:
   ```bash
   sdb devices
   ```
2. Launch in debug mode:
   ```bash
   pnpm run tizen:debug
   ```
3. Open Google Chrome and navigate to the forwarded inspector URL (or `chrome://inspect`).

### Profiling with `harbor-diag`

Harbor's native diagnostic suite communicates directly with Tizen's Web Inspector over CDP:

```bash
# Query DOM nodes, image counts, and JS heap memory
pnpm run tizen:diag counts

# Inspect largest decoded images consuming TV RAM
pnpm run tizen:diag bigimgs

# Inspect active layout layer stack
pnpm run tizen:diag layers
```

### Seeding Development Settings

To quickly populate settings, accounts, or test data without retyping on a TV remote:

- **Live Seeding (Instant)**: Run `pnpm run tizen:seed` while the app is running in debug mode. It will inject the latest `.harbx` backup from `harbor-backups/` and reload the page.
- **Build Preloading**: Run `node scripts/tizen-pipeline.mjs --deploy --seed` to bundle the backup into `dist/dev-seed.js`, auto-applying it on the TV's very first launch.
