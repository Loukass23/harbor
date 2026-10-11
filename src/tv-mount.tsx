import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { hydrateCustomThemes } from "@/lib/custom-themes";
import { applyOsDataset } from "@/lib/platform";
import { getUiLanguage } from "@/lib/i18n/store";
import { ensureUiLocale } from "@/lib/i18n/load-locale";
import { loadSecrets } from "@/lib/secret-store";
import { BpTvApp } from "@/views/big-picture/bp-tv-app";

/**
 * Boot the shared television app into #root.
 *
 * Every TV entry calls this, so a second entry can install its own platform
 * hooks first and then mount the exact same app. The desktop entry must never
 * import it: pulling BpTvApp into that graph changes the desktop bundle.
 */
export async function mountTvApp(): Promise<void> {
  applyOsDataset();
  performance.mark("harbor:mount-start");
  await Promise.all([loadSecrets(), hydrateCustomThemes().catch(() => {})]);
  performance.mark("harbor:secrets-done");
  // Only the selected language, and only if it is not the one compiled in.
  // The other catalogs never enter this entry's graph.
  await ensureUiLocale(getUiLanguage());
  performance.mark("harbor:locale-done");
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <BpTvApp />
    </StrictMode>,
  );
  performance.mark("harbor:render-called");
  // The subtitle cache configures storage hooks that nothing reads until a
  // stream plays, and importing it up here put the whole subtitle stack in
  // front of the television's first paint. Loaded after the root is handed to
  // React so it parses on an idle frame instead of a critical one.
  void import("@/lib/subtitles/subtitle-cache").then((m) => m.initSubtitleCache()).catch(() => {});
}
