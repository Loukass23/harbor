import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { hydrateCustomThemes } from "@/lib/custom-themes";
import { applyOsDataset } from "@/lib/platform";
import { getUiLanguage } from "@/lib/i18n/store";
import { ensureUiLocale } from "@/lib/i18n/load-locale";
import { loadSecrets } from "@/lib/secret-store";
import { BpTvApp } from "@/views/big-picture/bp-tv-app";
import "@/index.css";

// The Android TV entry. index.html / main.tsx stay the desktop entry and must
// never import this file: pulling BpTvApp into that graph changes the desktop
// bundle, which is the one thing this build is not allowed to do.
//
// No pip, modal, hdr or remote branch here on purpose. Those are separate
// desktop windows, and Android has exactly one webview.

applyOsDataset();

// Register Samsung Tizen remote keys so media controls and numpad emit standard keyboard events
function registerTizenKeys() {
  if (typeof window === "undefined") return;
  try {
    const tizenInput = (
      window as unknown as {
        tizen?: {
          tvinputdevice?: {
            registerKey: (name: string) => void;
          };
        };
      }
    ).tizen?.tvinputdevice;
    if (!tizenInput) return;

    const keysToRegister = [
      "MediaPlay",
      "MediaPause",
      "MediaPlayPause",
      "MediaStop",
      "MediaFastForward",
      "MediaRewind",
      "MediaTrackPrevious",
      "MediaTrackNext",
      "ColorF0Red",
      "ColorF1Green",
      "ColorF2Yellow",
      "ColorF3Blue",
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
    ];

    for (const key of keysToRegister) {
      try {
        tizenInput.registerKey(key);
      } catch {}
    }
  } catch {}
}

registerTizenKeys();
// reveal machinery is compiled into the Android binary.

async function mount() {
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

void mount();
