import type { TvStreamCandidate, TvStreamSelectResponse } from "@/workers/tv-stream-select.worker";

/**
 * Phase 2 — main-thread facade for the stream selection worker.
 *
 * - Manifest parsing / ranking / buffer tracking stay off-thread.
 * - Time/buffer updates are debounced to 500ms so the UI thread receives at
 *   most 2 small snapshots per second during playback.
 */

type RankedHandler = (best: TvStreamCandidate | null, ordered: TvStreamCandidate[]) => void;
type BufferHandler = (aheadSec: number, starving: boolean) => void;

const TIME_DEBOUNCE_MS = 500;

export class TvStreamSelector {
  private worker: Worker | null = null;
  private rankHandlers = new Set<RankedHandler>();
  private bufferHandlers = new Set<BufferHandler>();
  private lastBufferSentAt = 0;
  private pendingBuffer: { bufferedSec: number; durationSec: number; positionSec: number } | null = null;
  private bufferTimer: number | null = null;

  private ensureWorker(): Worker | null {
    if (typeof window === "undefined") return null;
    if (this.worker) return this.worker;
    try {
      this.worker = new Worker(new URL("@/workers/tv-stream-select.worker.ts", import.meta.url), {
        type: "module",
      });
      this.worker.onmessage = (e: MessageEvent<TvStreamSelectResponse>) => {
        const msg = e.data;
        if (msg.type === "ranked") {
          for (const h of this.rankHandlers) h(msg.best, msg.ordered);
        } else if (msg.type === "buffer-state") {
          for (const h of this.bufferHandlers) h(msg.aheadSec, msg.starving);
        }
      };
    } catch {
      this.worker = null;
    }
    return this.worker;
  }

  rank(candidates: TvStreamCandidate[], maxResolution: number): void {
    this.ensureWorker()?.postMessage({ type: "rank", candidates, maxResolution });
  }

  /** Debounced: buffers rapid oncurrentplaytime ticks into one worker message. */
  trackBuffer(bufferedSec: number, durationSec: number, positionSec: number): void {
    this.pendingBuffer = { bufferedSec, durationSec, positionSec };
    const now = Date.now();
    if (now - this.lastBufferSentAt < TIME_DEBOUNCE_MS) {
      if (this.bufferTimer == null) {
        this.bufferTimer = window.setTimeout(() => this.flushBuffer(), TIME_DEBOUNCE_MS);
      }
      return;
    }
    this.flushBuffer();
  }

  private flushBuffer(): void {
    if (this.bufferTimer != null) {
      window.clearTimeout(this.bufferTimer);
      this.bufferTimer = null;
    }
    if (!this.pendingBuffer) return;
    this.lastBufferSentAt = Date.now();
    const p = this.pendingBuffer;
    this.pendingBuffer = null;
    this.ensureWorker()?.postMessage({ type: "buffer", ...p });
  }

  onRanked(h: RankedHandler): () => void {
    this.rankHandlers.add(h);
    return () => this.rankHandlers.delete(h);
  }

  onBufferState(h: BufferHandler): () => void {
    this.bufferHandlers.add(h);
    return () => this.bufferHandlers.delete(h);
  }

  destroy(): void {
    if (this.bufferTimer != null) window.clearTimeout(this.bufferTimer);
    this.rankHandlers.clear();
    this.bufferHandlers.clear();
    this.worker?.terminate();
    this.worker = null;
  }
}
