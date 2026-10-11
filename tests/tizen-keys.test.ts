// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  BACK_DEBOUNCE_MS,
  BACK_KEYCODE,
  REMOTE_KEYS,
  createKeyTranslator,
  registerRemoteKeys,
} from "../src-tizen/platform/keys.ts";
import { installLifecycle } from "../src-tizen/platform/lifecycle.ts";
import type { TizenKey } from "../src-tizen/platform/tizen-api.ts";

const SUPPORTED: TizenKey[] = [
  { name: "MediaPlayPause", code: 10252 },
  { name: "MediaFastForward", code: 417 },
  { name: "ChannelUp", code: 427 },
  { name: "ColorF0Red", code: 403 },
];

function inputStub(batch: boolean) {
  const registered: string[] = [];
  return {
    registered,
    getSupportedKeys: () => SUPPORTED,
    registerKey: (name: string) => void registered.push(name),
    ...(batch
      ? {
          // Mirrors the TV: an explicit undefined callback throws TypeMismatchError.
          registerKeyBatch: (names: string[], onSuccess?: unknown, onError?: unknown) => {
            if (onSuccess === undefined || onError === undefined) {
              throw new Error("TypeMismatchError: Cannot convert undefined to function.");
            }
            registered.push(...names);
          },
        }
      : {}),
  };
}

const back = (type = "keydown", repeat = false) => ({
  type,
  key: "XF86Back",
  keyCode: BACK_KEYCODE,
  repeat,
});

test("registers only supported keys the app handles, with or without registerKeyBatch", () => {
  for (const batch of [true, false]) {
    const input = inputStub(batch);
    const names = registerRemoteKeys(input);
    assert.deepEqual(input.registered, ["MediaPlayPause", "MediaFastForward"]);
    assert.deepEqual(
      [...names],
      [
        [10252, "MediaPlayPause"],
        [417, "MediaFastForward"],
      ],
    );
  }
});

test("a failing registerKey does not stop the others", () => {
  const registered: string[] = [];
  const warn = console.warn;
  console.warn = () => {};
  try {
    registerRemoteKeys({
      getSupportedKeys: () => SUPPORTED,
      registerKey: (name) => {
        if (name === "MediaPlayPause") throw new Error("denied");
        registered.push(name);
      },
    });
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(registered, ["MediaFastForward"]);
});

test("never registers keys the system needs", () => {
  assert.ok(!REMOTE_KEYS.includes("ChannelUp"));
  assert.ok(!REMOTE_KEYS.some((k) => k.startsWith("Color")));
});

test("Back becomes Escape, which every Big Picture layer closes on", () => {
  const translate = createKeyTranslator(new Map());
  assert.deepEqual(translate(back(), 1000), { kind: "send", key: "Escape", keyCode: 27 });
});

test("one Back press closes one layer: repeats, keyup and presses within 250ms are dropped", () => {
  const translate = createKeyTranslator(new Map());
  assert.equal(translate(back(), 1000).kind, "send");
  assert.equal(translate(back("keydown", true), 1050).kind, "drop");
  assert.equal(translate(back("keyup"), 1060).kind, "drop");
  assert.equal(translate(back(), 1000 + BACK_DEBOUNCE_MS - 1).kind, "drop");
  assert.equal(translate(back(), 1000 + BACK_DEBOUNCE_MS).kind, "send");
});

test("the Escape it sends passes through untouched", () => {
  const translate = createKeyTranslator(new Map([[10252, "MediaPlayPause"]]));
  assert.deepEqual(translate({ type: "keydown", key: "Escape", keyCode: 27, repeat: false }, 0), {
    kind: "pass",
  });
});

test("media keys reach the app under their standard key names", () => {
  const translate = createKeyTranslator(new Map([[10252, "MediaPlayPause"]]));
  const raw = { type: "keydown", key: "Unidentified", keyCode: 10252, repeat: false };
  assert.deepEqual(translate(raw, 0), { kind: "send", key: "MediaPlayPause", keyCode: 10252 });
  assert.deepEqual(translate({ ...raw, key: "MediaPlayPause" }, 0), { kind: "pass" });
  assert.deepEqual(translate({ ...raw, key: "ArrowDown", keyCode: 40 }, 0), { kind: "pass" });
});

test("hiding the app pauses playing media and resumes nothing", () => {
  let handler = () => {};
  const playing = {
    paused: false,
    pauses: 0,
    pause() {
      this.paused = true;
      this.pauses += 1;
    },
  };
  const idle = {
    paused: true,
    pauses: 0,
    pause() {
      this.pauses += 1;
    },
  };
  const doc = {
    visibilityState: "visible",
    addEventListener: (_: string, fn: () => void) => void (handler = fn),
    querySelectorAll: () => [playing, idle],
  };
  installLifecycle(doc);
  handler();
  assert.equal(playing.pauses, 0);
  doc.visibilityState = "hidden";
  handler();
  assert.equal(playing.pauses, 1);
  assert.equal(idle.pauses, 0);
  doc.visibilityState = "visible";
  handler();
  assert.equal(playing.paused, true);
});
