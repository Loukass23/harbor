import {
  COMPANION_PATH,
  parseCompanionIdentity,
  type CompanionIdentity,
} from "@/lib/companion/protocol";

// The TV can't hear mDNS or UDP broadcasts, so it asks every host on its
// subnet over HTTP (docs/lessons.md, Network). Nearly every address refuses
// or times out, so the timeout and the concurrency set how long a sweep takes.

export const HARBOR_PORT = 11471;
export const STREMIO_PORT = 11470;
const DEFAULT_CONCURRENCY = 24;
const DEFAULT_TIMEOUT_MS = 700;

export type Found =
  | { kind: "harbor"; host: string; identity: CompanionIdentity }
  | { kind: "stremio"; host: string; url: string };

export type ProbeOptions = {
  fetchImpl: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
};

// AbortSignal.timeout is missing on some firmware; a timer works everywhere.
async function getJson(
  url: string,
  { fetchImpl, timeoutMs, signal }: ProbeOptions,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const resp = await fetchImpl(url, { signal: ctrl.signal, cache: "no-store" });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function probeHarbor(
  host: string,
  opts: ProbeOptions,
): Promise<CompanionIdentity | null> {
  return parseCompanionIdentity(
    await getJson(`http://${host}:${HARBOR_PORT}${COMPANION_PATH}/identity`, opts),
  );
}

/** A Stremio server (or Harbor's engine) answers /settings with a values object. */
export async function probeStremio(host: string, opts: ProbeOptions): Promise<string | null> {
  const url = `http://${host}:${STREMIO_PORT}`;
  const body = await getJson(`${url}/settings`, opts);
  const values = (body as { values?: unknown } | null)?.values;
  return typeof values === "object" && values !== null ? url : null;
}

export async function probeHost(host: string, opts: ProbeOptions): Promise<Found | null> {
  const identity = await probeHarbor(host, opts);
  if (identity) return { kind: "harbor", host, identity };
  if (opts.signal?.aborted) return null;
  const url = await probeStremio(host, opts);
  return url ? { kind: "stremio", host, url } : null;
}

export type SweepOptions = ProbeOptions & {
  hosts: readonly string[];
  concurrency?: number;
  onFound?: (found: Found) => void;
  /** Probes one host; tests swap it. */
  probe?: (host: string, opts: ProbeOptions) => Promise<Found | null>;
};

/** Probes every host, at most `concurrency` at a time, reporting each find as it lands. */
export async function sweep(opts: SweepOptions): Promise<Found[]> {
  const { hosts, signal, onFound } = opts;
  const probe = opts.probe ?? probeHost;
  const found: Found[] = [];
  let next = 0;
  const worker = async () => {
    while (next < hosts.length && !signal?.aborted) {
      const host = hosts[next];
      next += 1;
      const hit = await probe(host, opts);
      if (hit && !signal?.aborted) {
        found.push(hit);
        onFound?.(hit);
      }
    }
  };
  const width = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, hosts.length));
  await Promise.all(Array.from({ length: width }, worker));
  return found;
}
