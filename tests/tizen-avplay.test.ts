import "./_localstorage-stub.ts";
import "./_window-stub.ts";

// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  TizenAVPlayer,
  createAvplayBridge,
  type AVPlayListener,
  type AVPlayState,
  type WebapisAVPlay,
  type WebapisProductInfo,
} from "../src/lib/player/tizen-avplay.ts";
import { pickBridge } from "../src/views/player/player-utils.ts";

function createMockAvplay(overrides: Partial<WebapisAVPlay> = {}) {
  let state: AVPlayState = "NONE";
  let listener: AVPlayListener | null = null;
  const streamingProperties = new Map<string, string>();
  let externalSubtitlePath: string | null = null;
  let displayRect = { x: 0, y: 0, width: 0, height: 0 };
  let displayMethod = "";
  let currentTime = 0;
  let duration = 120_000;
  let playbackRate = 1;
  const calls: string[] = [];

  const mock: WebapisAVPlay = {
    open(url: string) {
      calls.push(`open:${url}`);
      state = "IDLE";
    },
    close() {
      calls.push("close");
      state = "NONE";
    },
    prepare() {
      calls.push("prepare");
      state = "READY";
    },
    prepareAsync(success, _error) {
      calls.push("prepareAsync");
      state = "READY";
      if (success) setTimeout(success, 0);
    },
    play() {
      calls.push("play");
      state = "PLAYING";
    },
    pause() {
      calls.push("pause");
      state = "PAUSED";
    },
    stop() {
      calls.push("stop");
      state = "IDLE";
    },
    seekTo(timeMs, success, _error) {
      calls.push(`seekTo:${timeMs}`);
      currentTime = timeMs;
      if (success) success();
    },
    getState() {
      return state;
    },
    getDuration() {
      return duration;
    },
    getCurrentTime() {
      return currentTime;
    },
    setListener(l) {
      calls.push("setListener");
      listener = l;
    },
    setDisplayRect(x, y, w, h) {
      calls.push(`setDisplayRect:${x},${y},${w},${h}`);
      displayRect = { x, y, width: w, height: h };
    },
    setDisplayMethod(method) {
      calls.push(`setDisplayMethod:${method}`);
      displayMethod = method;
    },
    setStreamingProperty(prop, val) {
      calls.push(`setStreamingProperty:${prop}=${val}`);
      streamingProperties.set(prop, val);
    },
    setExternalSubtitlePath(filePath) {
      calls.push(`setExternalSubtitlePath:${filePath}`);
      externalSubtitlePath = filePath;
    },
    getTotalTrackInfo() {
      return [
        { index: 0, type: "VIDEO", extra_info: '{"width":1920,"height":1080}' },
        { index: 1, type: "AUDIO", extra_info: '{"language":"eng"}' },
        { index: 2, type: "TEXT", extra_info: '{"language":"fre"}' },
      ];
    },
    getCurrentStreamInfo() {
      return [];
    },
    setSelectTrack(trackType, trackIndex) {
      calls.push(`setSelectTrack:${trackType},${trackIndex}`);
    },
    setPlaybackRate(rate) {
      calls.push(`setPlaybackRate:${rate}`);
      playbackRate = rate;
    },
    suspend() {
      calls.push("suspend");
    },
    restore() {
      calls.push("restore");
    },
    ...overrides,
  };

  return {
    mock,
    calls,
    get state() {
      return state;
    },
    get listener() {
      return listener;
    },
    get streamingProperties() {
      return streamingProperties;
    },
    get externalSubtitlePath() {
      return externalSubtitlePath;
    },
    get displayRect() {
      return displayRect;
    },
    get displayMethod() {
      return displayMethod;
    },
    get playbackRate() {
      return playbackRate;
    },
  };
}

test("TizenAVPlayer strictly follows NONE -> IDLE -> READY state machine", async () => {
  const { mock, calls } = createMockAvplay();
  const player = new TizenAVPlayer({}, { webapis: { avplay: mock } });

  assert.equal(player.getState(), "NONE");

  await player.initialize("http://test.stream/video.mp4");

  assert.equal(player.getState(), "READY");
  assert.ok(calls.includes("open:http://test.stream/video.mp4"));
  assert.ok(calls.includes("prepareAsync"));

  player.play();
  assert.equal(player.getState(), "PLAYING");
  assert.ok(calls.includes("play"));

  player.pause();
  assert.equal(player.getState(), "PAUSED");
  assert.ok(calls.includes("pause"));

  player.stop();
  assert.equal(player.getState(), "IDLE");
  assert.ok(calls.includes("stop"));

  player.close();
  assert.equal(player.getState(), "NONE");
  assert.ok(calls.includes("close"));

  player.destroy();
});

