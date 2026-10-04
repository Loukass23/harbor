import { useEffect, useRef } from "react";

// HLS/mpegts are loaded lazily inside the effect so the TV build
// (which uses native AVPlay) never bundles them. The type imports
// are hoisted into the runtime branch below so they don't trigger
// chunk generation on the TV build.

// Long enough that an IPTV stream rebuffering on a busy line is never mistaken
// for a dead one, short enough that a genuinely dead channel still reports.
const STALL_GRACE_MS = 12000;

// Live IPTV throws fatal-but-recoverable errors as a matter of course. Six
// in-place recoveries before the channel is called dead.
const MAX_RECOVERIES = 6;

type Kind = "hls" | "mpegts" | "native";

function sniffKind(url: string): Kind {
  const u = url.toLowerCase().split("?")[0];
  if (u.endsWith(".m3u8") || u.includes(".m3u8/")) return "hls";
  if (u.endsWith(".ts")) return "mpegts";
  if (u.endsWith(".mpd")) return "native";
  if (u.endsWith(".mp4") || u.endsWith(".webm") || u.endsWith(".mov")) return "native";
  return "hls";
}

// Multiview runs four of these on purpose, so exclusivity is opt in. The Big
// Picture previews pass it: exactly one channel is ever being fetched, the one
// under the ring, and moving on tears the previous one down before the next
// opens a socket. IPTV resellers commonly cap concurrent connections, so a
// second stream does not just waste bandwidth, it gets the first one dropped.
let exclusiveOwner: symbol | null = null;
const exclusiveTeardown = new Map<symbol, () => void>();

