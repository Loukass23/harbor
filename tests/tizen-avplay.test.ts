// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test, { mock } from "node:test";
import type { PlayerSnapshot } from "../src/lib/player/bridge.ts";
import {
  AVPLAY_CLASS,
  PREPARE_TIMEOUT_MS,
  avplayErrorCode,
  createAvplayBridge,
  type AvplayDeps,
} from "../src-tizen/player/avplay-bridge.ts";
import type { AvplayListener, AvplayState, AvplayTrack } from "../src-tizen/player/webapis.ts";

type Call = [string, ...unknown[]];

// A failed assertion skips a test's own cleanup; the next test must still get fresh timers.
test.afterEach(() => mock.timers.reset());

function avplayStub(tracks: AvplayTrack[] = [], current: number[] = []) {
  const calls: Call[] = [];
  let state: AvplayState = "NONE";
  let duration = 0;
  let listener: AvplayListener = {};
  const prepares: { ok: () => void; err: (e: unknown) => void }[] = [];
  const rec =
    (name: string, next?: AvplayState) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
      if (next) state = next;
    };
  const avplay = {
    open: rec("open", "IDLE"),
    close: rec("close", "NONE"),
    stop: rec("stop", "IDLE"),
    play: rec("play", "PLAYING"),
    pause: rec("pause", "PAUSED"),
    seekTo: rec("seekTo"),
    setDisplayRect: rec("setDisplayRect"),
    setDisplayMethod: rec("setDisplayMethod"),
    setBufferingParam: rec("setBufferingParam"),
    setStreamingProperty: rec("setStreamingProperty"),
    setSelectTrack: rec("setSelectTrack"),
    suspend: rec("suspend"),
    restore: rec("restore"),
    setListener(l: AvplayListener) {
      calls.push(["setListener"]);
      listener = l;
    },
    prepareAsync(ok: () => void, err: (e: unknown) => void) {
      calls.push(["prepareAsync"]);
      prepares.push({ ok, err });
    },
    getState: () => state,
    getDuration: () => duration,
    getCurrentTime: () => 0,
    getTotalTrackInfo: () => tracks,
    getCurrentStreamInfo: () => tracks.filter((t) => current.includes(t.index)),
  };
  return {
    api: { avplay },
    calls,
    names: () => calls.map((c) => c[0]),
    ready(i = prepares.length - 1) {
      state = "READY";
      prepares[i].ok();
    },
    failPrepare(e: unknown) {
      prepares.at(-1)!.err(e);
    },
    setDuration(ms: number) {
      duration = ms;
    },
    listener: () => listener,
  };
}

function env() {
  const classes = new Set<string>();
  const visibility = new Set<() => void>();
  const resize = new Set<() => void>();
  const doc = {
    visibilityState: "visible",
    documentElement: {
      classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
    },
    createElement: () => {
      const el = {
        style: {} as Record<string, string>,
        parentElement: null as unknown,
        setAttribute() {},
      };
      return el as unknown as HTMLElement;
    },
    addEventListener: (_: string, fn: () => void) => visibility.add(fn),
    removeEventListener: (_: string, fn: () => void) => visibility.delete(fn),
  };
  const win = {
    innerWidth: 1140,
    screen: { width: 1920 },
    addEventListener: (_: string, fn: () => void) => resize.add(fn),
    removeEventListener: (_: string, fn: () => void) => resize.delete(fn),
  };
  const host = {
    appendChild(el: { parentElement: unknown }) {
      el.parentElement = host;
    },
    removeChild(el: { parentElement: unknown }) {
      el.parentElement = null;
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1140, height: 641.25 }),
  } as unknown as HTMLElement;
  const setVisibility = (v: string) => {
    doc.visibilityState = v;
    for (const fn of visibility) fn();
  };
  return { doc, win, host, classes, visibility, resize, setVisibility };
}

const noCues = (() => ({
  text: { subText: "", subStartSec: 0, secondarySubText: "" },
  delaySec: () => 0,
  reset() {},
  list: () => [],
  tick: () => false,
  canAutoSelect: () => true,
  select() {},
  selectSecondary() {},
  setHideSdh() {},
  setDelay() {},
  add: async () => true,
  selectedCues: () => null,
  selectedUrl: () => null,
  destroy() {},
})) as unknown as AvplayDeps["cues"];

function setup(opts: { tracks?: AvplayTrack[]; current?: number[] } = {}) {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const av = avplayStub(opts.tracks, opts.current);
  const e = env();
  const bridge = createAvplayBridge(av.api, { doc: e.doc, win: e.win, cues: noCues, now: () => 0 });
  let snap: PlayerSnapshot | null = null;
  bridge.subscribe((s) => (snap = s));
  bridge.attach(e.host);
  return { av, e, bridge, snap: () => snap! };
}

function done(bridge: { destroy(): void }) {
  bridge.destroy();
  mock.timers.reset();
}

test("open() is the first network touch: no fetch, properties set before prepareAsync", async () => {
  const fetched: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: unknown[]) => {
    fetched.push(args);
    return new Response("");
  }) as typeof fetch;
  const { av, bridge } = setup();
  try {
    await bridge.load({
      url: "https://debrid.example/stream.m3u8",
      headers: { "User-Agent": "Harbor" },
    });
    assert.deepEqual(fetched, []);
    const names = av.names();
    assert.equal(names[0], "open");
    const prepareAt = names.indexOf("prepareAsync");
    for (const n of ["setBufferingParam", "setStreamingProperty", "setDisplayRect", "setListener"])
      assert.ok(names.indexOf(n) >= 0 && names.indexOf(n) < prepareAt, `${n} before prepare`);
    assert.ok(!av.calls.some((c) => c[0] === "setStreamingProperty" && c[1] === "BUFFER_SIZE"));
  } finally {
    globalThis.fetch = realFetch;
    done(bridge);
  }
});

