import { setWebPlayerEngine } from "@/lib/player/web-engine";
import { createAvplayBridge } from "./avplay-bridge";
import { createCueTracks } from "./cue-tracks";
import { createFallbackBridge } from "./fallback-bridge";
import { webapis } from "./webapis";
import "./avplay.css";

/** Plays through AVPlay, with the HTML5 bridge as the fallback. No-op without webapis. */
export function installAvplay(): boolean {
  const api = webapis();
  if (!api) return false;
  setWebPlayerEngine(() =>
    createFallbackBridge(
      () => createAvplayBridge(api, { doc: document, win: window, cues: createCueTracks }),
      // hls.js and mpegts.js come with it: loaded on the first fallback, not at boot.
      () => import("@/lib/player/html5").then((m) => m.createHtml5Bridge()),
    ),
  );
  return true;
}