test("TizenAVPlayer applies 4K, adaptive streaming, and subtitles in IDLE state", async () => {
  const fixture = createMockAvplay();
  const { mock, calls, streamingProperties } = fixture;
  const productinfo: WebapisProductInfo = {
    isUdPanelSupported: () => true,
  };

  const player = new TizenAVPlayer({}, { webapis: { avplay: mock, productinfo } });

  await player.initialize("http://test.stream/master.m3u8", {
    adaptiveInfo: "BITRATES=5000~10000|STARTBITRATE=HIGHEST",
    externalSubtitlePath: "/opt/usr/home/owner/apps_data/Harbor/sub.srt",
  });

  // Verify 4K property
  assert.equal(streamingProperties.get("SET_MODE_4K"), "TRUE");

  // Verify adaptive info
  assert.equal(
    streamingProperties.get("ADAPTIVE_INFO"),
    "BITRATES=5000~10000|STARTBITRATE=HIGHEST",
  );

  // Verify external subtitle path
  assert.equal(fixture.externalSubtitlePath, "/opt/usr/home/owner/apps_data/Harbor/sub.srt");

  // Verify order: open comes before setStreamingProperty, which comes before prepareAsync
  const openIdx = calls.findIndex((c) => c.startsWith("open:"));
  const set4kIdx = calls.indexOf("setStreamingProperty:SET_MODE_4K=TRUE");
  const adaptiveIdx = calls.indexOf(
    "setStreamingProperty:ADAPTIVE_INFO=BITRATES=5000~10000|STARTBITRATE=HIGHEST",
  );
  const prepareIdx = calls.indexOf("prepareAsync");

  assert.ok(openIdx < set4kIdx, "open must precede 4K config");
  assert.ok(openIdx < adaptiveIdx, "open must precede adaptive config");
  assert.ok(set4kIdx < prepareIdx, "4K config must precede prepareAsync");
  assert.ok(adaptiveIdx < prepareIdx, "adaptive config must precede prepareAsync");

  player.destroy();
});

test("TizenAVPlayer omits 4K property when panel does not support UHD", async () => {
  const { mock, streamingProperties } = createMockAvplay();
  const productinfo: WebapisProductInfo = {
    isUdPanelSupported: () => false,
  };

  const player = new TizenAVPlayer({}, { webapis: { avplay: mock, productinfo } });
  await player.initialize("http://test.stream/video.mp4");

  assert.equal(streamingProperties.has("SET_MODE_4K"), false);
  player.destroy();
});

test("TizenAVPlayer handles visibilitychange suspend and restore", async () => {
  const { mock, calls } = createMockAvplay();
  const player = new TizenAVPlayer({}, { webapis: { avplay: mock } });

  await player.initialize("http://test.stream/video.mp4");
  player.play();

  // Simulate TV menu opening (document hidden)
  document.hidden = true;
  document.dispatchEvent({ type: "visibilitychange" });

  assert.ok(calls.includes("suspend"));

  // Simulate TV returning to app (document visible)
  document.hidden = false;
  document.dispatchEvent({ type: "visibilitychange" });

  assert.ok(calls.includes("restore"));

  player.destroy();
});

test("createAvplayBridge satisfies PlayerBridge interface with hardwareDecode and hdr capabilities", async () => {
  const { mock } = createMockAvplay();
  const bridge = createAvplayBridge({ webapis: { avplay: mock } });

  const caps = bridge.capabilities();
  assert.equal(caps.engine, "avplay");
  assert.equal(caps.hardwareDecode, true);
  assert.equal(caps.hdrPassthrough, true);
  assert.equal(caps.pictureInPicture, false);

  let latestSnap: any = null;
  const unsubscribe = bridge.subscribe((s) => {
    latestSnap = s;
  });

  const dummyHost = (document as any).createElement("div");
  bridge.attach(dummyHost);
  assert.equal(dummyHost.style.backgroundColor, "transparent");

  await bridge.load({
    url: "https://example.com/movie.mp4",
    startAtSec: 15,
  });

  assert.ok(latestSnap);
  assert.equal(latestSnap.status, "ready");
  assert.equal(latestSnap.durationSec, 120);

  bridge.seek(45);
  assert.equal(latestSnap.positionSec, 45);

  bridge.setVolume(0.8);
  assert.equal(latestSnap.volume, 0.8);

  bridge.setMuted(true);
  assert.equal(latestSnap.muted, true);

  bridge.pause();
  assert.equal(latestSnap.status, "paused");

  await bridge.play();
  assert.equal(latestSnap.status, "playing");

  unsubscribe();
  bridge.destroy();
});

test("pickBridge selects createAvplayBridge when running on Tizen", async () => {
  // Mock window.tizen environment
  const originalTizen = (globalThis as any).window.tizen;
  const originalWebapis = (globalThis as any).window.webapis;

  (globalThis as any).window.tizen = { tvinputdevice: {} };

  const { mock } = createMockAvplay();
  (globalThis as any).window.webapis = { avplay: mock };

  const picked = await pickBridge("auto", false, {
    anime4k: false,
    hdrToSdr: false,
  });

  assert.equal(picked.engine, "html5");
  assert.equal(picked.bridge.capabilities().engine, "avplay");

  picked.bridge.destroy();
  if (originalTizen !== undefined) (globalThis as any).window.tizen = originalTizen;
  else delete (globalThis as any).window.tizen;
  if (originalWebapis !== undefined) (globalThis as any).window.webapis = originalWebapis;
  else delete (globalThis as any).window.webapis;
});
