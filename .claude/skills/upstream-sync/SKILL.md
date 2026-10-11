---
name: upstream-sync
description: Merge the latest beta-branch into the Tizen branch safely and report seam conflicts. Use when asked to sync, update from upstream or pull beta-branch into the Tizen work.
---

# Sync beta-branch into the Tizen branch

1. `git status` must be clean. If it isn't, stop and ask.
2. `git fetch origin beta-branch`, then `git log --oneline HEAD..origin/beta-branch | wc -l`.
   For more than about 150 commits, merge in steps (pick intermediate merge commits) so each
   merge stays reviewable. Never merge `origin/tizen-beta`, `beta-tizen` or `origin/tizen`.
3. `git merge --no-ff origin/beta-branch`.
4. Resolve conflicts:
   - In `src/` seam files, keep upstream's code and re-apply only the seam.
   - In `src-tizen/`, adapt to the new upstream API.
5. Run `pnpm check:tizen-boundary`, `pnpm run typecheck`, `pnpm test` and `pnpm run check`
   on the changed files.
6. Report:
   - commits merged;
   - conflicts and how each was resolved;
   - upstream changes touching `src/views/big-picture/`, `src/lib/player/`, `src/lib/safe-fetch.ts`,
     `src/lib/streams/` or `vite.config.ts`, since those are the files the Tizen target depends on;
   - check results.
7. Don't push. Ask first.
