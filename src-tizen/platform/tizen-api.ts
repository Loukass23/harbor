// The slice of the Tizen web API Harbor uses. Declared here instead of pulling
// in a typings package, and passed around as values so tests can stub it.

export type TizenKey = { name: string; code: number };

export type TvInputDevice = {
  getSupportedKeys(): TizenKey[];
  registerKey(name: string): void;
  // Callbacks must be functions or null: undefined throws TypeMismatchError.
  registerKeyBatch?(
    names: string[],
    onSuccess?: (() => void) | null,
    onError?: ((err: unknown) => void) | null,
  ): void;
};

export type TizenApplication = {
  getCurrentApplication(): { exit(): void };
};

export type TizenApi = {
  tvinputdevice: TvInputDevice;
  application: TizenApplication;
};

export function tizenApi(): TizenApi | null {
  return (globalThis as { tizen?: TizenApi }).tizen ?? null;
}
