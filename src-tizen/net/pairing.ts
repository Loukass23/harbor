import {
  COMPANION_PATH,
  parseCompanionPoll,
  type CompanionIdentity,
  type CompanionPollResult,
} from "@/lib/companion/protocol";
import { HARBOR_PORT } from "./discovery";

// The TV side of pairing. The computer holds the request; the TV asks, then
// long-polls until the person at the computer answers or the request expires.

const REQUEST_TIMEOUT_MS = 5000;
/** The computer holds each poll for up to 25s. */
const POLL_TIMEOUT_MS = 30_000;
const RETRY_MS = 2000;
/** The computer forgets a request after two minutes; stop a little later. */
const GIVE_UP_MS = 130_000;

export type PairError = "unreachable" | "busy" | "invalid";

function base(host: string): string {
  return `http://${host}:${HARBOR_PORT}${COMPANION_PATH}`;
}

async function call(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal, cache: "no-store" });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Four digits, shown on both screens. */
export function pairingCode(random: () => number = Math.random): string {
  return String(Math.floor(random() * 10_000)).padStart(4, "0");
}

export async function requestPairing(opts: {
  fetchImpl: typeof fetch;
  host: string;
  deviceId: string;
  deviceName: string;
  code: string;
}): Promise<{ requestId: string } | { error: PairError }> {
  const resp = await call(
    opts.fetchImpl,
    `${base(opts.host)}/pair`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: opts.deviceId,
        deviceName: opts.deviceName,
        code: opts.code,
      }),
    },
    REQUEST_TIMEOUT_MS,
  );
  if (!resp) return { error: "unreachable" };
  if (resp.status === 429) return { error: "busy" };
  if (!resp.ok) return { error: "invalid" };
  const body = (await resp.json().catch(() => null)) as { requestId?: unknown } | null;
  return typeof body?.requestId === "string" && /^[0-9a-f]{32}$/.test(body.requestId)
    ? { requestId: body.requestId }
    : { error: "invalid" };
}

/**
 * Polls until the computer answers. A dropped poll is retried, since Wi-Fi on
 * a TV blinks; only the request's own lifetime ends the wait.
 */
export async function waitForAnswer(opts: {
  fetchImpl: typeof fetch;
  host: string;
  requestId: string;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<CompanionPollResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + GIVE_UP_MS;
  while (!opts.signal?.aborted && now() < deadline) {
    const resp = await call(
      opts.fetchImpl,
      `${base(opts.host)}/pair/${opts.requestId}`,
      { method: "GET" },
      POLL_TIMEOUT_MS,
      opts.signal,
    );
    const result = resp?.ok ? parseCompanionPoll(await resp.json().catch(() => null)) : null;
    if (result && result.status !== "pending") return result;
    if (!result) await sleep(RETRY_MS);
  }
  return { status: "expired" };
}

/**
 * The address of the computer's streaming server, starting it when it is
 * not running. Null when the computer refuses or cannot start it.
 */
export async function streamServerUrl(opts: {
  fetchImpl: typeof fetch;
  host: string;
  identity: CompanionIdentity;
  token: string;
}): Promise<string | null> {
  const { running, port } = opts.identity.streamServer;
  if (running && port) return `http://${opts.host}:${port}`;
  const resp = await call(
    opts.fetchImpl,
    `${base(opts.host)}/stream-server`,
    { method: "POST", headers: { authorization: `Bearer ${opts.token}` } },
    15_000,
  );
  if (!resp?.ok) return null;
  const body = (await resp.json().catch(() => null)) as { port?: unknown } | null;
  return typeof body?.port === "number" && Number.isInteger(body.port)
    ? `http://${opts.host}:${body.port}`
    : null;
}
