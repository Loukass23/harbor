import {
  emptySnapshot,
  type PlayerBridge,
  type PlayerCapabilities,
  type PlayerSnapshot,
  type PlayerSource,
  type TrackInfo,
} from "@/lib/player/bridge";
import { fetchAndParse, findActiveCue, type SubCue } from "@/lib/subtitles/parser";
import type { SubtitleLoadMetadata } from "@/lib/player/subtitle-load";

// Declare ambient Tizen WebAPIs
declare const webapis: any;

export interface TizenStreamInfo {
  type: string;
  extra_info?: string | Record<string, unknown>;
  [key: string]: unknown;
}

export function isTizenAvplayAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { webapis?: { avplay?: unknown } }).webapis?.avplay !== "undefined"
  );
}

export interface CustomSubTrack {
  id: string;
  label: string;
  lang?: string;
  url: string;
  cues: SubCue[];
  selected: boolean;
  metadata?: SubtitleLoadMetadata;
}

export interface TizenAVPlayStats {
  videoBitrate: number | null;
  audioBitrate: number | null;
  videoWidth: number;
  videoHeight: number;
  videoCodec: string | null;
  audioCodec: string | null;
  state: string;
}

export class TizenAVPlayEngine implements PlayerBridge {
  private host: HTMLElement | null = null;
  private snap: PlayerSnapshot = { ...emptySnapshot };
  private listeners = new Set<(s: PlayerSnapshot) => void>();
  private prevBodyBg: string | null = null;
  private prevDocBg: string | null = null;
  private prevRootBg: string | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private onWindowResize: (() => void) | null = null;
  private subTicker: number | null = null;
  private statsTicker: number | null = null;
  private externalSubTracks: CustomSubTrack[] = [];
  private activeExternalSubId: string | null = null;
  private selectedAudioTrackIndex: number | null = null;
  private selectedNativeSubtitleIndex: number | null = null;
  private subDelaySec = 0;
  private subVisible = true;
  private pendingSeekSec: number | null = null;
  private pendingVolume = 1;
  private isMuted = false;
  private currentStats: TizenAVPlayStats = {
    videoBitrate: null,
    audioBitrate: null,
    videoWidth: 0,
    videoHeight: 0,
    videoCodec: null,
    audioCodec: null,
    state: "NONE",
  };

  constructor() {
    this.snap = {
      ...emptySnapshot,
      volume: 1,
      muted: false,
    };
  }

  // --- Environment Guarding ---

  public isAvailable(): boolean {
    return isTizenAvplayAvailable();
  }

  public getState(): string {
    if (!this.isAvailable()) return "NONE";
    try {
      return webapis!.avplay!.getState();
    } catch {
      return "NONE";
    }
  }

  // --- Display Rect & Hardware Hole-Punching ---

  public attach(host: HTMLElement): void {
    this.host = host;

    // Apply transparent background to allow hardware video plane through
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-avplay-active", "true");
      document.body.setAttribute("data-avplay-active", "true");
      this.prevDocBg = document.documentElement.style.backgroundColor;
      this.prevBodyBg = document.body.style.backgroundColor;
      document.documentElement.style.backgroundColor = "transparent";
      document.body.style.backgroundColor = "transparent";

      const rootEl = document.getElementById("root");
      if (rootEl) {
        this.prevRootBg = rootEl.style.backgroundColor;
        rootEl.style.backgroundColor = "transparent";
      }

      const bpRoots = document.querySelectorAll<HTMLElement>(
        "[data-bp-root], [data-bp-tv], [data-bp-shell]",
      );
      bpRoots.forEach((el) => {
        el.style.backgroundColor = "transparent";
      });
    }

    host.style.backgroundColor = "transparent";

