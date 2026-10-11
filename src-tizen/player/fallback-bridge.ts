import type { PlayerBridge, PlayerSnapshot, PlayerSource } from "@/lib/player/bridge";

type AddSubtitleArgs = Parameters<PlayerBridge["addSubtitle"]>;

/** Errors that mean "this engine can't play it" rather than "the source is gone". */
function wantsFallback(s: PlayerSnapshot, sawFrame: boolean): boolean {
  if (s.status !== "error") return false;
  if (s.errorCode === "decode" || s.errorCode === "codec") return true;
  return !sawFrame;
}

/**
 * Plays through `primary` and switches to `fallback` once per source when the
 * primary can't start it or can't decode it, instead of leaving a black screen.
 * The switch keeps the position, the subtitles added since the load and the
 * listener's settings; the failing snapshot is never shown.
 */
export function createFallbackBridge(
  primary: () => PlayerBridge,
  fallback: () => PlayerBridge,
): PlayerBridge {
  let current = primary();
  let onPrimary = true;
  let host: HTMLElement | null = null;
  let source: PlayerSource | null = null;
  let last: PlayerSnapshot | null = null;
  let sawFrame = false;
  let wantPlay = false;
  let switched = false;
  let addedSubs: AddSubtitleArgs[] = [];
  const listeners = new Set<(s: PlayerSnapshot) => void>();
  const settings: { [K in keyof PlayerBridge]?: () => void } = {};
  let off: (() => void) | null = null;

  const remember = <K extends keyof PlayerBridge>(key: K, apply: () => void) => {
    settings[key] = apply;
    apply();
  };

  const onSnap = (s: PlayerSnapshot) => {
    if (s.firstFrameReady) sawFrame = true;
    if (onPrimary && !switched && source && wantsFallback(s, sawFrame)) {
      console.warn("[avplay] falling back to HTML5:", s.errorCode, s.errorMessage);
      void switchToFallback();
      return;
    }
    last = s;
    listeners.forEach((l) => l(s));
  };

  const switchToFallback = async () => {
    switched = true;
    const resumeAt = last && last.positionSec > 0 ? last.positionSec : source?.startAtSec;
    off?.();
    current.destroy();
    current = fallback();
    onPrimary = false;
    if (host) current.attach(host);
    off = current.subscribe(onSnap);
    for (const apply of Object.values(settings)) apply?.();
    if (!source) return;
    await current.load({ ...source, startAtSec: resumeAt });
    for (const args of addedSubs) void current.addSubtitle(...args);
    if (wantPlay) await current.play();
  };

  off = current.subscribe(onSnap);

  return {
    attach(h) {
      host = h;
      current.attach(h);
    },
    detach() {
      host = null;
      current.detach();
    },
    async load(src) {
      source = src;
      sawFrame = false;
      wantPlay = false;
      addedSubs = [];
      if (!onPrimary) {
        // A new source gets the better engine again.
        off?.();
        current.destroy();
        current = primary();
        onPrimary = true;
        if (host) current.attach(host);
        off = current.subscribe(onSnap);
        for (const apply of Object.values(settings)) apply?.();
      }
      switched = false;
      await current.load(src);
    },
    async play(options) {
      wantPlay = true;
      await current.play(options);
    },
    pause() {
      wantPlay = false;
      current.pause();
    },
    seek: (sec, precision) => current.seek(sec, precision),
    frameStep: (dir) => current.frameStep?.(dir),
    setVolume: (v) => remember("setVolume", () => current.setVolume(v)),
    setMuted: (m) => remember("setMuted", () => current.setMuted(m)),
    setRate: (r) => remember("setRate", () => current.setRate(r)),
    setAudioTrack: (id) => current.setAudioTrack(id),
    setSubtitleTrack: (id, origin) => current.setSubtitleTrack(id, origin),
    canAutoSelectSubtitle: () => current.canAutoSelectSubtitle?.() ?? true,
    setSecondarySubtitleTrack: (id) => current.setSecondarySubtitleTrack(id),
    setSubVisible: (v) => remember("setSubVisible", () => current.setSubVisible(v)),
    setSubHideSdh: (on) => remember("setSubHideSdh", () => current.setSubHideSdh?.(on)),
    setSubDelay: (sec) => remember("setSubDelay", () => current.setSubDelay(sec)),
    setAudioDelay: (sec) => remember("setAudioDelay", () => current.setAudioDelay(sec)),
    setPanscan: (v) => current.setPanscan(v),
    setVideoZoom: (v) => current.setVideoZoom(v),
    setAspectOverride: (v) => current.setAspectOverride(v),
    setStretch: (on) => current.setStretch(on),
    setVideoEq: (name, value) => current.setVideoEq(name, value),
    setAnime4kShaders: (paths) => current.setAnime4kShaders(paths),
    async addSubtitle(...args) {
      addedSubs.push(args);
      return current.addSubtitle(...args);
    },
    getSelectedTrackCues: () => current.getSelectedTrackCues(),
    getSelectedTrackUrl: () => current.getSelectedTrackUrl(),
    setAudioNormalize: (on) => current.setAudioNormalize(on),
    setMediaInfo: (info) => current.setMediaInfo?.(info),
    screenshot: (path) => current.screenshot(path),
    setAbLoop: (a, b) => current.setAbLoop(a, b),
    requestPiP: () => current.requestPiP(),
    exitPiP: () => current.exitPiP(),
    requestFullscreen: () => current.requestFullscreen(),
    exitFullscreen: () => current.exitFullscreen(),
    capabilities: () => current.capabilities(),
    subscribe(l) {
      listeners.add(l);
      if (last) l(last);
      return () => {
        listeners.delete(l);
      };
    },
    destroy() {
      off?.();
      off = null;
      current.destroy();
      listeners.clear();
    },
  };
}
