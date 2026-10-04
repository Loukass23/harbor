/**
 * Phase 2 — off-thread stream selection pipeline (WebWorker).
 *
 * The main thread on Tizen 9.0 must stay free for 60fps D-pad navigation.
 * Manifest fetching/parsing, rendition ranking, and buffer-ahead tracking run
 * here. Only small debounced snapshots cross back to the UI thread.
 */

export type TvStreamCandidate = {
  url: string;
  codec?: string;
  container?: string;
  width?: number;
  height?: number;
  bitrate?: number;
  fps?: number;
  audioCodec?: string;
  audioChannels?: number;
  isHevc?: boolean;
  score?: number;
};

export type TvStreamSelectRequest =
  | { type: "rank"; candidates: TvStreamCandidate[]; maxResolution: number }
  | { type: "buffer"; bufferedSec: number; durationSec: number; positionSec: number };

export type TvStreamSelectResponse =
  | { type: "ranked"; best: TvStreamCandidate | null; ordered: TvStreamCandidate[] }
  | { type: "buffer-state"; aheadSec: number; starving: boolean };

function scoreCandidate(c: TvStreamCandidate, maxResolution: number): number {
  let score = 0;
  const h = c.height ?? 0;
  // Prefer the highest rendition at or under the panel cap.
  if (h > 0 && h <= maxResolution) score += 1000 + h;
  else if (h > maxResolution) score += 500 - (h - maxResolution);
  // Hardware path first: HEVC main-profile decodes on the Tizen VPU with
  // negligible CPU; AV1/SW fallbacks stall the WebView.
  if (
    c.isHevc ||
    c.codec?.toLowerCase().includes("hevc") ||
    c.codec?.toLowerCase().includes("h265")
  ) {
    score += 300;
  } else if (c.codec?.toLowerCase().includes("h264") || c.codec?.toLowerCase().includes("avc")) {
    score += 200;
  }
  if (c.audioCodec?.toLowerCase().includes("aac")) score += 50;
  if ((c.bitrate ?? 0) > 0) score += Math.min(100, (c.bitrate ?? 0) / 100_000);
  return score;
}

self.onmessage = (e: MessageEvent<TvStreamSelectRequest>) => {
  const msg = e.data;
  if (msg.type === "rank") {
    const ordered = msg.candidates
      .map((c) => ({ ...c, score: scoreCandidate(c, msg.maxResolution) }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const best = ordered[0] ?? null;
    (self as unknown as { postMessage: (m: TvStreamSelectResponse) => void }).postMessage({
      type: "ranked",
      best,
      ordered,
    });
    return;
  }
  if (msg.type === "buffer") {
    const aheadSec = Math.max(0, msg.bufferedSec - msg.positionSec);
    const starving = msg.durationSec > 0 && aheadSec < 4;
    (self as unknown as { postMessage: (m: TvStreamSelectResponse) => void }).postMessage({
      type: "buffer-state",
      aheadSec,
      starving,
    });
  }
};
