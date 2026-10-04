import { useEffect, useSyncExternalStore } from "react";
import { ensureThemePreviews, subscribeThemePreviews, themePreviewsVersion } from "./theme";

// Lazy theme-preview artwork. The 13 preview images (~11MB as PNG, ~0.7MB as
// WebP) used to be static imports in theme.ts, which put them on the boot
// path of every entry (main-tv included): parsed, decoded and shipped in the
// TV widget before first paint, while only Settings ever renders them.
//
// They now load on demand: consumers call useThemePreviews() (which triggers
// the load on mount and re-renders when the URLs land) and read
// preset.previewImage as before — undefined until hydrated, which every
// consumer already tolerates.
const loaders = import.meta.glob<string>("/src/assets/theme-previews/*.webp", {
  query: "?url",
  import: "default",
});

export function loadThemePreviewImage(file: string): Promise<string> {
  const key = Object.keys(loaders).find((k) => k.endsWith("/" + file));
  if (!key) return Promise.reject(new Error("unknown theme preview: " + file));
  return loaders[key]();
}

export function useThemePreviews(): number {
  useEffect(() => {
    void ensureThemePreviews();
  }, []);
  return useSyncExternalStore(subscribeThemePreviews, themePreviewsVersion, themePreviewsVersion);
}
