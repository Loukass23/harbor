import type { HandoffPayload } from "@/lib/tv-handoff/handoff-protocol";
import {
  COMPANION_PROTO,
  DEBRID_KEYS,
  MAX_ADDONS,
  parseCompanionPayload,
  type CompanionPayload,
  type CompanionSection,
  type DebridKey,
} from "./protocol";

export type CompanionSource = {
  stremioAuthKey: string | null;
  settings: { tmdbKey?: string } & Partial<Record<DebridKey, string>>;
  addons: ReadonlyArray<{ id: string; transportUrl: string }>;
};

/** Which sections have something to send, so the dialog only offers those. */
export function availableSections(source: CompanionSource): CompanionSection[] {
  const out: CompanionSection[] = [];
  if (source.stremioAuthKey) out.push("stremio");
  if (source.settings.tmdbKey?.trim()) out.push("tmdb");
  if (DEBRID_KEYS.some((k) => source.settings[k]?.trim())) out.push("debrid");
  if (source.addons.length > 0) out.push("addons");
  return out;
}

/**
 * Builds the payload for an approved device from the chosen sections. It goes
 * through the same parser the device uses, so the desktop never sends a value
 * the device would drop.
 */
export function buildCompanionPayload(
  sections: ReadonlySet<CompanionSection>,
  source: CompanionSource,
): CompanionPayload {
  const handoff: HandoffPayload[] = [];
  if (sections.has("stremio") && source.stremioAuthKey) {
    handoff.push({ step: "stremio", authKey: source.stremioAuthKey });
  }
  const tmdbKey = source.settings.tmdbKey?.trim();
  if (sections.has("tmdb") && tmdbKey) handoff.push({ step: "tmdb", key: tmdbKey });
  const debrid: CompanionPayload["debrid"] = {};
  if (sections.has("debrid")) {
    for (const key of DEBRID_KEYS) {
      const value = source.settings[key]?.trim();
      if (value) debrid[key] = value;
    }
  }
  const addons = sections.has("addons")
    ? source.addons.slice(0, MAX_ADDONS).map(({ id, transportUrl }) => ({ id, transportUrl }))
    : [];
  const raw = { proto: COMPANION_PROTO, handoff, debrid, addons };
  return (
    parseCompanionPayload(raw) ?? { proto: COMPANION_PROTO, handoff: [], debrid: {}, addons: [] }
  );
}
