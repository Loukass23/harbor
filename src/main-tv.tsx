import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { hydrateCustomThemes } from "@/lib/custom-themes";
import { applyOsDataset } from "@/lib/platform";
import { getUiLanguage } from "@/lib/i18n/store";
import { ensureUiLocale } from "@/lib/i18n/load-locale";
import { loadSecrets } from "@/lib/secret-store";
import { BpTvApp } from "@/views/big-picture/bp-tv-app";
import "@/index.css";
import "@/views/big-picture/bp-tv-gpu-nav.css";

// The Android TV entry. index.html / main.tsx stay the desktop entry and must
// never import this file: pulling BpTvApp into that graph changes the desktop
// bundle, which is the one thing this build is not allowed to do.
//
// No pip, modal, hdr or remote branch here on purpose. Those are separate
// desktop windows, and Android has exactly one webview.

applyOsDataset();

const isTizen = typeof window !== "undefined" && ("tizen" in window || "webapis" in window);
if (isTizen) {
  document.documentElement.dataset.os = "tizen";
  document.documentElement.setAttribute("data-input-modality", "keys");
  try {
    const tizenObj = (
      window as unknown as {
        tizen?: { tvinputdevice?: { registerKeyBatch?: (keys: string[]) => void } };
      }
    ).tizen;
    if (tizenObj?.tvinputdevice?.registerKeyBatch) {
      tizenObj.tvinputdevice.registerKeyBatch([
        "MediaPlay",
        "MediaPause",
        "MediaPlayPause",
        "MediaFastForward",
        "MediaRewind",
        "MediaStop",
        "Return",
        "0",
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
        "7",
        "8",
        "9",
      ]);
    }
  } catch (err) {
    console.warn("[tizen] registerKeyBatch failed", err);
  }
}

// No startup-ready ping here, and that is deliberate. Desktop sets
// visible:false on its window and reveals it from on_page_load inside the
// #[cfg(desktop)] run(); harbor_startup_ready only calls set_focus and is not
// registered in mobile.rs at all. Android is visible purely because
// tauri.android.conf.json replaces the whole windows array and omits the flag.
// Add visible:false there and the TV stays black forever, because none of the
// reveal machinery is compiled into the Android binary.

async function mount() {
  performance.mark("harbor:mount-start");
  // Check and apply backup preload if available (bundled or companion server)
  try {
    const { applyPreloadIfNeeded } = await import("@/lib/tizen-preload");
    await applyPreloadIfNeeded();
  } catch (err) {
    console.warn("[tizen] Preload check failed", err);
  }
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
  void import("@/lib/subtitles/subtitle-cache")
    .then((m) => m.initSubtitleCache())
    .catch(() => {});
}

void mount();
