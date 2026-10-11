import {
  initialPlayerSnapshot,
  type PlayerBridge,
  type PlayerCapabilities,
  type PlayerSnapshot,
  type PlayerSource,
  type TrackInfo,
} from "@/lib/player/bridge";
import type { CueTracks } from "./cue-tracks";
import type { AvplayListener, AvplayTrack, Webapis } from "./webapis";

/** prepareAsync can hang forever on a manifest it cannot parse (lessons.md). */
export const PREPARE_TIMEOUT_MS = 30_000;
/** Seconds AVPlay buffers before it starts and after a stall. */
const BUFFER_SECONDS = 5;
const CUE_TICK_MS = 100;
/** Same window as the HTML5 bridge: no resume seek into the first or last 5s. */
const RESUME_EDGE_SEC = 5;

export const AVPLAY_CLASS = "harbor-avplay";

type ClassListLike = { add(name: string): void; remove(name: string): void };

export type AvplayDocument = {
  visibilityState: string;
  documentElement: { classList: ClassListLike };
  createElement(tag: "object"): HTMLElement;
  addEventListener(type: "visibilitychange", fn: () => void): void;
  removeEventListener(type: "visibilitychange", fn: () => void): void;
};

export type AvplayWindow = {
  innerWidth: number;
  screen: { width: number };
  addEventListener(type: "resize", fn: () => void): void;
  removeEventListener(type: "resize", fn: () => void): void;
};

export type AvplayDeps = {
  doc: AvplayDocument;
  win: AvplayWindow;
  cues: (onChange: () => void) => CueTracks;
  /** Monotonic milliseconds, for the subtitle clock between AVPlay's time callbacks. */
  now?: () => number;
};

type ErrorCode = NonNullable<PlayerSnapshot["errorCode"]>;

/** AVPlay error names (onerror type or the prepareAsync error's name) to Harbor's codes. */
export function avplayErrorCode(raw: unknown): ErrorCode {
  const name = (
    typeof raw === "string" ? raw : ((raw as { name?: string } | null)?.name ?? "")
  ).toUpperCase();
  if (/CONNECTION|NETWORK|TIMEOUT|TIMED_OUT/.test(name)) return "network";
  if (/INVALID_URI|NOT_FOUND|NO_SUCH_FILE|INVALID_PARAMETER/.test(name)) return "source";
  if (/NOT_SUPPORTED_(FILE|FORMAT)|UNSUPPORTED|CODEC/.test(name)) return "codec";
  if (/DECODE|RESOURCE|GENER/.test(name)) return "decode";
  return "unknown";
}

