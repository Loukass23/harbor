// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import type { PlayerBridge } from "../src/lib/player/bridge.ts";
import { setWebPlayerEngine, webPlayerEngine } from "../src/lib/player/web-engine.ts";

test("no platform engine by default, so the player builds the HTML5 bridge", () => {
  assert.equal(webPlayerEngine(), null);
});

test("a registered engine is returned until it is cleared", () => {
  const bridge = {} as PlayerBridge;
  setWebPlayerEngine(() => bridge);
  assert.equal(webPlayerEngine()?.(), bridge);
  setWebPlayerEngine(null);
  assert.equal(webPlayerEngine(), null);
});
