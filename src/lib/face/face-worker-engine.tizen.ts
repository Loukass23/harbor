import type { WireFace } from "./match";

// Tizen TV substitute for face-worker-engine.ts (see vite.config.ts tizen
// alias). The full engine pulls onnxruntime-web (~13MB of wasm), MediaPipe
// and three model files that are desktop-only assets (publicDir is disabled
// for the tizen build), so X-Ray face matching cannot run inside the TV
// widget. Every entry point rejects with a clear message, which surfaces
// through useFaceId's existing error channel exactly like a missing model
// file does on desktop.

const UNAVAILABLE = "Face recognition isn't available in the TV app.";

export function ensureWorkerFaceEngine(): Promise<void> {
  return Promise.reject(new Error(UNAVAILABLE));
}

export async function scanWorkerFrame(
  _bitmap: ImageBitmap,
  _width: number,
  _height: number,
): Promise<WireFace[]> {
  throw new Error(UNAVAILABLE);
}

export async function embedWorkerLargestFace(_bitmap: ImageBitmap): Promise<number[] | null> {
  throw new Error(UNAVAILABLE);
}
