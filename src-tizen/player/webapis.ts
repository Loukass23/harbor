// The slice of Samsung's `webapis` Harbor uses, declared by hand like
// platform/tizen-api.ts and passed around as a value so tests can stub it.

export type AvplayState = "NONE" | "IDLE" | "READY" | "PLAYING" | "PAUSED";

export type AvplayTrack = {
  index: number;
  type: "VIDEO" | "AUDIO" | "TEXT" | string;
  /** JSON string: language, channels, fourCC and so on. Shape varies by firmware. */
  extra_info: string;
};

export type AvplayListener = {
  onbufferingstart?: () => void;
  onbufferingprogress?: (percent: number) => void;
  onbufferingcomplete?: () => void;
  oncurrentplaytime?: (ms: number) => void;
  onstreamcompleted?: () => void;
  onevent?: (type: string, data: string) => void;
  onerror?: (type: string) => void;
  onsubtitlechange?: (duration: number, text: string) => void;
  ondrmevent?: (type: string, data: unknown) => void;
};

export type Avplay = {
  open(url: string): void;
  close(): void;
  prepareAsync(onSuccess: () => void, onError: (err: unknown) => void): void;
  play(): void;
  pause(): void;
  stop(): void;
  seekTo(ms: number, onSuccess?: () => void, onError?: (err: unknown) => void): void;
  getState(): AvplayState;
  getDuration(): number;
  getCurrentTime(): number;
  setDisplayRect(x: number, y: number, width: number, height: number): void;
  setDisplayMethod?(method: string): void;
  setListener(listener: AvplayListener): void;
  setBufferingParam?(option: string, unit: string, amount: number): void;
  setStreamingProperty?(type: string, value: string): void;
  getTotalTrackInfo?(): AvplayTrack[];
  /** The tracks playing now, one per type. */
  getCurrentStreamInfo?(): AvplayTrack[];
  setSelectTrack?(type: string, index: number): void;
  setSpeed?(speed: number): void;
  suspend?(): void;
  restore?(): void;
};

export type ProductInfo = {
  isUdPanelSupported?(): boolean;
};

export type Webapis = {
  avplay: Avplay;
  productinfo?: ProductInfo;
};

export function webapis(): Webapis | null {
  const w = (globalThis as { webapis?: Partial<Webapis> }).webapis;
  return w?.avplay ? (w as Webapis) : null;
}