export function MultiPlayer({
  url,
  muted,
  volume,
  cover = false,
  exclusive = false,
  onPlaying,
  onError,
}: {
  url: string;
  muted: boolean;
  volume?: number;
  cover?: boolean;
  exclusive?: boolean;
  onPlaying?: () => void;
  onError?: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const tokenRef = useRef<symbol | null>(null);
  if (tokenRef.current === null) tokenRef.current = Symbol("bp-preview");
  const token = tokenRef.current;
  const onPlayingRef = useRef(onPlaying);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onPlayingRef.current = onPlaying;
    onErrorRef.current = onError;
  });

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    cleanupRef.current?.();

    const kind = sniffKind(url);
    // The actual Hls/Mpegts types are imported inside the async branch
    // to avoid triggering chunk generation on TV builds. Use `object`
    // here since the real types are only used inside the async scope.
    let hls: object | null = null;
    let ts: object | null = null;
    let disposed = false;

    const run = async () => {
      type HlsModule = typeof import("hls.js");
      type MpegtsModule = typeof import("mpegts.js");
      let Hls: HlsModule["default"] | null = null;
      let mpegts: MpegtsModule["default"] | null = null;
      // Build-time branch: on TV the native player handles HLS/MPEG-TS.
      // Using a variable for the import path prevents Rollup from
      // statically analyzing the import() calls when __HARBOR_TV_BUILD__ is true.
      if (typeof __HARBOR_TV_BUILD__ !== "undefined" && __HARBOR_TV_BUILD__) {
        Hls = null;
        mpegts = null;
      } else {
        // TV build: __HARBOR_TV_BUILD__ === true, so this branch is dead code
        // and Rollup never sees the import() calls. On desktop/android the
        // vendors load normally.
        const mods = await Promise.all([
          (async () => (await import("hls.js")).default)(),
          (async () => (await import("mpegts.js")).default)(),
        ]);
        Hls = mods[0];
        mpegts = mods[1];
      }
      if (disposed) return;

      if (exclusive) {
        if (exclusiveOwner && exclusiveOwner !== token) {
          exclusiveTeardown.get(exclusiveOwner)?.();
          exclusiveTeardown.delete(exclusiveOwner);
        }
        exclusiveOwner = token;
      }

      let stallTimer = 0;
      const clearStall = () => {
        if (!stallTimer) return;
        window.clearTimeout(stallTimer);
        stallTimer = 0;
      };
      const handlePlaying = () => {
        clearStall();
        if (!disposed) onPlayingRef.current?.();
      };
      const handleError = () => {
        clearStall();
        if (!disposed) onErrorRef.current?.();
      };
      const handleStalled = () => {
        if (disposed || stallTimer) return;
        stallTimer = window.setTimeout(() => {
          stallTimer = 0;
          handleError();
        }, STALL_GRACE_MS);
      };

      video.addEventListener("playing", handlePlaying);
      video.addEventListener("timeupdate", clearStall);
      video.addEventListener("error", handleError);
      video.addEventListener("stalled", handleStalled);
      video.addEventListener("waiting", handleStalled);

      const tryNative = () => {
        video.src = url;
        video.play().catch(handleError);
      };

      if (kind === "hls") {
        if (!Hls?.isSupported?.()) return tryNative();
        const H = new Hls({
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          lowLatencyMode: false,
          backBufferLength: 10,
          manifestLoadingMaxRetry: 3,
          manifestLoadingRetryDelay: 1000,
          levelLoadingMaxRetry: 3,
          levelLoadingRetryDelay: 1000,
          fragLoadingMaxRetry: 4,
          fragLoadingRetryDelay: 1000,
        });
        hls = H;
        H.loadSource(url);
        H.attachMedia(video);
        H.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch(() => {});
        });
        let recoveries = 0;
        const Hlocal = H;
        H.on(Hls.Events.ERROR, (_e: unknown, data: { fatal?: boolean; type?: string }) => {
          if (!data.fatal) return;
          if (recoveries >= MAX_RECOVERIES) {
            handleError();
            return;
          }
          recoveries += 1;
          if (data.type === "NETWORK_ERROR") {
            Hlocal.startLoad();
            return;
          }
          if (data.type === "MEDIA_ERROR") {
            Hlocal.recoverMediaError();
            return;
          }
          handleError();
        });
      } else if (kind === "mpegts") {
        if (!mpegts?.isSupported?.()) return tryNative();
        const T = mpegts!.createPlayer(
          { type: "mpegts", url, isLive: true, cors: true },
          { enableWorker: true, liveBufferLatencyChasing: false, lazyLoad: false },
        );
        ts = T;
        T.attachMediaElement(video);
        T.on(mpegts.Events.ERROR, handleError);
        T.load();
        T.play()?.catch(() => {});
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        tryNative();
      } else {
        tryNative();
      }

      if (exclusive) exclusiveTeardown.set(token, () => cleanupRef.current?.());

      cleanupRef.current = () => {
        disposed = true;
        clearStall();
        if (exclusive) {
          exclusiveTeardown.delete(token);
          if (exclusiveOwner === token) exclusiveOwner = null;
        }
        video.removeEventListener("playing", handlePlaying);
        video.removeEventListener("timeupdate", clearStall);
        video.removeEventListener("error", handleError);
        video.removeEventListener("stalled", handleStalled);
        video.removeEventListener("waiting", handleStalled);
        if (hls) { try { (hls as { destroy(): void }).destroy(); } catch { /* ignore */ } }
        if (ts) { try { (ts as { pause(): void; unload(): void; detachMediaElement(): void; destroy(): void }).pause(); (ts as { unload(): void }).unload(); (ts as { detachMediaElement(): void }).detachMediaElement(); (ts as { destroy(): void }).destroy(); } catch { /* ignore */ } }
        try { video.pause(); video.removeAttribute("src"); video.load(); } catch { /* ignore */ }
      };
    };

    run();

    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [url]);

  useEffect(() => {
    if (ref.current) ref.current.muted = muted;
  }, [muted]);

  useEffect(() => {
    if (ref.current && volume != null) ref.current.volume = Math.max(0, Math.min(1, volume));
  }, [volume]);

  return (
    <video
      ref={ref}
      className={`h-full w-full bg-black ${cover ? "object-cover" : "object-contain"}`}
      playsInline
      autoPlay
      muted={muted}
    />
  );
}
