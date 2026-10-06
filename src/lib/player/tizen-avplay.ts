import {
  initialPlayerSnapshot,
  type PlayerBridge,
  type PlayerCapabilities,
  type PlayerSeekPrecision,
  type PlayerSnapshot,
  type PlayerSource,
  type TrackInfo,
} from "./bridge";
import { fetchAndParse, findActiveCue, type SubCue } from "@/lib/subtitles/parser";
import { SubtitlePreparationError, prepareSubtitle } from "@/lib/subtitles/prepare";
import { stripSdhText } from "@/lib/subtitles/sdh-filter";
import { subtitleTrackDownloadHeaders } from "@/lib/subtitles/provider-auth";
import { clearPendingSub, markPendingSub } from "@/lib/subtitles/pending-subs";
import { registerTranslationJob } from "@/lib/subtitles/translation-jobs";
import { noteSubtitleOrigin } from "@/lib/subtitles/subtitle-memory";
import { finishPlaybackTrace, markPlaybackTrace } from "@/lib/perf/playback-trace";
import {
  SubtitleSelectionCoordinator,
  type SubtitleSelectionOrigin,
} from "@/lib/player/subtitle-selection";
import { PreparedSubtitleSeedBatch } from "@/lib/subtitles/seed-batch";
import { isSafeProviderSubtitleUrl } from "@/lib/subtitles/provider-url";
import type { SubTrack } from "./html5/types";
import type { SubtitleLoadMetadata } from "@/lib/subtitles/types";

export type AVPlayState = "NONE" | "IDLE" | "READY" | "PLAYING" | "PAUSED";

export type AVPlayDisplayMode =
  | "PLAYER_DISPLAY_MODE_LETTER_BOX"
  | "PLAYER_DISPLAY_MODE_ORIGIN_SIZE"
  | "PLAYER_DISPLAY_MODE_FULL_SCREEN"
  | "PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO";

export type AVPlayStreamingProperty =
  | "SET_MODE_4K"
  | "ADAPTIVE_INFO"
  | "USER_AGENT"
  | "COOKIE"
  | "PROPERTY_HD_AUDIO"
  | "LISTEN_ADAPTIVE_INFO";

export type AVPlayTrackType = "AUDIO" | "TEXT" | "VIDEO";

export type AVPlayTrackInfo = {
  index: number;
  type: AVPlayTrackType;
  extra_info: string | Record<string, unknown>;
};

export type AVPlayListener = {
  onbufferingstart?: () => void;
  onbufferingprogress?: (percent: number) => void;
  onbufferingcomplete?: () => void;
  oncurrentplaytime?: (currentTimeMs: number) => void;
  onstreamcompleted?: () => void;
  onevent?: (eventType: string, eventData: string) => void;
  onerror?: (errorType: string) => void;
  onsubtitlechange?: (duration: number, text: string, data3?: string, data4?: string) => void;
  ondrmevent?: (drmEvent: string, drmData: unknown) => void;
};

export interface WebapisAVPlay {
  open(url: string): void;
  close(): void;
  prepare(): void;
  prepareAsync(successCallback?: () => void, errorCallback?: (error: unknown) => void): void;
  play(): void;
  pause(): void;
  stop(): void;
  seekTo(
    timeMs: number,
    successCallback?: () => void,
    errorCallback?: (error: unknown) => void,
  ): void;
  getState(): AVPlayState;
  getDuration(): number;
  getCurrentTime(): number;
  setListener(listener: AVPlayListener): void;
  setDisplayRect(x: number, y: number, width: number, height: number): void;
  setDisplayMethod(mode: AVPlayDisplayMode): void;
  setStreamingProperty(propertyType: AVPlayStreamingProperty | string, propertyValue: string): void;
  setExternalSubtitlePath(filePath: string): void;
  getTotalTrackInfo(): AVPlayTrackInfo[];
  getCurrentStreamInfo(): AVPlayTrackInfo[];
  setSelectTrack(trackType: AVPlayTrackType | string, trackIndex: number): void;
  setPlaybackRate(rate: number): void;
  suspend(): void;
  restore(): void;
}

export interface WebapisProductInfo {
  isUdPanelSupported(): boolean;
}

declare global {
  interface Window {
    webapis?: {
      avplay?: WebapisAVPlay;
      productinfo?: WebapisProductInfo;
    };
  }
}

export interface IPlayer {
  initialize(url: string, options?: TizenAVPlayerOptions): Promise<void> | void;
  play(): Promise<void> | void;
  pause(): void;
  stop(): void;
  seek(timeMs: number): void;
  destroy(): void;
}

