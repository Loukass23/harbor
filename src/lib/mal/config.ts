import { HARBOR_MAL_BASE, HOSTED_FEATURES } from "@/lib/config/endpoints";

function env(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

const OWN_CLIENT_ID = env(import.meta.env.VITE_MAL_CLIENT_ID);

export const MAL_AUTHORIZE_URL = "https://myanimelist.net/v1/oauth2/authorize";
export const MAL_TOKEN_URL = "https://myanimelist.net/v1/oauth2/token";
export const MAL_API_BASE = "https://api.myanimelist.net/v2";
export const MAL_DEVELOPER_URL = "https://myanimelist.net/apiconfig";
// Harbor's own client only works through Harbor's token proxy, which holds its secret.
export const MAL_CLIENT_ID = OWN_CLIENT_ID || (HOSTED_FEATURES ? "879be1ac300dc70611e5c828fec7bc18" : "");
// Only "Web" type MAL apps have a secret.
export const MAL_CLIENT_SECRET = env(import.meta.env.VITE_MAL_CLIENT_SECRET);
// Optional; when set it must match the redirect URL registered for the client.
export const MAL_REDIRECT_URI = env(import.meta.env.VITE_MAL_REDIRECT_URI);
export const MAL_TOKEN_PROXY = OWN_CLIENT_ID ? null : `${HARBOR_MAL_BASE}/api/mal/token`;
