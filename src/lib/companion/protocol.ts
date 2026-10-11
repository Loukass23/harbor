/**
 * Wire contract for companion pairing: a device that cannot host a server (a
 * TV) finds a Harbor on the LAN, asks to pair over HTTP on the web server port,
 * and receives this payload once the desktop user approves. The desktop builds
 * it and the device validates it, so both sides share these shapes.
 */

import { parseHandoffPayload, type HandoffPayload } from "@/lib/tv-handoff/handoff-protocol";

export const COMPANION_PROTO = 1;
export const COMPANION_PATH = "/api/companion";

export type CompanionSection = "stremio" | "tmdb" | "debrid" | "addons";

export const COMPANION_SECTIONS: readonly CompanionSection[] = [
  "stremio",
  "tmdb",
  "debrid",
  "addons",
];

export const DEBRID_KEYS = ["rdKey", "tbKey", "adKey", "pmKey", "dlKey"] as const;
export type DebridKey = (typeof DEBRID_KEYS)[number];

export type CompanionAddon = { id: string; transportUrl: string };

export type CompanionPayload = {
  proto: number;
  /** The same tmdb and stremio steps the phone hand-off delivers. */
  handoff: HandoffPayload[];
  debrid: Partial<Record<DebridKey, string>>;
  addons: CompanionAddon[];
};

/** What `GET /api/companion/identity` answers. */
export type CompanionIdentity = {
  app: "harbor";
  proto: number;
  instanceId: string;
  name: string;
  platform: string;
  version: string;
  streamServer: { running: boolean; port: number | null };
};

/** The `companion://pair-request` event the desktop shows a dialog for. */
export type CompanionPairRequest = {
  requestId: string;
  deviceId: string;
  deviceName: string;
  code: string;
  /** The device was paired before. */
  repeat: boolean;
};

export type CompanionPollResult =
  | { status: "pending" | "denied" | "expired" }
  | { status: "approved"; token: string; payload: CompanionPayload };

export const MAX_ADDONS = 100;
const DEBRID_KEY_RE = /^[A-Za-z0-9._~+/=-]{8,256}$/;
const ADDON_ID_RE = /^[A-Za-z0-9._:@-]{1,200}$/;
const ID_RE = /^[0-9a-f]{32}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseAddon(v: unknown): CompanionAddon | null {
  if (!isRecord(v)) return null;
  const { id, transportUrl } = v;
  if (typeof id !== "string" || !ADDON_ID_RE.test(id)) return null;
  if (typeof transportUrl !== "string" || transportUrl.length > 2048) return null;
  if (!/^https?:\/\/[^\s]+$/i.test(transportUrl)) return null;
  return { id, transportUrl };
}

/** Hostile input from the LAN: every field is shape-checked, unknown fields dropped. */
export function parseCompanionPayload(v: unknown): CompanionPayload | null {
  if (!isRecord(v) || v.proto !== COMPANION_PROTO) return null;
  const handoff = Array.isArray(v.handoff)
    ? v.handoff
        .map(parseHandoffPayload)
        .filter((p): p is HandoffPayload => p !== null && p.step !== "harbor")
    : [];
  const debrid: CompanionPayload["debrid"] = {};
  if (isRecord(v.debrid)) {
    for (const key of DEBRID_KEYS) {
      const value = v.debrid[key];
      if (typeof value === "string" && DEBRID_KEY_RE.test(value)) debrid[key] = value;
    }
  }
  const addons = Array.isArray(v.addons)
    ? v.addons
        .slice(0, MAX_ADDONS)
        .map(parseAddon)
        .filter((a): a is CompanionAddon => a !== null)
    : [];
  return { proto: COMPANION_PROTO, handoff, debrid, addons };
}

export function parseCompanionIdentity(v: unknown): CompanionIdentity | null {
  if (!isRecord(v) || v.app !== "harbor" || typeof v.proto !== "number") return null;
  if (typeof v.instanceId !== "string" || !ID_RE.test(v.instanceId)) return null;
  const name = typeof v.name === "string" ? v.name.slice(0, 64).trim() : "";
  const server = isRecord(v.streamServer) ? v.streamServer : {};
  const port =
    typeof server.port === "number" && Number.isInteger(server.port) && server.port > 0
      ? server.port
      : null;
  return {
    app: "harbor",
    proto: v.proto,
    instanceId: v.instanceId,
    name: name || "Harbor",
    platform: typeof v.platform === "string" ? v.platform.slice(0, 32) : "",
    version: typeof v.version === "string" ? v.version.slice(0, 32) : "",
    streamServer: { running: server.running === true, port },
  };
}

export function parseCompanionPoll(v: unknown): CompanionPollResult | null {
  if (!isRecord(v)) return null;
  if (v.status === "pending" || v.status === "denied" || v.status === "expired") {
    return { status: v.status };
  }
  if (v.status !== "approved") return null;
  if (typeof v.token !== "string" || !TOKEN_RE.test(v.token)) return null;
  const payload = parseCompanionPayload(v.payload);
  return payload ? { status: "approved", token: v.token, payload } : null;
}
