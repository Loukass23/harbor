import type { CompanionIdentity } from "@/lib/companion/protocol";
import type { SavedCompanion } from "./companion-store";
import { probeHarbor, sweep, type ProbeOptions } from "./discovery";

/**
 * Finds the paired computer again. Home routers hand out addresses that move,
 * so when the saved host answers as someone else, or not at all, the subnet is
 * swept for the same instance id. Stops at the first match.
 */
export async function refindCompanion(opts: {
  saved: SavedCompanion;
  fetchImpl: typeof fetch;
  hosts: () => Promise<string[]>;
  signal?: AbortSignal;
}): Promise<{ host: string; identity: CompanionIdentity } | null> {
  const { saved, fetchImpl } = opts;
  const probeOpts: ProbeOptions = { fetchImpl, signal: opts.signal, timeoutMs: 1500 };
  const there = await probeHarbor(saved.host, probeOpts);
  if (there?.instanceId === saved.instanceId) return { host: saved.host, identity: there };
  if (opts.signal?.aborted) return null;

  const stop = new AbortController();
  const onAbort = () => stop.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let match: { host: string; identity: CompanionIdentity } | null = null;
  try {
    await sweep({
      hosts: (await opts.hosts()).filter((h) => h !== saved.host),
      fetchImpl,
      signal: stop.signal,
      probe: async (host, o) => {
        const identity = await probeHarbor(host, o);
        return identity?.instanceId === saved.instanceId
          ? { kind: "harbor", host, identity }
          : null;
      },
      onFound: (hit) => {
        if (hit.kind === "harbor") match = { host: hit.host, identity: hit.identity };
        stop.abort();
      },
    });
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
  return match;
}