export type TizenAVPlayerOptions = {
  startAtMs?: number;
  adaptiveInfo?: string;
  externalSubtitlePath?: string;
  displayRect?: { x: number; y: number; width: number; height: number };
  displayMethod?: AVPlayDisplayMode;
  webapis?: {
    avplay?: WebapisAVPlay;
    productinfo?: WebapisProductInfo;
  };
};

export type TizenAVPlayerCallbacks = {
  onBufferingStart?: () => void;
  onBufferingProgress?: (percent: number) => void;
  onBufferingComplete?: () => void;
  onTimeUpdate?: (timeMs: number) => void;
  onEnded?: () => void;
  onError?: (error: unknown) => void;
  onSubtitleChange?: (duration: number, text: string) => void;
  onStateChange?: (state: AVPlayState) => void;
  onReady?: () => void;
};

/**
 * Tizen AVPlay API abstraction with integrated lifecycle best practices:
 * - Strict state machine (NONE -> IDLE -> READY -> PLAYING/PAUSED)
 * - 4K panel detection & configuration in IDLE state
 * - Adaptive bitrate configuration in IDLE state
 * - External subtitle path configuration in IDLE state
 * - App visibilitychange suspend/restore lifecycle handling
 */
export class TizenAVPlayer implements IPlayer {
  private state: AVPlayState = "NONE";
  private avplay: WebapisAVPlay | null = null;
  private productinfo: WebapisProductInfo | null = null;
  private displayRect = { x: 0, y: 0, width: 1920, height: 1080 };
  private wasSuspended = false;
  private visibilityListener: (() => void) | null = null;
  private callbacks: TizenAVPlayerCallbacks;

  constructor(
    callbacks: TizenAVPlayerCallbacks = {},
    options?: { webapis?: TizenAVPlayerOptions["webapis"] },
  ) {
    this.callbacks = callbacks;
    if (options?.webapis) {
      this.avplay = options.webapis.avplay ?? null;
      this.productinfo = options.webapis.productinfo ?? null;
    }
  }

  private resolveWebapis(): { avplay: WebapisAVPlay; productinfo?: WebapisProductInfo } {
    if (this.avplay) {
      return { avplay: this.avplay, productinfo: this.productinfo ?? undefined };
    }
    const winWebapis = typeof window !== "undefined" ? window.webapis : undefined;
    if (winWebapis?.avplay) {
      this.avplay = winWebapis.avplay;
      this.productinfo = winWebapis.productinfo ?? null;
      return { avplay: winWebapis.avplay, productinfo: winWebapis.productinfo };
    }
    throw new Error("Samsung webapis.avplay is not available on this platform.");
  }

  public getState(): AVPlayState {
    if (this.avplay) {
      try {
        return this.avplay.getState();
      } catch {
        return this.state;
      }
    }
    return this.state;
  }

  public initialize(url: string, options?: TizenAVPlayerOptions): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        if (options?.webapis) {
          this.avplay = options.webapis.avplay ?? null;
          this.productinfo = options.webapis.productinfo ?? null;
        }
        const { avplay, productinfo } = this.resolveWebapis();

        // If the player is already active, close it to enter NONE state
        if (this.state !== "NONE") {
          try {
            if (this.state === "PLAYING" || this.state === "PAUSED" || this.state === "READY") {
              avplay.stop();
            }
            avplay.close();
          } catch {}
          this.state = "NONE";
        }

        // 1. Enters IDLE state
        avplay.open(url);
        this.state = "IDLE";
        this.callbacks.onStateChange?.("IDLE");

        // 2. Enable 4K if supported (must be in IDLE state)
        try {
          if (productinfo?.isUdPanelSupported?.()) {
            avplay.setStreamingProperty("SET_MODE_4K", "TRUE");
          }
        } catch (e) {
          console.warn("[tizen-avplay] Failed setting 4K mode:", e);
        }

        // 3. Adaptive Streaming config (must be in IDLE state)
        try {
          const adaptive = options?.adaptiveInfo ?? "STARTBITRATE=HIGHEST";
          avplay.setStreamingProperty("ADAPTIVE_INFO", adaptive);
        } catch (e) {
          console.warn("[tizen-avplay] Failed setting ADAPTIVE_INFO:", e);
        }

        // 4. External subtitles (must be set in IDLE state)
        if (options?.externalSubtitlePath) {
          try {
            avplay.setExternalSubtitlePath(options.externalSubtitlePath);
          } catch (e) {
            console.warn("[tizen-avplay] Failed setting external subtitle path:", e);
          }
        }

        // 5. Display rect & mode
        if (options?.displayRect) {
          this.displayRect = options.displayRect;
        }
        try {
          avplay.setDisplayRect(
            this.displayRect.x,
            this.displayRect.y,
            this.displayRect.width,
            this.displayRect.height,
          );
          avplay.setDisplayMethod(options?.displayMethod ?? "PLAYER_DISPLAY_MODE_LETTER_BOX");
        } catch (e) {
          console.warn("[tizen-avplay] Failed setting display geometry:", e);
        }