test("a prepare that never answers becomes an error after 30s", async () => {
  const { av, bridge, snap } = setup();
  await bridge.load({ url: "https://x.example/a.mkv" });
  mock.timers.tick(PREPARE_TIMEOUT_MS - 1);
  assert.equal(snap().status, "loading");
  mock.timers.tick(1);
  assert.equal(snap().status, "error");
  assert.equal(snap().errorCode, "decode");
  assert.ok(av.names().includes("prepareAsync"));
  done(bridge);
});

test("the resume seek waits for a real duration", async () => {
  const { av, bridge } = setup();
  await bridge.load({ url: "https://x.example/a.mkv", startAtSec: 600 });
  av.ready();
  assert.ok(!av.names().includes("seekTo"), "no seek while duration reads 0");
  av.setDuration(3_600_000);
  av.listener().oncurrentplaytime?.(0);
  assert.deepEqual(
    av.calls.find((c) => c[0] === "seekTo"),
    ["seekTo", 600_000],
  );
  done(bridge);
});

test("play() before prepare starts playback once prepared", async () => {
  const { av, bridge, snap } = setup();
  await bridge.load({ url: "https://x.example/a.mp4" });
  await bridge.play();
  assert.ok(!av.names().includes("play"));
  av.ready();
  assert.ok(av.names().includes("play"));
  assert.equal(snap().status, "playing");
  done(bridge);
});

test("callbacks from a replaced source are ignored", async () => {
  const { av, bridge, snap } = setup();
  await bridge.load({ url: "https://x.example/first.mp4" });
  await bridge.load({ url: "https://x.example/second.mp4" });
  av.ready(0);
  assert.equal(snap().status, "loading");
  done(bridge);
});

test("hidden suspends and visible restores, without resuming playback", async () => {
  const { av, e, bridge, snap } = setup();
  await bridge.load({ url: "https://x.example/a.mp4" });
  av.ready();
  await bridge.play();
  e.setVisibility("hidden");
  assert.deepEqual(av.names().slice(-2), ["pause", "suspend"]);
  assert.equal(snap().status, "paused");
  e.setVisibility("visible");
  assert.equal(av.names().at(-1), "restore");
  assert.equal(av.names().filter((n) => n === "play").length, 1);
  done(bridge);
});

test("the display rect is in screen pixels: 1140 CSS px wide on GU43DU7199UXZG, ratio 1", async () => {
  const { av, bridge } = setup();
  await bridge.load({ url: "https://x.example/a.mp4" });
  assert.deepEqual(
    av.calls.find((c) => c[0] === "setDisplayRect"),
    ["setDisplayRect", 0, 0, 1920, 1080],
  );
  done(bridge);
});

test("audio tracks come from AVPlay and text tracks are never selected natively", async () => {
  const { av, bridge, snap } = setup({
    tracks: [
      { index: 0, type: "VIDEO", extra_info: '{"Width":"3840","Height":"2160"}' },
      { index: 1, type: "AUDIO", extra_info: '{"language":"eng","channels":"6","fourCC":"EAC3"}' },
      { index: 2, type: "AUDIO", extra_info: '{"language":"fra","channels":"2"}' },
      { index: 3, type: "TEXT", extra_info: '{"language":"eng"}' },
    ],
    // AVPlay starts on the container's default track, not the first one (seen on the TV).
    current: [0, 2],
  });
  await bridge.load({ url: "https://x.example/a.mkv" });
  av.ready();
  assert.equal(snap().videoWidth, 3840);
  assert.deepEqual(
    snap().audioTracks.map((t) => [t.id, t.lang, t.selected]),
    [
      ["avplay-audio-1", "eng", false],
      ["avplay-audio-2", "fra", true],
    ],
  );
  bridge.setAudioTrack("avplay-audio-1");
  bridge.setSubtitleTrack("seed-0");
  assert.deepEqual(
    av.calls.filter((c) => c[0] === "setSelectTrack"),
    [["setSelectTrack", "AUDIO", 1]],
  );
  assert.deepEqual(
    snap().audioTracks.map((t) => t.selected),
    [true, false],
  );
  done(bridge);
});

test("destroy closes AVPlay and removes every hook", async () => {
  const { av, e, bridge } = setup();
  await bridge.load({ url: "https://x.example/a.mp4" });
  assert.ok(e.classes.has(AVPLAY_CLASS));
  bridge.destroy();
  assert.ok(av.names().includes("close"));
  assert.equal(e.classes.size, 0);
  assert.equal(e.visibility.size, 0);
  assert.equal(e.resize.size, 0);
  mock.timers.reset();
});

test("AVPlay error names map to Harbor error codes", () => {
  assert.equal(avplayErrorCode("PLAYER_ERROR_CONNECTION_FAILED"), "network");
  assert.equal(avplayErrorCode("PLAYER_ERROR_INVALID_URI"), "source");
  assert.equal(avplayErrorCode("PLAYER_ERROR_NOT_SUPPORTED_FORMAT"), "codec");
  assert.equal(avplayErrorCode({ name: "PLAYER_ERROR_GENEREIC" }), "decode");
  assert.equal(avplayErrorCode(null), "unknown");
});