    // Setup viewport synchronization
    this.syncDisplayRect();

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        this.syncDisplayRect();
      });
      this.resizeObserver.observe(host);
    }

    this.onWindowResize = () => {
      this.syncDisplayRect();
    };
    window.addEventListener("resize", this.onWindowResize);
    window.addEventListener("orientationchange", this.onWindowResize);

    this.startTickers();
  }

  public detach(): void {
    this.stopTickers();

    if (typeof document !== "undefined") {
      document.documentElement.removeAttribute("data-avplay-active");
      document.body.removeAttribute("data-avplay-active");
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    if (this.onWindowResize) {
      window.removeEventListener("resize", this.onWindowResize);
      window.removeEventListener("orientationchange", this.onWindowResize);
      this.onWindowResize = null;
    }

    // Restore original background colors
    if (typeof document !== "undefined") {
      if (this.prevDocBg !== null) document.documentElement.style.backgroundColor = this.prevDocBg;
      if (this.prevBodyBg !== null) document.body.style.backgroundColor = this.prevBodyBg;
      const rootEl = document.getElementById("root");
      if (rootEl && this.prevRootBg !== null) {
        rootEl.style.backgroundColor = this.prevRootBg;
      }
      const bpRoots = document.querySelectorAll<HTMLElement>(
        "[data-bp-root], [data-bp-tv], [data-bp-shell]",
      );
      bpRoots.forEach((el) => {
        el.style.backgroundColor = "";
      });
    }

    this.host = null;
  }

  public syncDisplayRect(): void {
    if (!this.isAvailable()) return;

    const doc = typeof document !== "undefined" ? document.documentElement : null;
    const clientW = doc?.clientWidth || window.innerWidth || 1920;
    const clientH = doc?.clientHeight || window.innerHeight || 1080;

    if (!this.host) {
      this.setDisplayRect(0, 0, 1920, 1080);
      return;
    }

    const rect = this.host.getBoundingClientRect();

    // Check if host covers the full viewport (full-screen stage)
    const isFullscreen =
      rect.left <= 2 && rect.top <= 2 && rect.width >= clientW - 4 && rect.height >= clientH - 4;

    if (isFullscreen) {
      this.setDisplayRect(0, 0, 1920, 1080);
      return;
    }

    // Proportional mapping from CSS pixels to Samsung's 1920x1080 coordinate space
    const scaleX = 1920 / clientW;
    const scaleY = 1080 / clientH;

    const x = Math.round(rect.left * scaleX);
    const y = Math.round(rect.top * scaleY);
    const width = Math.max(1, Math.round(rect.width * scaleX));
    const height = Math.max(1, Math.round(rect.height * scaleY));

    this.setDisplayRect(x, y, width, height);
  }

  public setDisplayRect(left: number, top: number, width: number, height: number): void {
    if (!this.isAvailable()) return;
    try {
      webapis!.avplay!.setDisplayRect(left, top, width, height);
      try {
        webapis!.avplay!.setDisplayMethod("PLAYER_DISPLAY_MODE_LETTER_BOX");
      } catch {
        // Some states or devices might reject setDisplayMethod before prepare
      }
    } catch (err) {
      console.warn("[tizen-avplay] setDisplayRect failed", err);
    }
  }

  // --- Playback Lifecycle ---

  public async load(src: PlayerSource): Promise<void> {
    this.pendingSeekSec = src.startAtSec ?? null;
    this.snap = {
      ...emptySnapshot,
      status: "loading",
      volume: this.pendingVolume,
      muted: this.isMuted,
    };
    this.emit();

    if (!this.isAvailable()) {
      console.warn("[tizen-avplay] webapis.avplay is not available in this environment");
      this.snap.status = "error";
      this.snap.errorCode = "source";
      this.snap.errorMessage = "Tizen AVPlay is not supported on this platform";
      this.emit();
      return;
    }

    try {
      this.open(src.url);

      // Phase 2 DirectPlay: hint the hardware pipeline before prepare().
      // HEVC/AAC decode on the Tizen VPU; a generous buffer avoids rebuffer
      // stalls on high-bitrate 4K without touching the WebView heap.
      try {
        webapis!.avplay!.setStreamingProperty("BUFFER_SIZE", "16");
        webapis!.avplay!.setStreamingProperty("BUFFERING_TIMEOUT", "20");
      } catch {
        // Some firmware builds ignore custom streaming properties
      }

      // Pass custom streaming headers if available
      if (src.headers) {
        try {
          const headerEntries = Object.entries(src.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n");
          if (headerEntries) {
            webapis!.avplay!.setStreamingProperty("CUSTOM_MESSAGE", headerEntries);
          }
        } catch {
          // Some firmware builds ignore custom streaming properties
        }
      }

      this.setupListeners();
      await this.prepareAsync();

      if (this.pendingSeekSec != null && this.pendingSeekSec > 0) {
        await this.seekTo(Math.round(this.pendingSeekSec * 1000));
        this.pendingSeekSec = null;
      }

      // Autoload subtitles if provided in PlayerSource
      if (src.subtitles && src.subtitles.length > 0) {
        for (const s of src.subtitles) {
          void this.addSubtitle(s.url, s.lang, undefined, false);
        }
      }

      await this.play();
    } catch (err: unknown) {
      console.error("[tizen-avplay] load failed", err);
      this.snap.status = "error";
      this.snap.errorCode = "decode";
      this.snap.errorMessage = err instanceof Error ? err.message : String(err);
      this.emit();
    }
  }

  public open(url: string): void {
    if (!this.isAvailable()) return;
    try {
      const state = this.getState();
      if (state !== "NONE" && state !== "IDLE") {
        this.stop();
        this.close();
      }
      webapis!.avplay!.open(url);
      this.syncDisplayRect();
    } catch (err) {
      console.warn("[tizen-avplay] open failed", err);
      throw err;
    }
  }

  public prepareAsync(): Promise<void> {
    if (!this.isAvailable()) {
      return Promise.reject(new Error("webapis.avplay unavailable"));
    }

    return new Promise((resolve, reject) => {
      try {
        webapis!.avplay!.prepareAsync(
          () => {
            this.handlePrepared();
            resolve();
          },
          (err: any) => {
            console.error("[tizen-avplay] prepareAsync error", err);
            reject(err);
          },
        );
      } catch (err) {
        reject(err);
      }
    });
  }

  private handlePrepared(): void {
    if (!this.isAvailable()) return;
    try {
      this.syncDisplayRect();

      const durMs = webapis!.avplay!.getDuration();
      if (typeof durMs === "number" && durMs > 0) {
        this.snap.durationSec = durMs / 1000;
      }

      const streamInfo = webapis!.avplay!.getCurrentStreamInfo();
      this.parseStreamInfo(streamInfo);
      this.refreshTracks();

      this.snap.status = "ready";
      this.emit();
    } catch (err) {
      console.warn("[tizen-avplay] handlePrepared reading stream info failed", err);
    }
  }

  public async play(): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      const state = this.getState();
      if (state === "PAUSED" || state === "READY") {
        this.syncDisplayRect();
        webapis!.avplay!.play();
        this.snap.status = "playing";
        this.emit();
      }
    } catch (err) {
      console.warn("[tizen-avplay] play failed", err);
    }
  }

  public pause(): void {
    if (!this.isAvailable()) return;
    try {
      const state = this.getState();
      if (state === "PLAYING") {
        webapis!.avplay!.pause();
        this.snap.status = "paused";
        this.emit();
      }
    } catch (err) {
      console.warn("[tizen-avplay] pause failed", err);
    }
  }

  public seek(sec: number): void {
    void this.seekTo(Math.round(sec * 1000));
  }

  public seekTo(ms: number): Promise<void> {
    if (!this.isAvailable()) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        const state = this.getState();
        if (state === "PLAYING" || state === "PAUSED" || state === "READY") {
          webapis!.avplay!.seekTo(
            ms,
            () => {
              this.snap.positionSec = ms / 1000;
              this.emit();
              resolve();
            },
            (err: any) => {
              console.warn("[tizen-avplay] seekTo callback failed", err);
              resolve();
            },
          );
        } else {
          this.pendingSeekSec = ms / 1000;
          resolve();
        }
      } catch (err) {
        console.warn("[tizen-avplay] seekTo call failed", err);
        resolve();
      }
    });
  }

  public stop(): void {
    if (!this.isAvailable()) return;
    try {
      const state = this.getState();
      if (state === "PLAYING" || state === "PAUSED" || state === "READY") {
        webapis!.avplay!.stop();
      }
    } catch (err) {
      console.warn("[tizen-avplay] stop failed", err);
    }
  }

  public close(): void {
    if (!this.isAvailable()) return;
    try {
      const state = this.getState();
      if (state !== "NONE") {
        webapis!.avplay!.close();
      }
    } catch (err) {
      console.warn("[tizen-avplay] close failed", err);
    }
  }

  public destroy(): void {
    this.detach();
    this.stop();
    this.close();
    this.listeners.clear();
  }

  // --- Listeners & Stream Metadata ---

  private setupListeners(): void {
    if (!this.isAvailable()) return;
    try {
      webapis!.avplay!.setListener({
        onbufferingstart: () => {
          this.snap.buffering = true;
          this.emit();
        },
        onbufferingprogress: (percent: number) => {
          this.snap.buffering = true;
          if (this.snap.durationSec > 0) {
            this.snap.bufferedSec = (this.snap.durationSec * percent) / 100;
          }
          this.emit();
        },
        onbufferingcomplete: () => {
          this.snap.buffering = false;
          this.emit();
        },
        oncurrentplaytime: (timeMs: number) => {
          this.snap.positionSec = timeMs / 1000;
          this.updateExternalSubtitleCue(this.snap.positionSec);
          this.emit();
        },
        onstreamcompleted: () => {
          this.snap.status = "ended";
          this.emit();
        },
        onerror: (errorType: string) => {
          console.error("[tizen-avplay] onerror received:", errorType);
          this.snap.status = "error";
          this.snap.errorCode = "decode";
          this.snap.errorMessage = `AVPlay Error: ${errorType}`;
          this.emit();
        },
        onsubtitlechange: (_duration: number, text: string) => {
          if (!this.activeExternalSubId && this.subVisible) {
            this.snap.subText = text || "";
            this.snap.subStartSec = this.snap.positionSec;
            this.emit();
          }
        },
      });
    } catch (err) {
      console.warn("[tizen-avplay] setListener failed", err);
    }
  }

  private parseStreamInfo(infoList: TizenStreamInfo[]): void {
    if (!Array.isArray(infoList)) return;
    for (const info of infoList) {
      let extra: Record<string, unknown> = {};
      if (typeof info.extra_info === "string") {
        try {
          extra = JSON.parse(info.extra_info);
        } catch {
          extra = {};
        }
      } else if (typeof info.extra_info === "object" && info.extra_info !== null) {
        extra = info.extra_info as Record<string, unknown>;
      }

      if (info.type === "VIDEO" || String(info.type).toLowerCase() === "video") {
        const w = Number(extra.Width || extra.width);
        const h = Number(extra.Height || extra.height);
        if (Number.isFinite(w) && w > 0) {
          this.snap.videoWidth = w;
          this.currentStats.videoWidth = w;
        }
        if (Number.isFinite(h) && h > 0) {
          this.snap.videoHeight = h;
          this.currentStats.videoHeight = h;
        }
        if (extra.fourCC || extra.codec) {
          this.currentStats.videoCodec = String(extra.fourCC || extra.codec);
        }
      } else if (info.type === "AUDIO" || String(info.type).toLowerCase() === "audio") {
        if (extra.fourCC || extra.codec) {
          this.currentStats.audioCodec = String(extra.fourCC || extra.codec);
        }
      }
    }
  }

  // --- Track Selection (Audio & Subtitles) ---

  public refreshTracks(): void {
    if (!this.isAvailable()) return;

    try {
      const rawTracks = webapis!.avplay!.getTotalTrackInfo() || [];
      const audioTracks: TrackInfo[] = [];
      const nativeSubTracks: TrackInfo[] = [];

      for (const t of rawTracks) {
        let extra: Record<string, unknown> = {};
        if (typeof t.extra_info === "string") {
          try {
            extra = JSON.parse(t.extra_info);
          } catch {
            extra = {};
          }
        } else if (typeof t.extra_info === "object" && t.extra_info !== null) {
          extra = t.extra_info as Record<string, unknown>;
        }

        if (t.type === "AUDIO") {
          const isSelected =
            this.selectedAudioTrackIndex === t.index ||
            (this.selectedAudioTrackIndex === null && audioTracks.length === 0);
          const lang = String(extra.language || extra.track_lang || "und");
          const label = String(
            extra.title || extra.language || extra.track_lang || `Audio ${t.index + 1}`,
          );
          const channels = extra.channels ? `${extra.channels} ch` : undefined;
          const channelCount = typeof extra.channels === "number" ? extra.channels : undefined;

          audioTracks.push({
            id: String(t.index),
            label,
            lang,
            kind: "audio",
            selected: isSelected,
            channels,
            channelCount,
            codec: extra.fourCC ? String(extra.fourCC) : undefined,
          });
        } else if (t.type === "TEXT") {
          const isSelected = this.selectedNativeSubtitleIndex === t.index;
          const lang = String(extra.track_lang || extra.language || "und");
          const label = String(
            extra.title || extra.track_lang || extra.language || `Subtitle ${t.index + 1}`,
          );

          nativeSubTracks.push({
            id: `native-${t.index}`,
            label,
            lang,
            kind: "subtitle",
            selected: isSelected && !this.activeExternalSubId,
          });
        }
      }

      // Merge with custom external subtitles
      const customSubs: TrackInfo[] = this.externalSubTracks.map((sub) => ({
        id: sub.id,
        label: sub.label,
        lang: sub.lang,
        kind: "subtitle" as const,
        selected: this.activeExternalSubId === sub.id,
        external: true,
        url: sub.url,
      }));

      this.snap.audioTracks = audioTracks;
      this.snap.subtitleTracks = [...nativeSubTracks, ...customSubs];
      this.emit();
    } catch (err) {
      console.warn("[tizen-avplay] refreshTracks failed", err);
    }
  }

  public setAudioTrack(id: string): void {
    const trackIndex = parseInt(id, 10);
    if (!isNaN(trackIndex) && this.isAvailable()) {
      try {
        webapis!.avplay!.setSelectTrack("AUDIO", trackIndex);
        this.selectedAudioTrackIndex = trackIndex;
        this.refreshTracks();
      } catch (err) {
        console.warn("[tizen-avplay] setAudioTrack failed", err);
      }
    }
  }

  public setSubtitleTrack(id: string | null): void {
    if (!id) {
      this.activeExternalSubId = null;
      this.selectedNativeSubtitleIndex = null;
      this.snap.subText = "";
      this.refreshTracks();
      return;
    }

    if (id.startsWith("native-")) {
      const idx = parseInt(id.replace("native-", ""), 10);
      if (!isNaN(idx) && this.isAvailable()) {
        try {
          webapis!.avplay!.setSelectTrack("TEXT", idx);
          this.selectedNativeSubtitleIndex = idx;
          this.activeExternalSubId = null;
          this.refreshTracks();
        } catch (err) {
          console.warn("[tizen-avplay] setSelectTrack TEXT failed", err);
        }
      }
      return;
    }

    // External track
    const found = this.externalSubTracks.find((s) => s.id === id);
    if (found) {
      this.activeExternalSubId = id;
      this.selectedNativeSubtitleIndex = null;
      this.refreshTracks();
    }
  }

  public setSecondarySubtitleTrack(_id: string | null): void {
    // Secondary subtitle track is not natively supported by hardware plane
  }

  public setSubVisible(on: boolean): void {
    this.subVisible = on;
    if (!on) {
      this.snap.subText = "";
      this.emit();
    }
  }

  public setSubDelay(sec: number): void {
    this.subDelaySec = sec;
    this.snap.subDelaySec = sec;
    this.emit();
  }

  public setAudioDelay(sec: number): void {
    this.snap.audioDelaySec = sec;
    this.emit();
  }

  public async addSubtitle(
    url: string,
    lang?: string,
    title?: string,
    select?: boolean,
    metadata?: SubtitleLoadMetadata,
  ): Promise<boolean> {
    try {
      const cues = await fetchAndParse(url);
      if (!cues || cues.length === 0) return false;

      const id = `ext-sub-${this.externalSubTracks.length + 1}-${Date.now()}`;
      const newTrack: CustomSubTrack = {
        id,
        label: title || lang || `External Subtitle ${this.externalSubTracks.length + 1}`,
        lang,
        url,
        cues,
        selected: !!select,
        metadata,
      };

      this.externalSubTracks.push(newTrack);

      if (select) {
        this.activeExternalSubId = id;
        this.selectedNativeSubtitleIndex = null;
      }

      this.refreshTracks();
      return true;
    } catch (err) {
      console.warn("[tizen-avplay] addSubtitle failed to load", url, err);
      return false;
    }
  }

  public getSelectedTrackCues(): SubCue[] | null {
    if (!this.activeExternalSubId) return null;
    const found = this.externalSubTracks.find((s) => s.id === this.activeExternalSubId);
    return found ? found.cues : null;
  }

  public getSelectedTrackUrl(): string | null {
    if (!this.activeExternalSubId) return null;
    const found = this.externalSubTracks.find((s) => s.id === this.activeExternalSubId);
    return found ? found.url : null;
  }

  private updateExternalSubtitleCue(positionSec: number): void {
    if (!this.activeExternalSubId || !this.subVisible) return;
    const track = this.externalSubTracks.find((s) => s.id === this.activeExternalSubId);
    if (!track) return;

    const cue = findActiveCue(track.cues, positionSec + this.subDelaySec);
    const newText = cue ? cue.text : "";
    if (newText !== this.snap.subText) {
      this.snap.subText = newText;
      this.snap.subStartSec = cue ? cue.start : 0;
    }
  }

  // --- Volume, Speed & General Controls ---

  public setVolume(v: number): void {
    this.pendingVolume = Math.max(0, Math.min(1, v));
    this.snap.volume = this.pendingVolume;
    this.emit();
  }

  public setMuted(m: boolean): void {
    this.isMuted = m;
    this.snap.muted = m;
    this.emit();
  }

  public setRate(r: number): void {
    if (!this.isAvailable()) return;
    try {
      webapis!.avplay!.setSpeed(r);
      this.snap.rate = r;
      this.emit();
    } catch {
      // Speed adjustments can be limited by stream format on Tizen
    }
  }

  public setPanscan(_value: number): void {}
  public setVideoZoom(_log2: number): void {}
  public setAspectOverride(_ratio: string): void {}
  public setStretch(_on: boolean): void {}
  public setVideoEq(_name: string, _value: number): void {}
  public setAnime4kShaders(_shaders: string[]): void {}
  public setAudioNormalize(_on: boolean): void {}
  public setAbLoop(_a: number | null, _b: number | null): void {}
  public async requestPiP(): Promise<void> {}
  public async exitPiP(): Promise<void> {}
  public async requestFullscreen(): Promise<void> {}
  public async exitFullscreen(): Promise<void> {}

  public async screenshot(_path: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    return { ok: false, error: "Screenshot is unsupported on Tizen AVPlay hardware decoder plane" };
  }

  // --- Stats & OSD Support ---

  public getStats(): TizenAVPlayStats {
    if (this.isAvailable()) {
      try {
        const bitrates = webapis!.avplay!.getCurrentBitrates();
        if (typeof bitrates === "number" && bitrates > 0) {
          this.currentStats.videoBitrate = bitrates;
        }
        this.currentStats.state = this.getState();
      } catch {}
    }
    return this.currentStats;
  }

  private startTickers(): void {
    this.statsTicker = window.setInterval(() => {
      this.getStats();
    }, 1000);
  }

  private stopTickers(): void {
    if (this.subTicker != null) {
      window.clearInterval(this.subTicker);
      this.subTicker = null;
    }
    if (this.statsTicker != null) {
      window.clearInterval(this.statsTicker);
      this.statsTicker = null;
    }
  }

  // --- Capabilities & Subscriptions ---

  public capabilities(): PlayerCapabilities {
    return {
      engine: "html5",
      pictureInPicture: false,
      airplay: false,
      chromecast: false,
      hdrPassthrough: true,
      hardwareDecode: true,
    };
  }

  public subscribe(listener: (snap: PlayerSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener({ ...this.snap });
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const copy = { ...this.snap };
    for (const listener of this.listeners) {
      listener(copy);
    }
  }
}

export function createTizenAvplayBridge(): PlayerBridge {
  return new TizenAVPlayEngine();
}
