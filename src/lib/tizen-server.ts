const KEY = "harbor_server_url";
const BUILD_DEFAULT = (import.meta.env.VITE_HARBOR_SERVER_URL as string | undefined) ?? "";

export function getCompanionServer(): string {
  if (typeof window !== "undefined" && (window as any).__HARBOR_COMPANION_SERVER__) {
    const s = String((window as any).__HARBOR_COMPANION_SERVER__).trim();
    if (s) return s.replace(/\/+$/, "");
  }
  try {
    const s = localStorage.getItem(KEY);
    if (s && s.trim()) return s.trim().replace(/\/+$/, "");
  } catch {}
  try {
    const s2 = localStorage.getItem("harbor_companion_url");
    if (s2 && s2.trim()) return s2.trim().replace(/\/+$/, "");
  } catch {}
  // Thin shell: bundle is loaded from the server, so document.baseURI's origin is the server.
  try {
    const b = new URL(document.baseURI);
    if (b.protocol.startsWith("http")) return b.origin;
  } catch {}
  try {
    if (typeof window !== "undefined" && window.location.protocol.startsWith("http")) {
      return window.location.origin;
    }
  } catch {}
  return BUILD_DEFAULT.replace(/\/+$/, "");
}

export function setCompanionServer(url: string) {
  try {
    const clean = url.replace(/\/+$/, "");
    localStorage.setItem(KEY, clean);
    if (typeof window !== "undefined") {
      (window as any).__HARBOR_COMPANION_SERVER__ = clean;
    }
  } catch {}
}
