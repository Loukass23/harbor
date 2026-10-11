import {
  emptySnapshot,
  type PlayerBridge,
  type PlayerSnapshot,
  type PlayerSource,
} from "@/lib/player/bridge";

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
 * listener's settings; the failing snapshot is never shown. `fallback` may be
 * async, so its code can stay out of the boot bundle until a switch needs it.
 */
export function createFallbackBridge(
  primary: () => PlayerBridge,
  fallback: () => PlayerBridge | Promise<PlayerBridge>,
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
  /** Viewer settings, replayed on whichever bridge plays. Keyed so a newer value replaces an older one. */
  const settings = new Map<string, () => void>();
  /** Subtitle selections, replayed once the fallback has the same tracks. */
  const selections = new Map<string, () => void>();
  let off: (() => void) | null = null;
  /** Bumped by every load and destroy, so an unfinished switch stops touching the player. */
  let switchToken = 0;

  const remember = (key: string, apply: () => void) => {
    settings.set(key, apply);
    apply();
  };
  const applySettings = () => settings.forEach((apply) => apply());

  const onSnap = (s: PlayerSnapshot) => {
    if (s.firstFrameReady) sawFrame = true;
    // The failing primary keeps reporting while the fallback loads; none of it is shown.
    if (onPrimary && switched) return;
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
    const token = ++switchToken;
    const src = source;
    const resumeAt = last && last.positionSec > 0 ? last.positionSec : src?.startAtSec;
    try {
      const next = await fallback();
      // A load or destroy during the wait owns the player now.
      if (token !== switchToken) {
        next.destroy();
        return;
      }
      off?.();
      current.destroy();
      current = next;
      onPrimary = false;
      if (host) current.attach(host);
      off = current.subscribe(onSnap);
      if (!src) return;
      await current.load({ ...src, startAtSec: resumeAt });
      if (token !== switchToken) return;
      // The HTML5 load() resets sub delay, mute and speed, so settings go on after it.
      applySettings();
      const subs = addedSubs.map((args) => current.addSubtitle(...args).catch(() => false));
      void Promise.all(subs).then(() => {
        if (token === switchToken) selections.forEach((apply) => apply());
      });
      if (wantPlay) await current.play();
    } catch (err) {
      console.error("[avplay] HTML5 fallback failed", err);
      if (token !== switchToken) return;
      const failed: PlayerSnapshot = {
        ...(last ?? emptySnapshot),
        status: "error",
        errorCode: "decode",
        errorMessage: "fallback failed",
      };
      last = failed;
      listeners.forEach((l) => l(failed));
    }
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
      switchToken += 1;
      source = src;
      selections.clear();
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
        applySettings();
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
    setSubtitleTrack(id, origin) {
      selections.set("main", () => current.setSubtitleTrack(id, origin));
      current.setSubtitleTrack(id, origin);
    },
    canAutoSelectSubtitle: () => current.canAutoSelectSubtitle?.() ?? true,
    setSecondarySubtitleTrack(id) {
      selections.set("secondary", () => current.setSecondarySubtitleTrack(id));
      current.setSecondarySubtitleTrack(id);
    },
    setSubVisible: (v) => remember("setSubVisible", () => current.setSubVisible(v)),
    setSubHideSdh: (on) => remember("setSubHideSdh", () => current.setSubHideSdh?.(on)),
    setSubDelay: (sec) => remember("setSubDelay", () => current.setSubDelay(sec)),
    setAudioDelay: (sec) => remember("setAudioDelay", () => current.setAudioDelay(sec)),
    setPanscan: (v) => remember("setPanscan", () => current.setPanscan(v)),
    setVideoZoom: (v) => remember("setVideoZoom", () => current.setVideoZoom(v)),
    setAspectOverride: (v) => remember("setAspectOverride", () => current.setAspectOverride(v)),
    setStretch: (on) => remember("setStretch", () => current.setStretch(on)),
    setVideoEq: (name, value) =>
      remember(`setVideoEq:${name}`, () => current.setVideoEq(name, value)),
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
      switchToken += 1;
      off?.();
      off = null;
      current.destroy();
      listeners.clear();
    },
  };
}
