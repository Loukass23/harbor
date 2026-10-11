import { useEffect, useRef } from "react";
import { safeFetch } from "@/lib/safe-fetch";
import { useSettings } from "@/lib/settings";
import { normalizeStreamServerUrl } from "@/lib/stremio-server";
import { loadCompanion, saveCompanion } from "./companion-store";
import { localAddress, sweepHosts } from "./network";
import { streamServerUrl } from "./pairing";
import { refindCompanion } from "./refind";

/** The saved server address with the computer's new host, keeping its port. */
function moved(serverUrl: string, host: string): string {
  try {
    const url = new URL(serverUrl);
    url.hostname = host;
    return url.origin;
  } catch {
    return serverUrl;
  }
}

/** After boot, give the first paint room before the network work starts. */
const START_DELAY_MS = 8000;

/**
 * Keeps the paired computer's streaming server address current: re-finds the
 * computer if its address moved and starts its server if it is off. Runs once
 * per launch, in the background, and never touches an address the user typed.
 */
export function CompanionRunner() {
  const { settings, update } = useSettings();
  const current = useRef(settings.remoteStreamServerUrl);
  current.current = settings.remoteStreamServerUrl;

  useEffect(() => {
    const saved = loadCompanion();
    if (!saved) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        const found = await refindCompanion({
          saved,
          fetchImpl: safeFetch,
          signal: ctrl.signal,
          hosts: async () => {
            const addr = await localAddress();
            return addr ? sweepHosts(addr) : [];
          },
        });
        if (!found || ctrl.signal.aborted) return;
        const raw = await streamServerUrl({
          fetchImpl: safeFetch,
          host: found.host,
          identity: found.identity,
          token: saved.token,
        });
        if (ctrl.signal.aborted) return;
        // Forgotten or replaced while this ran: the newer record wins.
        const latest = loadCompanion();
        if (latest?.instanceId !== saved.instanceId || latest.token !== saved.token) return;
        const serverUrl = raw ? normalizeStreamServerUrl(raw) : moved(saved.serverUrl, found.host);
        saveCompanion({ ...latest, host: found.host, name: found.identity.name, serverUrl });
        // Only replace the address pairing wrote. One the user typed or
        // cleared since then stays as they left it.
        if (current.current === saved.serverUrl && serverUrl && serverUrl !== current.current) {
          update({ remoteStreamServerUrl: serverUrl });
        }
      })().catch((e) => console.warn("[companion] refresh failed", e));
    }, START_DELAY_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // Once per launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
