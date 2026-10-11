// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import "./_localstorage-stub.ts";
import { directStreamAvailable } from "../src/lib/torrent/stremio-stream.ts";

const HASH = "0123456789abcdef0123456789abcdef01234567";
const g = globalThis as { window?: Record<string, unknown> };

function setup(win: Record<string, unknown>, settings: Record<string, unknown> | null) {
  g.window = win;
  localStorage.clear();
  if (settings) localStorage.setItem("harbor.settings", JSON.stringify(settings));
}

test("the desktop app streams torrents through its own engine", () => {
  setup({ __TAURI_INTERNALS__: {} }, null);
  assert.equal(directStreamAvailable({ infoHash: HASH }), true);
});

test("the web build with no server cannot stream torrents", () => {
  setup({}, null);
  assert.equal(directStreamAvailable({ infoHash: HASH }), false);
});

test("the web build streams torrents through a configured remote server", () => {
  setup({}, { remoteStreamServerUrl: "http://192.168.1.50:11470" });
  assert.equal(directStreamAvailable({ infoHash: HASH }), true);
});

test("turning torrents off wins over a remote server", () => {
  setup({}, { remoteStreamServerUrl: "http://192.168.1.50:11470", torrentsDisabled: true });
  assert.equal(directStreamAvailable({ infoHash: HASH }), false);
});

test("a stream without an info hash is never a direct torrent", () => {
  setup({}, { remoteStreamServerUrl: "http://192.168.1.50:11470" });
  assert.equal(directStreamAvailable({ infoHash: null }), false);
});
