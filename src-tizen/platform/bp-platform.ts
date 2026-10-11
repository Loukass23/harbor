import type { BpPlatform } from "@/views/big-picture/bp-platform";

const IMAGE_TIMEOUT_MS = 15000;

/**
 * The webview applies no CORS to this packaged widget (see docs/lessons.md,
 * Network), so the bytes the desktop pulls through harbor_fetch come straight
 * from fetch here. fetch is passed in so tests can run without the app.
 */
export function createTizenBpPlatform(fetchImpl: typeof fetch, exit?: () => void): BpPlatform {
  return {
    // Nothing on the TV listens on a port, so there is no address a phone could
    // be sent to.
    lanAddress: async () => null,
    fetchImageBytes: async (url) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), IMAGE_TIMEOUT_MS);
      try {
        const resp = await fetchImpl(url, { signal: ctrl.signal });
        if (!resp.ok) return null;
        const blob = await resp.blob();
        return blob.size > 0 ? blob : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    ...(exit ? { exit } : {}),
  };
}
