import { mountTvApp } from "@/tv-mount";
import "@/index.css";

// The Tizen entry. src-tizen/vite.config.ts swaps it in for src/main-tv.tsx
// inside index-tv.html, so both TV targets share one page and one app.

void mountTvApp();
