import { useCallback, useEffect, useRef, useState } from "react";
import { installAddon, loadInstalled } from "@/lib/addon-store";
import type { CompanionPayload } from "@/lib/companion/protocol";
import { safeFetch } from "@/lib/safe-fetch";
import { useSettings } from "@/lib/settings";
import { normalizeStreamServerUrl } from "@/lib/stremio-server";
import { useHandoffApply } from "@/views/big-picture/onboarding/bp-handoff-apply";
import {
  clearCompanion,
  deviceId,
  loadCompanion,
  saveCompanion,
  type SavedCompanion,
} from "./companion-store";
import { sweep, type Found } from "./discovery";
import { tvName } from "./device-name";
import { localAddress, sweepHosts } from "./network";
import { pairingCode, requestPairing, streamServerUrl, waitForAnswer } from "./pairing";

type HarborFound = Extract<Found, { kind: "harbor" }>;

export type CompanionPhase =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "noNetwork" }
  | { kind: "waiting"; target: HarborFound; code: string }
  | { kind: "paired"; name: string; serverUrl: string }
  | { kind: "server"; url: string }
  | { kind: "failed"; reason: "denied" | "expired" | "unreachable" | "busy" | "invalid" };

/** Puts an approved payload where the rest of Harbor reads it. One failed part never blocks the rest. */
function useApplyPayload(): (payload: CompanionPayload) => Promise<void> {
  const applyHandoff = useHandoffApply();
  const { update } = useSettings();
  return useCallback(
    async (payload) => {
      for (const step of payload.handoff) {
        await applyHandoff(step).catch((e) =>
          console.warn("[companion] apply failed", step.step, e),
        );
      }
      if (Object.keys(payload.debrid).length > 0) update(payload.debrid);
      const have = new Set(loadInstalled().flatMap((a) => [a.id, a.transportUrl]));
      for (const addon of payload.addons) {
        if (have.has(addon.id) || have.has(addon.transportUrl)) continue;
        await installAddon(addon.id, addon.transportUrl).catch((e) =>
          console.warn("[companion] addon install failed", addon.id, e),
        );
      }
    },
    [applyHandoff, update],
  );
}

/** Scan, pair and forget, for the settings pane and the onboarding step. */
export function useCompanion() {
  const { settings, update } = useSettings();
  const apply = useApplyPayload();
  const [phase, setPhase] = useState<CompanionPhase>({ kind: "idle" });
  const [found, setFound] = useState<Found[]>([]);
  const [saved, setSaved] = useState<SavedCompanion | null>(() => loadCompanion());
  const run = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    run.current?.abort();
    run.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const fresh = useCallback(() => {
    stop();
    const ctrl = new AbortController();
    run.current = ctrl;
    return ctrl.signal;
  }, [stop]);

  const scan = useCallback(async () => {
    const signal = fresh();
    setFound([]);
    setPhase({ kind: "scanning" });
    const addr = await localAddress();
    if (signal.aborted) return;
    if (!addr) {
      setPhase({ kind: "noNetwork" });
      return;
    }
    await sweep({
      hosts: sweepHosts(addr),
      fetchImpl: safeFetch,
      signal,
      onFound: (hit) =>
        setFound((cur) =>
          // Harbor first: it pairs and brings settings, a bare server does neither.
          [...cur, hit].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "harbor" ? -1 : 1)),
        ),
    });
    if (!signal.aborted) setPhase({ kind: "idle" });
  }, [fresh]);

  const pair = useCallback(
    async (target: HarborFound) => {
      const signal = fresh();
      const code = pairingCode();
      setPhase({ kind: "waiting", target, code });
      const asked = await requestPairing({
        fetchImpl: safeFetch,
        host: target.host,
        deviceId: deviceId(),
        deviceName: tvName(),
        code,
      });
      if (signal.aborted) return;
      if ("error" in asked) {
        setPhase({ kind: "failed", reason: asked.error });
        return;
      }
      const answer = await waitForAnswer({
        fetchImpl: safeFetch,
        host: target.host,
        requestId: asked.requestId,
        signal,
      });
      if (signal.aborted) return;
      if (answer.status !== "approved") {
        setPhase({ kind: "failed", reason: answer.status === "denied" ? "denied" : "expired" });
        return;
      }
      await apply(answer.payload);
      const rawServerUrl =
        (await streamServerUrl({
          fetchImpl: safeFetch,
          host: target.host,
          identity: target.identity,
          token: answer.token,
        })) ?? "";
      const serverUrl = normalizeStreamServerUrl(rawServerUrl);
      const record: SavedCompanion = {
        instanceId: target.identity.instanceId,
        host: target.host,
        name: target.identity.name,
        token: answer.token,
        serverUrl,
      };
      saveCompanion(record);
      setSaved(record);
      if (serverUrl) update({ remoteStreamServerUrl: serverUrl });
      setPhase({ kind: "paired", name: target.identity.name, serverUrl });
    },
    [apply, fresh, update],
  );

  const chooseServer = useCallback(
    (url: string) => {
      stop();
      update({ remoteStreamServerUrl: normalizeStreamServerUrl(url) });
      setPhase({ kind: "server", url });
    },
    [stop, update],
  );

  const forget = useCallback(() => {
    stop();
    const current = loadCompanion();
    // Only take back the address pairing wrote; one typed in since stays.
    if (current?.serverUrl && settings.remoteStreamServerUrl === current.serverUrl) {
      update({ remoteStreamServerUrl: "" });
    }
    clearCompanion();
    setSaved(null);
    setPhase({ kind: "idle" });
  }, [settings.remoteStreamServerUrl, stop, update]);

  const cancel = useCallback(() => {
    stop();
    setPhase({ kind: "idle" });
  }, [stop]);

  return { phase, found, saved, scan, pair, chooseServer, forget, cancel };
}