        // 6. Set event listener callbacks
        avplay.setListener({
          onbufferingstart: () => {
            this.callbacks.onBufferingStart?.();
          },
          onbufferingprogress: (percent) => {
            this.callbacks.onBufferingProgress?.(percent);
          },
          onbufferingcomplete: () => {
            this.callbacks.onBufferingComplete?.();
          },
          oncurrentplaytime: (currentTimeMs) => {
            this.callbacks.onTimeUpdate?.(currentTimeMs);
          },
          onstreamcompleted: () => {
            this.state = "IDLE";
            this.callbacks.onStateChange?.("IDLE");
            this.callbacks.onEnded?.();
          },
          onerror: (errorType) => {
            this.state = "NONE";
            this.callbacks.onStateChange?.("NONE");
            this.callbacks.onError?.(errorType);
          },
          onsubtitlechange: (duration, text) => {
            this.callbacks.onSubtitleChange?.(duration, text);
          },
        });

        // 7. Setup visibilitychange listener for background suspend/restore
        this.setupVisibilityListener(avplay);

        // 8. Prepare async to enter READY state
        avplay.prepareAsync(
          () => {
            this.state = "READY";
            this.callbacks.onStateChange?.("READY");
            this.callbacks.onReady?.();
            if (options?.startAtMs && options.startAtMs > 0) {
              try {
                this.seek(options.startAtMs);
              } catch {}
            }
            resolve();
          },
          (error) => {
            this.state = "NONE";
            this.callbacks.onStateChange?.("NONE");
            this.callbacks.onError?.(error);
            reject(error);
          },
        );
      } catch (err) {
        this.state = "NONE";
        this.callbacks.onError?.(err);
        reject(err);
      }
    });
  }

  private setupVisibilityListener(avplay: WebapisAVPlay) {
    if (this.visibilityListener || typeof document === "undefined") return;
    this.visibilityListener = () => {
      try {
        if (document.hidden) {
          if (this.state === "PLAYING" || this.state === "PAUSED" || this.state === "READY") {
            avplay.suspend();
            this.wasSuspended = true;
          }
        } else if (this.wasSuspended) {
          avplay.restore();
          this.wasSuspended = false;
        }
      } catch (err) {
        console.warn("[tizen-avplay] Visibility change suspend/restore failed:", err);
      }
    };
    document.addEventListener("visibilitychange", this.visibilityListener);
  }

  public play(): void {
    if (!this.avplay) return;
    if (this.state !== "READY" && this.state !== "PAUSED") return;
    this.avplay.play();
    this.state = "PLAYING";
    this.callbacks.onStateChange?.("PLAYING");
  }

  public pause(): void {
    if (!this.avplay) return;
    if (this.state !== "PLAYING") return;
    this.avplay.pause();
    this.state = "PAUSED";
    this.callbacks.onStateChange?.("PAUSED");
  }

  public stop(): void {
    if (!this.avplay) return;
    if (this.state === "NONE" || this.state === "IDLE") return;
    try {
      this.avplay.stop();
    } catch {}
    this.state = "IDLE";
    this.callbacks.onStateChange?.("IDLE");
  }

  public close(): void {
    if (!this.avplay) return;
    if (this.state === "NONE") return;
    try {
      if (this.state !== "IDLE") {
        this.avplay.stop();
      }
      this.avplay.close();
    } catch {}
    this.state = "NONE";
    this.callbacks.onStateChange?.("NONE");
  }

  public seek(timeMs: number): void {
    if (!this.avplay) return;
    if (this.state !== "READY" && this.state !== "PLAYING" && this.state !== "PAUSED") return;
    this.avplay.seekTo(
      Math.max(0, Math.round(timeMs)),
      () => {},
      (e) => console.error("[tizen-avplay] Seek failed:", e),
    );
  }

  public setDisplayRect(x: number, y: number, width: number, height: number): void {
    this.displayRect = { x, y, width, height };
    if (!this.avplay || this.state === "NONE") return;
    try {
      this.avplay.setDisplayRect(x, y, width, height);
    } catch (e) {
      console.warn("[tizen-avplay] Failed to update display rect:", e);
    }
  }

  public setPlaybackRate(rate: number): void {
    if (!this.avplay) return;
    if (this.state !== "PLAYING" && this.state !== "PAUSED") return;
    try {
      this.avplay.setPlaybackRate(rate);
    } catch (e) {
      console.warn("[tizen-avplay] Failed to set playback rate:", e);
    }
  }

  public getDuration(): number {
    if (!this.avplay) return 0;
    if (this.state !== "READY" && this.state !== "PLAYING" && this.state !== "PAUSED") return 0;
    try {
      return this.avplay.getDuration();
    } catch {
      return 0;
    }
  }

  public getCurrentTime(): number {
    if (!this.avplay) return 0;
    if (this.state !== "READY" && this.state !== "PLAYING" && this.state !== "PAUSED") return 0;
    try {
      return this.avplay.getCurrentTime();
    } catch {
      return 0;
    }
  }

  public getTotalTrackInfo(): AVPlayTrackInfo[] {
    if (!this.avplay) return [];
    if (this.state === "NONE" || this.state === "IDLE") return [];
    try {
      return this.avplay.getTotalTrackInfo() || [];
    } catch {
      return [];
    }
  }

  public setSelectTrack(trackType: AVPlayTrackType | string, trackIndex: number): void {
    if (!this.avplay) return;
    if (this.state === "NONE" || this.state === "IDLE") return;
    try {
      this.avplay.setSelectTrack(trackType, trackIndex);
    } catch (e) {
      console.warn("[tizen-avplay] Failed to select track:", e);
    }
  }

  public destroy(): void {
    if (this.visibilityListener && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityListener);
      this.visibilityListener = null;
    }
    this.close();
    this.avplay = null;
    this.productinfo = null;
  }
}

