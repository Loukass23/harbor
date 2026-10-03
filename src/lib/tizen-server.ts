const KEY = "harbor_server_url";
const BUILD_DEFAULT = (import.meta.env.VITE_HARBOR_SERVER_URL as string | undefined) ?? "";

export function getCompanionServer(): string {
  try {
    const s = localStorage.getItem(KEY);
    if (s) return s.replace(/\/+$/, "");
  } catch {}
  // Thin shell: bundle is loaded from the server, so document.baseURI's origin is the server.
  try {
    const b = new URL(document.baseURI);
    if (b.protocol.startsWith("http")) return b.origin;
  } catch {}
  return BUILD_DEFAULT.replace(/\/+$/, "");
}

export function setCompanionServer(url: string) {
  try {
    localStorage.setItem(KEY, url.replace(/\/+$/, ""));
  } catch {}
}
