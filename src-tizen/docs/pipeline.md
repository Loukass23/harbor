# Tizen pipeline

`node scripts/tizen.mjs <command...>` runs the commands in order, for example
`node scripts/tizen.mjs build package install launch`.

| Command     | What it does                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------- |
| `build`     | `vite build --config src-tizen/vite.config.ts` → `src-tizen/dist` (also `pnpm build:tizen`)       |
| `package`   | writes `config.xml` and `icon.png` into `dist`, then `tz pack` → `src-tizen/dist/Debug/dist.wgt`  |
| `zip`       | writes `config.xml` and `icon.png` into `dist`, then zips it unsigned → `src-tizen/dist-unsigned` |
| `install`   | `tz install` the `.wgt` on the device. Uninstalls first, so app data resets to onboarding         |
| `launch`    | `tz run` by package id                                                                            |
| `debug`     | restarts the app in debug mode, runs `sdb forward` and prints the CDP port                        |
| `logs`      | `sdb dlog` filtered to console messages (emulator only; empty on a retail TV, use `debug`)        |
| `simulator` | writes `config.xml` into `dist` and opens it in the Samsung TV Web Simulator (`tz run -r`)        |
| `seed`      | signs in to Stremio and writes API keys into the installed app (see below)                        |
| `deploy`    | `build package install launch`                                                                    |

## Settings

The settings live in `.env.tizen` (gitignored; copy `.env.tizen.example`). Values already in the
environment override it.

- `HARBOR_TIZEN_PACKAGE_ID`: required by `package`. Exactly 10 letters or digits.
- `HARBOR_TIZEN_PROFILE`: signing profile from Certificate Manager (`tz security-profiles list`).
  Empty means the active profile.
- `HARBOR_TIZEN_SERIAL`: `sdb` serial. Empty means the only connected device.
- `STREMIO_EMAIL`, `STREMIO_PASSWORD`, `TORBOX_API_KEY`, `TMDB_API_KEY`: optional, read only by
  `seed`.

## Seeding a test install

Every `install` resets the app, and typing an account on a remote is slow. After an install:

1. Skip or finish onboarding on the TV, so the app has an active profile.
2. Run `node scripts/tizen.mjs seed`. It restarts the app in debug mode, or reuses the inspector
   on `HARBOR_CDP_PORT` if that is set.

The script signs in to Stremio from this PC and sends only the resulting session to the TV,
never the password. It writes `TORBOX_API_KEY` and `TMDB_API_KEY` into the active profile's
settings and reloads the app. It prints which items it seeded, never their values. Use it for
development only. Real users sign in through the app.

## Release

The `.wgt` version is `package.json`'s `version`; `package` and `zip` reject anything outside
Tizen's `0-255.0-255.0-65535` range.

**CI** (`.github/workflows/tizen.yml`) runs on pull requests into any branch and pushes to
`tizen-next` that touch the app, `public/` or the Tizen scripts. It runs `pnpm test:tizen`, `pnpm build:tizen` (which fails over
`budget.json`) and `zip`, then uploads the unsigned `.wgt` and `src-tizen/.stats/bundle.json` as
the `harbor-tizen-<sha>` artifact for 14 days. The package id comes from the repository variable
`HARBOR_TIZEN_PACKAGE_ID`, or `HarborCI00` when it is unset. CI has no certificates.

**Signed builds stay local.** The TV refuses an unsigned `.wgt`. Either:

- build and sign here: `node scripts/tizen.mjs build package`; or
- sign a CI build: empty `src-tizen/dist`, extract the artifact's `.wgt` into it, then run
  `node scripts/tizen.mjs package`. Packaging rewrites `config.xml` with the local package id
  and `tz pack` signs with the local profile.

The signed `.wgt` is `src-tizen/dist/Debug/dist.wgt`.

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
