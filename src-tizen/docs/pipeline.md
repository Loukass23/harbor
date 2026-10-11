# Tizen pipeline

`node scripts/tizen.mjs <command...>` runs the commands in order, for example
`node scripts/tizen.mjs build package install launch`.

| Command     | What it does                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `build`     | `vite build --config src-tizen/vite.config.ts` → `src-tizen/dist` (also `pnpm build:tizen`)      |
| `package`   | writes `config.xml` and `icon.png` into `dist`, then `tz pack` → `src-tizen/dist/Debug/dist.wgt` |
| `install`   | `tz install` the `.wgt` on the device                                                            |
| `launch`    | `tz run` by package id                                                                           |
| `debug`     | restarts the app in debug mode, runs `sdb forward` and prints the CDP port                       |
| `logs`      | `sdb dlog` filtered to console messages (emulator only; empty on a retail TV, use `debug`)       |
| `simulator` | writes `config.xml` into `dist` and opens it in the Samsung TV Web Simulator (`tz run -r`)       |
| `deploy`    | `build package install launch`                                                                   |

## Settings

The settings live in `.env.tizen` (gitignored; copy `.env.tizen.example`). Values already in the
environment override it.

- `HARBOR_TIZEN_PACKAGE_ID`: required by `package`. Exactly 10 letters or digits.
- `HARBOR_TIZEN_PROFILE`: signing profile from Certificate Manager (`tz security-profiles list`).
  Empty means the active profile.
- `HARBOR_TIZEN_SERIAL`: `sdb` serial. Empty means the only connected device.

## Targets

- **TV:** Developer Mode on, this PC's IP allowed, `sdb connect <tv-ip>`. The distributor
  certificate must contain the TV's DUID.
- **Emulator:** `tz emul list-vm`, then `tz emul launch -n <vm>`.
  - `tz emul launch` returns "terminated after timeout" while the VM is still booting. That is
    harmless.
  - Wait until `sdb devices` shows `device` instead of `offline`.
  - The local Samsung VM is Tizen 10. It proves boot, UI and focus. The Tizen 9.0 floor is
    proven on the reference TV, GU43DU7199UXZG.
- **Web Simulator:** fallback when no emulator runs. It is a desktop Chromium shell, so it only
  shows that the page loads over `file://`. It has no AVPlay and no real key events.

## Checking a boot

1. Run `node scripts/tizen.mjs debug` and note the port.
2. Run `HARBOR_CDP_PORT=<port> node scripts/harbor-diag.mjs eval "document.getElementById('root').childElementCount"`.

The boot watchdog (`src-tizen/boot-watchdog.js`) logs `[boot] mounted in Nms` on success. It logs
every load or script error with a `[boot]` prefix. If nothing mounted after 30s, it shows the
errors on screen.
