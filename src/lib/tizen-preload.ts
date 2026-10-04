import { parseBackup, applyBackup } from "@/lib/backup";
import { getCompanionServer } from "./tizen-server";

const PRELOAD_DONE_KEY = "harbor.preload.applied.v1";

export async function applyPreloadIfNeeded(): Promise<boolean> {
  if (typeof window === "undefined") return false;

  let text: string | null = null;

  // 1. Try bundled file first (build-time packaging into widget)
  try {
    const resp = await fetch("./preload-backup.harbx", { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const candidate = await resp.text();
      const parsedCandidate = parseBackup(candidate);
      if (parsedCandidate.ok) {
        text = candidate;
        console.log("[preload] Found valid bundled backup file ./preload-backup.harbx");
      }
    }
  } catch {}

  // 2. Fallback: fetch from companion server endpoint
  if (!text) {
    try {
      const server = getCompanionServer();
      if (server) {
        console.log(`[preload] Fetching backup from ${server}/api/backup/preload...`);
        const resp = await fetch(`${server}/api/backup/preload`, {
          signal: AbortSignal.timeout(6000),
        });
        if (resp.ok) {
          text = await resp.text();
          console.log(
            `[preload] Retrieved backup file from companion server: ${server}/api/backup/preload`,
          );
        } else {
          console.warn(`[preload] Server responded with status ${resp.status}`);
        }
      } else {
        console.warn("[preload] No companion server configured");
      }
    } catch (e) {
      console.warn("[preload] Companion server backup fetch error:", e);
    }
  }

  if (!text) return false;

  const result = parseBackup(text);
  if (!result.ok) {
    console.warn("[preload] Backup validation failed:", result.error);
    return false;
  }

  // Use exportedAt timestamp as the deduplication marker
  const appliedMarker = localStorage.getItem(PRELOAD_DONE_KEY);
  const targetMarker = result.backup.exportedAt || result.backup.app || "applied";
  const hasProfiles = !!localStorage.getItem("harbor.profiles.v1");

  if (appliedMarker === targetMarker && hasProfiles) {
    console.log(`[preload] Backup already applied (${targetMarker})`);
    return false;
  }

  try {
    console.log(
      `[preload] Applying backup (${targetMarker}) with ${Object.keys(result.backup.data).length} keys...`,
    );
    await applyBackup(result.backup);
    if (result.backup.sync) {
      if (result.backup.sync.idMap && Object.keys(result.backup.sync.idMap).length > 0) {
        localStorage.setItem("harbor.sync.idmap", JSON.stringify(result.backup.sync.idMap));
      }
      if (result.backup.sync.account) {
        localStorage.setItem("harbor.sync.account", result.backup.sync.account);
      }
      if (result.backup.sync.revs && Object.keys(result.backup.sync.revs).length > 0) {
        localStorage.setItem("harbor.sync.revs", JSON.stringify(result.backup.sync.revs));
      }
    }
    localStorage.setItem(PRELOAD_DONE_KEY, targetMarker);
    console.log(
      `[preload] Successfully applied backup with ${Object.keys(result.backup.data).length} keys!`,
    );
    return true;
  } catch (err) {
    console.error("[preload] Error applying backup:", err);
    return false;
  }
}
