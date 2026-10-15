// Off in builds for the personal fork: Harbor's own servers are being shut down.
// Harbor-owned defaults then resolve to "", so callers build relative URLs that
// never leave the device. An explicit VITE_HARBOR_*_BASE override still applies.
export const HOSTED_FEATURES = import.meta.env.VITE_HARBOR_HOSTED !== "off";

// Off when there is no update feed to check (the harbor.site feed is gone).
export const UPDATER_ENABLED = import.meta.env.VITE_HARBOR_UPDATER !== "off";

function resolveBase(raw: string | undefined, fallback: string): string {
  const value = typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
  return value.replace(/\/+$/, "");
}

function resolveHostedBase(raw: string | undefined, fallback: string): string {
  return resolveBase(raw, HOSTED_FEATURES ? fallback : "");
}

export const HARBOR_API_BASE = resolveHostedBase(
  import.meta.env.VITE_HARBOR_API_BASE,
  "https://harbor.site",
);

export const HARBOR_TRAKT_BASE = resolveBase(
  import.meta.env.VITE_HARBOR_TRAKT_BASE,
  HARBOR_API_BASE,
);

export const HARBOR_MAL_BASE = resolveBase(import.meta.env.VITE_HARBOR_MAL_BASE, HARBOR_API_BASE);

export const HARBOR_TVDB_BASE = resolveBase(import.meta.env.VITE_HARBOR_TVDB_BASE, HARBOR_API_BASE);

export const HARBOR_BUGS_BASE = resolveHostedBase(
  import.meta.env.VITE_HARBOR_BUGS_BASE,
  "https://bugs.harbor.site",
);

export const HARBOR_SYNC_BASE = resolveHostedBase(
  import.meta.env.VITE_HARBOR_SYNC_BASE,
  "https://sync.harbor.site",
);

export const HARBOR_RELAY_BASE = resolveHostedBase(
  import.meta.env.VITE_HARBOR_RELAY_BASE,
  "https://app.harbor.site",
);

export const HARBOR_DISCORD_INVITE = resolveBase(
  import.meta.env.VITE_HARBOR_DISCORD_INVITE,
  "https://discord.gg/harbor",
);

/** True for a URL built from a Harbor base that is turned off (it starts with "/"). */
export function isDisabledHostedUrl(url: string): boolean {
  return !HOSTED_FEATURES && url.startsWith("/");
}
