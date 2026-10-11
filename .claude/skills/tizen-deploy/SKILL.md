---
name: tizen-deploy
description: Build, package, install and launch Harbor on a Samsung Tizen TV, then stream its logs. Use when asked to deploy, install, run or try a change on the TV.
---

# Deploy to a Tizen TV

Prerequisites: Tizen Studio CLI (`tz`, `sdb`) on PATH, `.env.tizen` filled from
`.env.tizen.example`, and the TV in Developer Mode with this PC's IP allowed.
Never read or print `.env.tizen`; it holds the signing profile.

1. `pnpm check:tizen-boundary && pnpm run typecheck`. Stop on failure.
2. `node scripts/tizen.mjs build`: Vite `tizen` mode → `src-tizen/dist`.
3. `node scripts/tizen.mjs package`: signed `.wgt`.
4. `sdb devices`. If the TV is missing, `sdb connect <ip>` using the address the user gives you.
5. `node scripts/tizen.mjs install`, then `node scripts/tizen.mjs launch`.
6. `node scripts/tizen.mjs logs` for about 20 seconds. Report the boot time and any errors.

## Known failures

| Output                                    | Cause                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `Load archive info fail [118,-4]`         | package id isn't 10 alphanumeric characters                                 |
| `install failed` with a certificate error | TV DUID missing from the distributor certificate                            |
| `sdb` device `offline`                    | Developer Mode IP mismatch; reboot the TV after changing it                 |
| Black screen after launch                 | absolute asset path or `crossorigin` attribute; check the boot watchdog log |

If `scripts/tizen.mjs` doesn't exist yet, Phase 1 (shell and pipeline) hasn't landed.
Say so instead of improvising raw `tz` commands.
