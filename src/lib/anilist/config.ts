import { HARBOR_BUGS_BASE, HOSTED_FEATURES } from "@/lib/config/endpoints";

function env(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

const OWN_CLIENT_ID = env(import.meta.env.VITE_ANILIST_CLIENT_ID);

export const ANILIST_GRAPHQL_URL = "https://graphql.anilist.co";
export const ANILIST_AUTHORIZE_URL = "https://anilist.co/api/v2/oauth/authorize";
export const ANILIST_TOKEN_URL = "https://anilist.co/api/v2/oauth/token";
// The client's Redirect URL must be set to this exact value on AniList.
export const ANILIST_PIN_REDIRECT_URI = "https://anilist.co/api/v2/oauth/pin";
export const ANILIST_DEVELOPER_URL = "https://anilist.co/settings/developer";
// Harbor's own client only works through Harbor's exchange, which holds its secret.
export const ANILIST_CLIENT_ID = OWN_CLIENT_ID || (HOSTED_FEATURES ? "42941" : "");
export const ANILIST_CLIENT_SECRET = env(import.meta.env.VITE_ANILIST_CLIENT_SECRET);
export const ANILIST_TOKEN_EXCHANGE_URL = OWN_CLIENT_ID ? null : `${HARBOR_BUGS_BASE}/v1/anilist/token`;
