import type { WireFace } from "@/lib/face/match";

// Stands in for src/lib/face/face-engine.ts in the Tizen build (see vite.config.ts).
// The real engine pulls in a worker, onnxruntime and mediapipe, about 70 MB with
// their models. AVPlay draws on a hardware plane no canvas can capture, so
// installTizenPlatform turns face matching off and nothing here ever runs.

const unavailable = () => new Error("X-Ray face matching is not available on this device");

export function ensureFaceEngine(): Promise<void> {
  return Promise.reject(unavailable());
}

export function releaseFaceEngine(): void {}

export function scanFrame(
  _bitmap: ImageBitmap,
  _width: number,
  _height: number,
): Promise<WireFace[]> {
  return Promise.reject(unavailable());
}

export function embedLargestFace(_bitmap: ImageBitmap): Promise<number[] | null> {
  return Promise.reject(unavailable());
}
