// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  emptySnapshot,
  type PlayerBridge,
  type PlayerSnapshot,
  type PlayerSource,
} from "../src/lib/player/bridge.ts";
import { createFallbackBridge } from "../src-tizen/player/fallback-bridge.ts";

type Fake = PlayerBridge & {
  name: string;
  calls: unknown[][];
  push(patch: Partial<PlayerSnapshot>): void;
  destroyed: boolean;
};

function fake(name: string): Fake {
  let snap: PlayerSnapshot = { ...emptySnapshot };
  const listeners = new Set<(s: PlayerSnapshot) => void>();
  const calls: unknown[][] = [];
  const rec =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push([method, ...args]);
    };
  const self = {
    name,
    calls,
    destroyed: false,
    push(patch: Partial<PlayerSnapshot>) {
      snap = { ...snap, ...patch };
      listeners.forEach((l) => l(snap));
    },
    subscribe(l: (s: PlayerSnapshot) => void) {
      listeners.add(l);
      l(snap);
      return () => listeners.delete(l);
    },
    attach: rec("attach"),
    detach: rec("detach"),
    load: async (src: PlayerSource) => void calls.push(["load", src]),
    play: async () => void calls.push(["play"]),
    pause: rec("pause"),
    seek: rec("seek"),
    setVolume: rec("setVolume"),
    setMuted: rec("setMuted"),
    setRate: rec("setRate"),
    setSubDelay: rec("setSubDelay"),
    addSubtitle: async (...args: unknown[]) => {
      calls.push(["addSubtitle", ...args]);
      return true;
    },
    destroy() {
      self.destroyed = true;
      listeners.clear();
    },
  };
  return self as unknown as Fake;
}

function setup() {
  const made: Fake[] = [];
  const bridge = createFallbackBridge(
    () => {
      const b = fake("avplay");
      made.push(b);
      return b;
    },
    () => {
      const b = fake("html5");
      made.push(b);
      return b;
    },
  );
  const seen: PlayerSnapshot[] = [];
  bridge.subscribe((s) => seen.push(s));
  const host = {} as HTMLElement;
  bridge.attach(host);
  return { bridge, made, seen, host };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test("a prepare failure switches to HTML5 once, at the same position, with settings carried over", async () => {
  const { bridge, made, seen, host } = setup();
  bridge.setVolume(0.5);
  bridge.setSubDelay(1.5);
  await bridge.load({ url: "https://x.example/a.mkv", startAtSec: 600 });
  await bridge.addSubtitle("https://subs.example/a.srt", "en", "English", true);
  await bridge.play();
  const [avplay] = made;
  avplay.push({ status: "error", errorCode: "network", errorMessage: "prepare failed" });
  await flush();

  assert.equal(made.length, 2);
  const html5 = made[1];
  assert.ok(avplay.destroyed);
  assert.equal(html5.name, "html5");
  const names = html5.calls.map((c) => c[0]);
  // Settings follow load(): the HTML5 load resets sub delay, mute and speed.
  assert.deepEqual(names, ["attach", "load", "setVolume", "setSubDelay", "addSubtitle", "play"]);
  assert.equal(html5.calls[0][1], host);
  assert.equal((html5.calls[1][1] as PlayerSource).startAtSec, 600);
  assert.ok(!seen.some((s) => s.status === "error"), "the failing snapshot is never shown");

  html5.push({ status: "error", errorCode: "decode" });
  await flush();
  assert.equal(made.length, 2, "only one fallback per source");
  assert.equal(seen.at(-1)?.status, "error");
});

test("a network error after the first frame is not the engine's fault", async () => {
  const { bridge, made, seen } = setup();
  await bridge.load({ url: "https://x.example/a.mkv" });
  made[0].push({ firstFrameReady: true, positionSec: 40, status: "playing" });
  made[0].push({ status: "error", errorCode: "network" });
  await flush();
  assert.equal(made.length, 1);
  assert.equal(seen.at(-1)?.errorCode, "network");
});

test("a decode error mid-play falls back and resumes where it stopped", async () => {
  const { bridge, made } = setup();
  await bridge.load({ url: "https://x.example/a.mkv" });
  made[0].push({ firstFrameReady: true, positionSec: 40, status: "playing" });
  made[0].push({ status: "error", errorCode: "decode" });
  await flush();
  const load = made[1].calls.find((c) => c[0] === "load");
  assert.ok(load);
  assert.equal((load[1] as PlayerSource).startAtSec, 40);
});

test("the next source goes back to AVPlay", async () => {
  const { bridge, made } = setup();
  await bridge.load({ url: "https://x.example/a.mkv" });
  made[0].push({ status: "error", errorCode: "codec" });
  await flush();
  await bridge.load({ url: "https://x.example/b.mp4" });
  assert.equal(made.length, 3);
  assert.equal(made[2].name, "avplay");
  assert.ok(made[1].destroyed);
});

test("closing the player mid-switch stops the fallback from playing", async () => {
  const { bridge, made } = setup();
  await bridge.load({ url: "https://x.example/a.mkv" });
  await bridge.play();
  made[0].push({ status: "error", errorCode: "codec" });
  bridge.destroy();
  await flush();
  assert.ok(!made[1].calls.some((c) => c[0] === "play"));
});

function deferredSetup() {
  const made: Fake[] = [];
  let release: (() => void) | null = null;
  const bridge = createFallbackBridge(
    () => {
      const b = fake("avplay");
      made.push(b);
      return b;
    },
    () =>
      new Promise<PlayerBridge>((resolve) => {
        release = () => {
          const b = fake("html5");
          made.push(b);
          resolve(b);
        };
      }),
  );
  const seen: PlayerSnapshot[] = [];
  bridge.subscribe((s) => seen.push(s));
  bridge.attach({} as HTMLElement);
  return { bridge, made, seen, release: () => release?.() };
}

test("an async fallback hides the failing primary while it loads, then plays", async () => {
  const { bridge, made, seen, release } = deferredSetup();
  await bridge.load({ url: "https://x.example/a.mkv" });
  await bridge.play();
  made[0].push({ status: "error", errorCode: "codec" });
  made[0].push({ status: "error", errorCode: "codec", errorMessage: "again" });
  await flush();
  assert.equal(made.length, 1, "the primary stays until the fallback is ready");
  assert.ok(!seen.some((s) => s.status === "error"));
  release();
  await flush();
  assert.equal(made[1].name, "html5");
  assert.ok(made[0].destroyed);
  assert.deepEqual(
    made[1].calls.map((c) => c[0]),
    ["attach", "load", "play"],
  );
});

test("a new load while the fallback loads keeps the primary and drops the fallback", async () => {
  const { bridge, made, release } = deferredSetup();
  await bridge.load({ url: "https://x.example/a.mkv" });
  made[0].push({ status: "error", errorCode: "codec" });
  await bridge.load({ url: "https://x.example/b.mp4" });
  release();
  await flush();
  assert.ok(!made[0].destroyed);
  assert.ok(made[1].destroyed);
  assert.ok(!made[1].calls.some((c) => c[0] === "load"));
  const last = made[0].calls.at(-1) ?? [];
  assert.equal((last[1] as PlayerSource).url, "https://x.example/b.mp4");
});