function parseExtra(track: AvplayTrack): Record<string, unknown> {
  try {
    const v = JSON.parse(track.extra_info) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function field(extra: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const [k, v] of Object.entries(extra)) {
    if (names.includes(k.toLowerCase()) && v != null && v !== "") return String(v);
  }
  return undefined;
}

type Rect = { x: number; y: number; w: number; h: number };

/** The largest rect with the video's aspect ratio centred in `box`, in whole pixels. */
export function fitRect(box: Rect, videoW: number, videoH: number): Rect {
  let { x, y, w, h } = box;
  if (videoW > 0 && videoH > 0 && w > 0 && h > 0) {
    const aspect = videoW / videoH;
    if (w / h > aspect) {
      const fitted = h * aspect;
      x += (w - fitted) / 2;
      w = fitted;
    } else {
      const fitted = w / aspect;
      y += (h - fitted) / 2;
      h = fitted;
    }
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

export function readAvplayTracks(tracks: AvplayTrack[], selectedAudio: number | null) {
  const audio: TrackInfo[] = [];
  let width = 0;
  let height = 0;
  for (const t of tracks) {
    const extra = parseExtra(t);
    if (t.type === "VIDEO") {
      width ||= Number(field(extra, "width")) || 0;
      height ||= Number(field(extra, "height")) || 0;
    } else if (t.type === "AUDIO") {
      const lang = field(extra, "language", "lang");
      const channels = Number(field(extra, "channels")) || undefined;
      const codec = field(extra, "fourcc", "codec");
      audio.push({
        id: `avplay-audio-${t.index}`,
        label: lang ? lang.toUpperCase() : `Audio ${audio.length + 1}`,
        lang,
        kind: "audio",
        selected: selectedAudio == null ? audio.length === 0 : t.index === selectedAudio,
        codec,
        channelCount: channels,
      });
    }
  }
  return { audio, width, height };
}

/**
 * Samsung AVPlay behind Harbor's PlayerBridge. The video plays on a hardware
 * plane behind the webview, so the page above it goes transparent while this
 * bridge is attached. Every rule here comes from lessons.md → AVPlay.
 */
export function createAvplayBridge(api: Webapis, deps: AvplayDeps): PlayerBridge {
  const av = api.avplay;
  const { doc, win } = deps;
  const now = deps.now ?? (() => performance.now());
  let snap: PlayerSnapshot = initialPlayerSnapshot();
  const listeners = new Set<(s: PlayerSnapshot) => void>();
  let host: HTMLElement | null = null;
  let surface: HTMLElement | null = null;
  /** Bumped by every load and teardown, so callbacks from an older source are ignored. */
  let gen = 0;
  let opened = false;
  let prepared = false;
  let wantPlay = false;
  let pendingStartSec: number | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let cueTimer: ReturnType<typeof setInterval> | null = null;
  let suspended = false;
  let selectedAudio: number | null = null;
  let current: PlayerSource | null = null;
  let clockSec = 0;
  let clockAt = 0;

  const emit = () => {
    const next = { ...snap };
    listeners.forEach((l) => l(next));
  };
  const cues = deps.cues(() => {
    syncCues();
    emit();
  });

  const state = () => {
    try {
      return av.getState();
    } catch {
      return "NONE";
    }
  };

  const positionSec = () =>
    snap.status === "playing" ? clockSec + (now() - clockAt) / 1000 : clockSec;

  const syncCues = () => {
    cues.tick(positionSec());
    snap.subText = cues.text.subText;
    snap.subStartSec = cues.text.subStartSec;
    snap.secondarySubText = cues.text.secondarySubText;
    snap.subDelaySec = cues.delaySec();
    snap.subtitleTracks = cues.list();
  };

  const startCueTicker = () => {
    if (cueTimer != null) return;
    cueTimer = setInterval(() => {
      const before = snap.subText + "\u0000" + snap.secondarySubText;
      syncCues();
      if (snap.subText + "\u0000" + snap.secondarySubText !== before) emit();
    }, CUE_TICK_MS);
  };

  const stopCueTicker = () => {
    if (cueTimer == null) return;
    clearInterval(cueTimer);
    cueTimer = null;
  };

  const clearWatchdog = () => {
    if (watchdog == null) return;
    clearTimeout(watchdog);
    watchdog = null;
  };

  const durationSec = () => {
    try {
      return Math.max(0, av.getDuration() / 1000);
    } catch {
      return 0;
    }
  };

  const fail = (g: number, code: ErrorCode, message: string | null) => {
    if (g !== gen) return;
    clearWatchdog();
    wantPlay = false;
    snap.status = "error";
    snap.errorCode = code;
    snap.errorMessage = message;
    snap.buffering = false;
    emit();
  };

  // Screen pixels, not CSS pixels (lessons.md). The webview lays out at
  // 1140 CSS px across a 1920 px screen with devicePixelRatio 1, so the ratio
  // is useless here; scale by screen width over viewport width instead.
  // AVPlay's letterbox mode stretched a 2.39:1 picture to 16:9 on the TV, so
  // the rect is fitted to the video's own aspect and drawn at full size.
  const applyRect = () => {
    if (!host || !opened) return;
    const r = host.getBoundingClientRect();
    const s = win.innerWidth > 0 ? win.screen.width / win.innerWidth : 1;
    const rect = fitRect(
      { x: r.left * s, y: r.top * s, w: r.width * s, h: r.height * s },
      snap.videoWidth,
      snap.videoHeight,
    );
    try {
      av.setDisplayRect(rect.x, rect.y, rect.w, rect.h);
    } catch (err) {
      console.warn("[avplay] setDisplayRect failed", err);
    }
  };

  // The duration reads 0 right after prepare, so the resume seek waits for a
  // real one (lessons.md) and is retried from the time callback.
  const tryResumeSeek = () => {
    if (pendingStartSec == null || !prepared) return;
    const dur = durationSec();
    if (dur <= 0) return;
    const start = pendingStartSec;
    pendingStartSec = null;
    if (start <= RESUME_EDGE_SEC || start >= dur - RESUME_EDGE_SEC) return;
    clockSec = start;
    clockAt = now();
    try {
      av.seekTo(Math.round(start * 1000));
    } catch (err) {
      console.warn("[avplay] resume seek failed", err);
    }
  };

  const readTracks = () => {
    // AVPlay picks the container's default audio, which is often not the first
    // track: ask which one plays instead of assuming. Asked separately because
    // it throws InvalidStateError at times the full list does not, and a throw
    // must not empty the list the player picks the preferred language from.
    let playing: number | undefined;
    try {
      playing = av.getCurrentStreamInfo?.().find((t) => t.type === "AUDIO")?.index;
    } catch (err) {
      console.warn("[avplay] current stream info failed", err);
    }
    try {
      const info = readAvplayTracks(
        av.getTotalTrackInfo?.() ?? [],
        selectedAudio ?? playing ?? null,
      );
      snap.audioTracks = info.audio;
      if (info.width && info.height) {
        snap.videoWidth = info.width;
        snap.videoHeight = info.height;
      }
    } catch (err) {
      console.warn("[avplay] track info failed", err);
    }
  };

  const startPlayback = () => {
    try {
      av.play();
      clockAt = now();
      snap.status = "playing";
    } catch (err) {
      fail(gen, avplayErrorCode(err), "play failed");
    }
  };

  const listenerFor = (g: number): AvplayListener => ({
    onbufferingstart: () => {
      if (g !== gen) return;
      snap.buffering = true;
      emit();
    },
    onbufferingcomplete: () => {
      if (g !== gen) return;
      snap.buffering = false;
      emit();
    },
    oncurrentplaytime: (ms) => {
      if (g !== gen) return;
      clockSec = ms / 1000;
      clockAt = now();
      snap.positionSec = clockSec;
      if (snap.durationSec <= 0) snap.durationSec = durationSec();
      if (!snap.firstFrameReady) snap.firstFrameReady = true;
      tryResumeSeek();
      emit();
    },
    onstreamcompleted: () => {
      if (g !== gen) return;
      wantPlay = false;
      snap.status = "ended";
      snap.positionSec = snap.durationSec;
      emit();
    },
    onerror: (type) => {
      console.warn("[avplay] error", type);
      fail(g, avplayErrorCode(type), String(type));
    },
    onevent: (type, data) => {
      if (g !== gen) return;
      console.info("[avplay] event", type, data);
    },
  });

  const closeAv = () => {
    clearWatchdog();
    if (state() !== "NONE") {
      try {
        av.stop();
      } catch {}
      try {
        av.close();
      } catch {}
    }
    opened = false;
    prepared = false;
  };

  const onVisibility = () => {
    if (!opened) return;
    if (doc.visibilityState === "hidden") {
      if (suspended) return;
      // Nothing resumes on its own after the app comes back (platform/lifecycle.ts).
      if (state() === "PLAYING") {
        try {
          av.pause();
        } catch {}
      }
      wantPlay = false;
      clockSec = positionSec();
      if (snap.status === "playing") snap.status = "paused";
      try {
        av.suspend?.();
        suspended = true;
      } catch (err) {
        console.warn("[avplay] suspend failed", err);
      }
      emit();
      return;
    }
    if (!suspended) return;
    suspended = false;
    const at = clockSec;
    try {
      av.restore?.();
    } catch (err) {
      console.warn("[avplay] restore failed", err);
    }
    // On GU43DU7199UXZG restore() leaves AVPlay in IDLE at 0:00 with nothing
    // prepared, so the stream is reopened at the saved position, paused.
    const s = state();
    if (current && s !== "READY" && s !== "PAUSED" && s !== "PLAYING") {
      openSource(current, at, true);
    }
  };

  const unhook = () => {
    doc.removeEventListener("visibilitychange", onVisibility);
    win.removeEventListener("resize", applyRect);
    doc.documentElement.classList.remove(AVPLAY_CLASS);
    if (surface?.parentElement) surface.parentElement.removeChild(surface);
    surface = null;
    host = null;
  };

  const teardown = () => {
    gen += 1;
    wantPlay = false;
    suspended = false;
    stopCueTicker();
    closeAv();
  };

  /**
   * Opens `src` and prepares it. A reopen after resume keeps the subtitles and
   * the audio track the viewer had; a new load starts both from the source.
   */
  const openSource = (src: PlayerSource, startAtSec: number | null, reopen: boolean) => {
    teardown();
    const g = gen;
    current = src;
    pendingStartSec = startAtSec;
    clockSec = startAtSec ?? 0;
    clockAt = now();
    snap = {
      ...snap,
      status: "loading",
      positionSec: clockSec,
      durationSec: 0,
      bufferedSec: 0,
      buffering: false,
      firstFrameReady: false,
      audioTracks: [],
      videoWidth: 0,
      videoHeight: 0,
      errorCode: null,
      errorMessage: null,
      noAudio: false,
    };
    if (!reopen) cues.reset(src.subtitles);
    syncCues();
    startCueTicker();
    emit();

    const lower = src.url.toLowerCase().split("?")[0];
    const adaptive = lower.endsWith(".m3u8") || lower.endsWith(".mpd");
    try {
      // Straight to open(): no HEAD or probe first. Debrid and torrent hosts
      // answer those with 405/403, and AVPlay follows redirects itself.
      av.open(src.url);
      opened = true;
      // applyRect fits the rect to the video, so AVPlay fills it exactly.
      av.setDisplayMethod?.("PLAYER_DISPLAY_MODE_FULL_SCREEN");
      applyRect();
      av.setListener(listenerFor(g));
      // Streaming and buffering properties only take effect in IDLE, before
      // prepareAsync. BUFFER_SIZE is never set: with setBufferingParam it
      // corrupts the buffering state.
      if (av.setBufferingParam) {
        av.setBufferingParam(
          "PLAYER_BUFFER_FOR_PLAY",
          "PLAYER_BUFFER_SIZE_IN_SECOND",
          BUFFER_SECONDS,
        );
        av.setBufferingParam(
          "PLAYER_BUFFER_FOR_RESUME",
          "PLAYER_BUFFER_SIZE_IN_SECOND",
          BUFFER_SECONDS,
        );
      }
      const ua = Object.entries(src.headers ?? {}).find(
        ([k]) => k.toLowerCase() === "user-agent",
      )?.[1];
      if (ua) av.setStreamingProperty?.("USER_AGENT", ua);
      if (adaptive && api.productinfo?.isUdPanelSupported?.()) {
        av.setStreamingProperty?.("SET_MODE_4K", "TRUE");
      }
    } catch (err) {
      console.warn("[avplay] open failed", err);
      fail(g, avplayErrorCode(err), "open failed");
      return;
    }

    watchdog = setTimeout(() => {
      watchdog = null;
      if (g !== gen || prepared) return;
      console.warn("[avplay] prepareAsync timed out");
      fail(g, "decode", "prepare timed out");
    }, PREPARE_TIMEOUT_MS);

    av.prepareAsync(
      () => {
        if (g !== gen) return;
        clearWatchdog();
        prepared = true;
        if (reopen && selectedAudio != null) {
          try {
            av.setSelectTrack?.("AUDIO", selectedAudio);
          } catch (err) {
            console.warn("[avplay] audio track restore failed", err);
          }
        }
        readTracks();
        applyRect();
        snap.durationSec = durationSec();
        snap.status = "ready";
        tryResumeSeek();
        if (wantPlay) startPlayback();
        emit();
      },
      (err) => {
        console.warn("[avplay] prepareAsync failed", err);
        fail(g, avplayErrorCode(err), "prepare failed");
      },
    );
  };

  return {
    attach(h) {
      host = h;
      const el = doc.createElement("object");
      el.setAttribute("type", "application/avplayer");
      el.style.position = "absolute";
      el.style.inset = "0";
      el.style.width = "100%";
      el.style.height = "100%";
      h.appendChild(el);
      surface = el;
      doc.documentElement.classList.add(AVPLAY_CLASS);
      doc.addEventListener("visibilitychange", onVisibility);
      win.addEventListener("resize", applyRect);
    },
    detach() {
      teardown();
      unhook();
    },
    async load(src: PlayerSource) {
      selectedAudio = null;
      openSource(src, src.startAtSec ?? null, false);
    },
    async play() {
      wantPlay = true;
      if (!prepared) return;
      const s = state();
      if (s === "READY" || s === "PAUSED") {
        startPlayback();
        emit();
      }
    },
    pause() {
      wantPlay = false;
      if (state() !== "PLAYING") return;
      try {
        av.pause();
      } catch {}
      clockSec = positionSec();
      snap.status = "paused";
      emit();
    },
    seek(sec) {
      if (!prepared) {
        pendingStartSec = sec;
        return;
      }
      const dur = durationSec();
      const target = Math.max(0, dur > 0 ? Math.min(sec, dur - 0.25) : sec);
      clockSec = target;
      clockAt = now();
      snap.positionSec = target;
      try {
        av.seekTo(Math.round(target * 1000));
      } catch (err) {
        console.warn("[avplay] seek failed", err);
      }
      syncCues();
      emit();
    },
    // AVPlay has no volume or mute of its own; the remote drives the TV's
    // volume. The values stay in the snapshot so the player UI stays coherent.
    setVolume(v) {
      snap.volume = Math.max(0, Math.min(6, v));
      emit();
    },
    setMuted(m) {
      snap.muted = m;
      emit();
    },
    setRate(r) {
      // AVPlay accepts whole speeds only.
      if (!Number.isInteger(r) || !av.setSpeed) return;
      try {
        av.setSpeed(r);
        clockSec = positionSec();
        clockAt = now();
        snap.rate = r;
        emit();
      } catch (err) {
        console.warn("[avplay] setSpeed failed", err);
      }
    },
    setAudioTrack(id) {
      const index = Number(id.replace(/^avplay-audio-/, ""));
      if (!Number.isInteger(index) || !av.setSelectTrack) return;
      try {
        av.setSelectTrack("AUDIO", index);
        selectedAudio = index;
        readTracks();
        emit();
      } catch (err) {
        console.warn("[avplay] audio track switch failed", err);
      }
    },
    canAutoSelectSubtitle: () => cues.canAutoSelect(),
    // Never setSelectTrack("TEXT"): it crashes the decoder on streams without
    // sidecar subtitles. Text always goes through the DOM overlay.
    setSubtitleTrack: (id, origin) => cues.select(id, origin),
    setSecondarySubtitleTrack: (id) => cues.selectSecondary(id),
    setSubVisible() {},
    setSubHideSdh: (on) => cues.setHideSdh(on),
    setSubDelay: (sec) => cues.setDelay(sec),
    setAudioDelay() {},
    setPanscan() {},
    setVideoZoom() {},
    setAspectOverride() {},
    setStretch() {},
    setVideoEq() {},
    setAnime4kShaders() {},
    addSubtitle: (url, lang, title, select, metadata, origin) =>
      cues.add(url, lang, title, select, metadata, origin),
    getSelectedTrackCues: () => cues.selectedCues(),
    getSelectedTrackUrl: () => cues.selectedUrl(),
    setAudioNormalize() {},
    async screenshot() {
      return { ok: false, error: "not supported by AVPlay" };
    },
    setAbLoop() {},
    async requestPiP() {},
    async exitPiP() {},
    async requestFullscreen() {},
    async exitFullscreen() {},
    capabilities(): PlayerCapabilities {
      return {
        engine: "html5",
        pictureInPicture: false,
        airplay: false,
        chromecast: false,
        hdrPassthrough: true,
        hardwareDecode: true,
      };
    },
    subscribe(l) {
      listeners.add(l);
      l({ ...snap });
      return () => {
        listeners.delete(l);
      };
    },
    destroy() {
      teardown();
      unhook();
      cues.destroy();
      listeners.clear();
    },
  };
}
