import { parseBackup, applyBackup } from "@/lib/backup";

const PRELOAD_DONE_KEY = "harbor.preload.applied.v1";

export async function applyPreloadIfNeeded(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (localStorage.getItem(PRELOAD_DONE_KEY)) return false;

  let text: string | null = null;

  // 1. Try bundled file first (build-time packaging into widget)
  try {
    const resp = await fetch("./preload-backup.harbx", { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      text = await resp.text();
      console.log("[preload] Found bundled backup file ./preload-backup.harbx");
    }
  } catch {}

  // 2. Fallback: fetch from companion server endpoint
  if (!text) {
    try {
      const server = localStorage.getItem("harbor_server_url") || "http://192.168.178.89:3001";
      const resp = await fetch(`${server}/api/backup/preload`, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        text = await resp.text();
        console.log(`[preload] Retrieved backup file from companion server: ${server}/api/backup/preload`);
      }
    } catch {}
  }

  if (!text) return false;

  const result = parseBackup(text);
  if (!result.ok) {
    console.warn("[preload] Backup validation failed:", result.error);
    return false;
  }

  try {
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
    localStorage.setItem(PRELOAD_DONE_KEY, new Date().toISOString());
    console.log(`[preload] Successfully applied backup with ${Object.keys(result.backup.data).length} keys!`);
    return true;
  } catch (err) {
    console.error("[preload] Error applying backup:", err);
    return false;
  }
}