export type CreateAvplayBridgeOptions = {
  webapis?: TizenAVPlayerOptions["webapis"];
  defaultDisplayRect?: { x: number; y: number; width: number; height: number };
};

export function createAvplayBridge(bridgeOptions?: CreateAvplayBridgeOptions): PlayerBridge {
  let snap: PlayerSnapshot = initialPlayerSnapshot();
  const listeners = new Set<(s: PlayerSnapshot) => void>();
  let host: HTMLElement | null = null;
  let activeTraceId: string | null = null;
  let mediaRevision = 0;
  let pendingVolume = 1;
  let subDelaySec = 0;
  let hideSdh = false;
  let cueTickerRaf: number | null = null;
  let lastCueId = "";
  let lastSecondRaw: string | null = null;
  let lastSecondText = "";
  const subTracks: SubTrack[] = [];
  let activeSubId: string | null = null;
  let secondarySubId: string | null = null;
  const mainSubtitleSelection = new SubtitleSelectionCoordinator();
  const secondarySubtitleSelection = new SubtitleSelectionCoordinator();

  const emit = () => {
    const next: PlayerSnapshot = { ...snap };
    listeners.forEach((l) => l(next));
  };

  const readCustomSubtitleTracks = (): TrackInfo[] => {
    return subTracks.map((t) => ({
      id: t.id,
      label: t.title || (t.lang ? t.lang.toUpperCase() : "Subtitle"),
      lang: t.lang,
      title: t.title,
      kind: "subtitle" as const,
      selected: t.id === activeSubId,
      secondary: t.id === secondarySubId,
      external: t.external,
      prepared: t.metadata?.prepared === true || (t.cues != null && t.cues.length > 0),
      autoSelectionEligible: t.metadata?.autoSelectionEligible,
      url: t.originalUrl ?? t.url,
      originalUrl: t.metadata?.originalUrl ?? t.originalUrl,
      downloadAuth: t.metadata?.downloadAuth,
      format: t.metadata?.format,
      release: t.metadata?.release,
      provider: t.metadata?.provider,
      providerDerived: t.metadata?.providerDerived,
      fps: t.metadata?.fps,
      downloads: t.metadata?.downloads,
      author: t.metadata?.author,
      uploadedAt: t.metadata?.uploadedAt,
      rating: t.metadata?.rating,
      productionType: t.metadata?.productionType,
      releaseType: t.metadata?.releaseType,
      hearingImpaired: t.metadata?.hearingImpaired,
      forced: t.metadata?.forced,
      foreignOnly: t.metadata?.foreignOnly,
      machineTranslated: t.metadata?.machineTranslated,
      fromTrusted: t.metadata?.fromTrusted,
      providerMatch: t.metadata?.providerMatch,
      timingStatus: t.metadata?.timingStatus,
      timingMeasurementStatus: t.metadata?.timingMeasurementStatus,
      matchExplanation: t.metadata?.matchExplanation,
      matchScore: t.metadata?.matchScore,
      matchConfidence: t.metadata?.matchConfidence,
      matchReasons: t.metadata?.matchReasons,
      subId: t.metadata?.subId,
    }));
  };

  const readNativeTracks = (
    avTracks: AVPlayTrackInfo[],
  ): { audio: TrackInfo[]; subs: TrackInfo[] } => {
    const audio: TrackInfo[] = [];
    const subs: TrackInfo[] = [];

    avTracks.forEach((t) => {
      let lang = "";
      if (typeof t.extra_info === "string") {
        try {
          const parsed = JSON.parse(t.extra_info) as { language?: string };
          lang = parsed.language || "";
        } catch {
          lang = t.extra_info;
        }
      } else if (t.extra_info && typeof t.extra_info === "object") {
        lang = (t.extra_info as { language?: string }).language || "";
      }

      if (t.type === "AUDIO") {
        audio.push({
          id: `tizen-audio-${t.index}`,
          label: lang ? lang.toUpperCase() : `Audio Track ${t.index + 1}`,
          lang: lang || undefined,
          kind: "audio",
          selected: audio.length === 0, // default first
        });
      } else if (t.type === "TEXT") {
        subs.push({
          id: `tizen-sub-${t.index}`,
          label: lang ? lang.toUpperCase() : `Subtitle ${t.index + 1}`,
          lang: lang || undefined,
          kind: "subtitle",
          selected: false,
          external: false,
        });
      }
    });

    return { audio, subs };
  };

  const tickCues = () => {
    const currentTimeSec = player.getCurrentTime() / 1000;
    const t = currentTimeSec - subDelaySec;
    let changed = false;

    const track = subTracks.find((s) => s.id === activeSubId);
    if (!track || !track.cues) {
      if (snap.subText !== "") {
        snap.subText = "";
        snap.subStartSec = 0;
        changed = true;
      }
    } else {
      const cue = findActiveCue(track.cues, t);
      const cueId = cue ? `${cue.start}|${cue.text}` : "";
      if (cueId !== lastCueId) {
        lastCueId = cueId;
        const raw = cue?.text ?? "";
        snap.subText = hideSdh ? stripSdhText(raw) : raw;
        snap.subStartSec = cue?.start ?? 0;
        changed = true;
      }
    }

    const second = secondarySubId ? subTracks.find((s) => s.id === secondarySubId) : null;
    const secondCue = second?.cues ? findActiveCue(second.cues, t) : null;
    const secondRaw = secondCue?.text ?? "";
    if (secondRaw !== lastSecondRaw) {
      lastSecondRaw = secondRaw;
      lastSecondText = hideSdh ? stripSdhText(secondRaw) : secondRaw;
    }
    if (lastSecondText !== snap.secondarySubText) {
      snap.secondarySubText = lastSecondText;
      changed = true;
    }

    if (changed) emit();
  };

  const cueTickLoop = () => {
    cueTickerRaf = null;
    tickCues();
    cueTickerRaf = window.requestAnimationFrame(cueTickLoop);
  };

  const startCueTicker = () => {
    if (cueTickerRaf != null) return;
    cueTickerRaf = window.requestAnimationFrame(cueTickLoop);
  };

  const stopCueTicker = () => {
    if (cueTickerRaf == null) return;
    window.cancelAnimationFrame(cueTickerRaf);
    cueTickerRaf = null;
  };

  const disposeSubtitleTracks = () => {
    for (const track of subTracks) track.cleanup?.();
    subTracks.length = 0;
  };

  const player = new TizenAVPlayer(
    {
      onBufferingStart: () => {
        snap.buffering = true;
        emit();
      },
      onBufferingProgress: (percent) => {
        const dur = snap.durationSec || 0;
        if (dur > 0) {
          snap.bufferedSec = Math.max(snap.bufferedSec, (percent / 100) * dur);
        }
        emit();
      },
      onBufferingComplete: () => {
        snap.buffering = false;
        emit();
      },
      onTimeUpdate: (timeMs) => {
        snap.positionSec = timeMs / 1000;
        tickCues();
        emit();
      },
      onEnded: () => {
        snap.status = "ended";
        stopCueTicker();
        emit();
      },
      onError: (err) => {
        snap.status = "error";
        snap.errorMessage = typeof err === "string" ? err : "AVPlay playback error";
        snap.errorCode = "decode";
        stopCueTicker();
        emit();
      },
      onSubtitleChange: (_duration, text) => {
        // If native player surfaces subtitle text and no custom track is active
        if (!activeSubId && text) {
          snap.subText = hideSdh ? stripSdhText(text) : text;
          emit();
        }
      },
      onReady: () => {
        const durMs = player.getDuration();
        snap.durationSec = durMs > 0 ? durMs / 1000 : 0;
        snap.firstFrameReady = true;

        const native = readNativeTracks(player.getTotalTrackInfo());
        if (native.audio.length > 0) {
          snap.audioTracks = native.audio;
        }
        snap.subtitleTracks = [...readCustomSubtitleTracks(), ...native.subs];

        if (activeTraceId) {
          markPlaybackTrace(activeTraceId, "first-frame");
          finishPlaybackTrace(activeTraceId, "ready");
          activeTraceId = null;
        }

        snap.status = "ready";
        emit();
      },
      onStateChange: (state) => {
        if (state === "PLAYING") {
          snap.status = "playing";
          startCueTicker();
        } else if (state === "PAUSED") {
          snap.status = "paused";
        } else if (state === "IDLE") {
          if (snap.status !== "ended") snap.status = "idle";
          stopCueTicker();
        }
        emit();
      },
    },
    { webapis: bridgeOptions?.webapis },
  );

  const ensureLoaded = (track: SubTrack): Promise<boolean> => {
    if (track.cues) return Promise.resolve(track.cues.length > 0);
    if (track.loadingPromise) return track.loadingPromise;
    const requestMediaRevision = mediaRevision;
    track.loading = true;
    const loadingPromise = (async () => {
      try {
        if (/^https?:/i.test(track.url)) {
          const prepared = await prepareSubtitle({
            url: track.url,
            format: track.metadata?.format,
            encoding: track.metadata?.encoding,
            language: track.lang,
            release: track.metadata?.release,
            filename: track.metadata?.rawFilename,
            requestHeaders: subtitleTrackDownloadHeaders(
              track.metadata?.downloadAuth,
              track.url,
              track.metadata?.providerDerived ?? Boolean(track.metadata?.provider),
            ),
          });
          if (requestMediaRevision !== mediaRevision || !subTracks.includes(track)) {
            prepared.cleanup();
            return false;
          }
          track.cleanup?.();
          track.cleanup = prepared.cleanup;
          track.url = prepared.playableUrl;
          track.cues = prepared.cues;
          track.metadata = {
            ...track.metadata,
            format: prepared.format,
            encoding: prepared.encoding,
            rawFilename: prepared.rawFilename,
            archive: prepared.archive,
            prepared: true,
          };
          clearPendingSub(track.originalUrl ?? track.url);
        } else {
          const cues = await fetchAndParse(track.url, { ...track.metadata, lang: track.lang });
          if (requestMediaRevision !== mediaRevision || !subTracks.includes(track)) return false;
          track.cues = cues;
        }
        return track.cues.length > 0;
      } catch (e) {
        console.warn("[tizen-avplay] failed to load subtitle track", e);
        if (
          track.metadata?.refreshable === true &&
          e instanceof SubtitlePreparationError &&
          (e.reason === "invalid-cues" || e.reason === "unsupported-format")
        ) {
          const pendingUrl = track.originalUrl ?? track.url;
          markPendingSub(pendingUrl);
          registerTranslationJob({
            url: pendingUrl,
            lang: track.lang,
            title: track.title,
            metadata: track.metadata,
          });
        }
        if (requestMediaRevision === mediaRevision && subTracks.includes(track)) track.cues = [];
        return false;
      } finally {
        delete track.loadingPromise;
        track.loading = false;
        if (requestMediaRevision === mediaRevision && subTracks.includes(track)) {
          snap.subtitleTracks = [
            ...readCustomSubtitleTracks(),
            ...readNativeTracks(player.getTotalTrackInfo()).subs,
          ];
          tickCues();
          emit();
        }
      }
    })();
    track.loadingPromise = loadingPromise;
    return loadingPromise;
  };

  const updateDisplayGeometry = () => {
    if (!host) return;
    try {
      const rect = host.getBoundingClientRect();
      const w = Math.round(rect.width) || 1920;
      const h = Math.round(rect.height) || 1080;
      const x = Math.round(rect.left) || 0;
      const y = Math.round(rect.top) || 0;
      player.setDisplayRect(x, y, w, h);
    } catch {}
  };

  return {
    attach(target: HTMLElement) {
      host = target;
      // AVPlay renders video to a native hardware plane underneath the webview.
      // Make host transparent so the native video plane is fully visible.
      host.style.backgroundColor = "transparent";
      updateDisplayGeometry();
    },

    detach() {
      host = null;
    },

    async load(src: PlayerSource) {
      mediaRevision += 1;
      mainSubtitleSelection.invalidate();
      secondarySubtitleSelection.invalidate();
      activeTraceId = src.traceId ?? null;
      disposeSubtitleTracks();
      activeSubId = null;
      secondarySubId = null;
      lastCueId = "";
      lastSecondRaw = null;
      lastSecondText = "";
      stopCueTicker();

      snap = {
        ...initialPlayerSnapshot(),
        status: "loading",
        volume: pendingVolume,
      };
      emit();

      const seedTracks: SubTrack[] = (src.subtitles || []).map((s, i) => ({
        id: s.id || `external-${i}`,
        url: s.url,
        lang: s.lang,
        external: true,
        cues: null,
        loading: false,
        metadata: {
          originalUrl: s.url,
          fromTrusted: s.trustedSource === true,
          providerDerived: s.trustedSource !== true,
        },
      }));

      const seedRevision = mediaRevision;
      const seedBatch = new PreparedSubtitleSeedBatch(seedTracks);
      for (const track of seedTracks) {
        subTracks.push(track);
      }

      void Promise.all(
        seedTracks.map(async (track) => {
          if (await ensureLoaded(track)) seedBatch.markReady(track);
        }),
      ).then(() => {
        seedBatch.commit(
          () => seedRevision === mediaRevision,
          (readyTracks) => {
            for (const track of readyTracks) {
              if (!subTracks.includes(track)) continue;
              track.metadata = {
                ...track.metadata,
                prepared: true,
                autoSelectionEligible: true,
              };
            }
            snap.subtitleTracks = [
              ...readCustomSubtitleTracks(),
              ...readNativeTracks(player.getTotalTrackInfo()).subs,
            ];
            emit();
          },
        );
      });

      snap.subtitleTracks = readCustomSubtitleTracks();
      emit();

      updateDisplayGeometry();

      await player.initialize(src.url, {
        startAtMs: src.startAtSec ? Math.round(src.startAtSec * 1000) : undefined,
        displayRect: bridgeOptions?.defaultDisplayRect,
      });
    },

    async play() {
      player.play();
    },

    pause() {
      if (snap.status === "ready") {
        snap.status = "paused";
        emit();
        return;
      }
      player.pause();
    },

    seek(sec: number, _precision?: PlayerSeekPrecision) {
      snap.positionSec = sec;
      player.seek(sec * 1000);
      tickCues();
      emit();
    },

    setVolume(v: number) {
      pendingVolume = Math.min(1, Math.max(0, v));
      snap.volume = pendingVolume;
      emit();
    },

    setMuted(m: boolean) {
      snap.muted = m;
      emit();
    },

    setRate(r: number) {
      player.setPlaybackRate(r);
      snap.rate = r;
      emit();
    },

    setAudioTrack(id: string) {
      if (id.startsWith("tizen-audio-")) {
        const idx = parseInt(id.replace("tizen-audio-", ""), 10);
        if (!isNaN(idx)) {
          player.setSelectTrack("AUDIO", idx);
          snap.audioTracks = snap.audioTracks.map((t) => ({
            ...t,
            selected: t.id === id,
          }));
          emit();
        }
      }
    },

    canAutoSelectSubtitle: () => mainSubtitleSelection.canAutoSelect(mediaRevision),

    setSubtitleTrack(id: string | null, origin: SubtitleSelectionOrigin = "manual") {
      if (!mainSubtitleSelection.claim(mediaRevision, origin)) return;
      if (id == null) {
        mainSubtitleSelection.invalidate();
        activeSubId = null;
        lastCueId = "";
        snap.subText = "";
        snap.subStartSec = 0;
        emit();
        return;
      }
      activeSubId = id;

      if (id.startsWith("tizen-sub-")) {
        const idx = parseInt(id.replace("tizen-sub-", ""), 10);
        if (!isNaN(idx)) {
          player.setSelectTrack("TEXT", idx);
        }
      }

      const track = subTracks.find((s) => s.id === id);
      if (track) {
        const request = mainSubtitleSelection.begin(mediaRevision, id, activeSubId);
        void ensureLoaded(track).then((loaded) => {
          const settlement = mainSubtitleSelection.settle(
            request,
            mediaRevision,
            loaded,
            (candidateId) => subTracks.some((candidate) => candidate.id === candidateId),
          );
          if (settlement.current) {
            activeSubId = settlement.selectedId;
            tickCues();
            emit();
          }
        });
      }

      snap.subtitleTracks = [
        ...readCustomSubtitleTracks(),
        ...readNativeTracks(player.getTotalTrackInfo()).subs,
      ];
      tickCues();
      emit();
    },

    setSecondarySubtitleTrack(id: string | null) {
      if (id == null) {
        secondarySubtitleSelection.invalidate();
        secondarySubId = null;
        lastSecondRaw = null;
        lastSecondText = "";
        snap.secondarySubText = "";
        emit();
        return;
      }
      secondarySubId = id;
      const track = subTracks.find((s) => s.id === id);
      if (track) {
        const request = secondarySubtitleSelection.begin(mediaRevision, id, secondarySubId);
        void ensureLoaded(track).then((loaded) => {
          const settlement = secondarySubtitleSelection.settle(
            request,
            mediaRevision,
            loaded,
            (candidateId) => subTracks.some((candidate) => candidate.id === candidateId),
          );
          if (settlement.current) {
            secondarySubId = settlement.selectedId;
            tickCues();
            emit();
          }
        });
      }
      snap.subtitleTracks = [
        ...readCustomSubtitleTracks(),
        ...readNativeTracks(player.getTotalTrackInfo()).subs,
      ];
      tickCues();
      emit();
    },

    setSubVisible(_on: boolean) {
      // Visibility toggled via activeSubId = null
    },

    setSubHideSdh(on: boolean) {
      hideSdh = on;
      lastCueId = "";
      lastSecondRaw = null;
      tickCues();
    },

    setSubDelay(sec: number) {
      subDelaySec = sec;
      snap.subDelaySec = sec;
      tickCues();
      emit();
    },

    setAudioDelay(sec: number) {
      snap.audioDelaySec = sec;
      emit();
    },

    setPanscan(_value: number) {},
    setVideoZoom(_log2: number) {},
    setAspectOverride(_ratio: string) {},
    setStretch(_on: boolean) {},
    setVideoEq(_name: string, _value: number) {},
    setAnime4kShaders(_shaders: string[]) {},

    async addSubtitle(
      url: string,
      lang?: string,
      title?: string,
      select?: boolean,
      metadata?: SubtitleLoadMetadata,
      origin: SubtitleSelectionOrigin = "manual",
    ): Promise<boolean> {
      const providerDerived = metadata?.providerDerived ?? Boolean(metadata?.provider);
      if (providerDerived && !isSafeProviderSubtitleUrl(url)) return false;
      if (metadata?.originalUrl) {
        noteSubtitleOrigin(url, metadata.originalUrl);
      }

      const id = metadata?.subId || `user-sub-${subTracks.length}`;
      const existing = subTracks.find((s) => s.id === id || s.url === url);
      if (existing) {
        if (select && mainSubtitleSelection.claim(mediaRevision, origin)) {
          activeSubId = existing.id;
        }
        await ensureLoaded(existing);
        return true;
      }

      const selectionRequest =
        select === true && mainSubtitleSelection.claim(mediaRevision, origin)
          ? mainSubtitleSelection.begin(mediaRevision, id, activeSubId)
          : null;

      const track: SubTrack = {
        id,
        url,
        originalUrl: metadata?.originalUrl ?? url,
        lang,
        title,
        external: true,
        cues: null,
        loading: false,
        metadata: {
          ...metadata,
          fromTrusted: metadata?.fromTrusted ?? false,
          providerDerived,
        },
      };

      subTracks.push(track);
      if (selectionRequest) {
        activeSubId = track.id;
      }

      snap.subtitleTracks = [
        ...readCustomSubtitleTracks(),
        ...readNativeTracks(player.getTotalTrackInfo()).subs,
      ];
      emit();

      const loaded = await ensureLoaded(track);
      if (selectionRequest) {
        const settlement = mainSubtitleSelection.settle(
          selectionRequest,
          mediaRevision,
          loaded,
          (candidateId) => subTracks.some((candidate) => candidate.id === candidateId),
        );
        if (settlement.current) {
          activeSubId = settlement.selectedId;
          tickCues();
          emit();
        }
      }
      return loaded;
    },

    getSelectedTrackCues(): SubCue[] | null {
      const track = subTracks.find((s) => s.id === activeSubId);
      return track?.cues ?? null;
    },

    getSelectedTrackUrl(): string | null {
      const track = subTracks.find((s) => s.id === activeSubId);
      return track ? (track.originalUrl ?? track.url) : null;
    },

    setAudioNormalize(on: boolean) {
      snap.audioNormalize = on;
      emit();
    },

    async screenshot(_path: string) {
      return { ok: false, error: "Screenshots unsupported on Tizen AVPlay" };
    },

    setAbLoop(_a: number | null, _b: number | null) {},

    async requestPiP() {},
    async exitPiP() {},

    async requestFullscreen() {
      try {
        if (typeof document !== "undefined" && document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
        }
      } catch {}
    },

    async exitFullscreen() {
      try {
        if (typeof document !== "undefined" && document.exitFullscreen) {
          await document.exitFullscreen();
        }
      } catch {}
    },

    capabilities(): PlayerCapabilities {
      return {
        engine: "avplay",
        pictureInPicture: false,
        airplay: false,
        chromecast: false,
        hdrPassthrough: true,
        hardwareDecode: true,
      };
    },

    subscribe(listener: (s: PlayerSnapshot) => void) {
      listeners.add(listener);
      listener({ ...snap });
      return () => {
        listeners.delete(listener);
      };
    },

    destroy() {
      mediaRevision += 1;
      mainSubtitleSelection.invalidate();
      secondarySubtitleSelection.invalidate();
      stopCueTicker();
      disposeSubtitleTracks();
      listeners.clear();
      player.destroy();
    },
  };
}
