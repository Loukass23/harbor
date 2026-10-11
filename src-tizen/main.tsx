import { mountTvApp } from "@/tv-mount";
import { installTizenPlatform } from "./platform";
import { installAvplay } from "./player";
import "@/index.css";

// The Tizen entry. src-tizen/vite.config.ts swaps it in for src/main-tv.tsx
// inside index-tv.html, so both TV targets share one page and one app.

// A platform failure costs remote keys, never the whole app: an exception here
// once stopped mountTvApp from running and left the boot splash up.
try {
  installTizenPlatform();
} catch (err) {
  console.error("[tizen] platform install failed", err);
}
// Without AVPlay the player stays on the HTML5 bridge, so this never blocks the mount.
try {
  if (!installAvplay()) console.warn("[tizen] webapis missing: playback uses the HTML5 bridge");
} catch (err) {
  console.error("[tizen] AVPlay install failed", err);
}
void mountTvApp();
