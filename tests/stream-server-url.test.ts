// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { normalizeStreamServerUrl } from "../src/lib/stremio-server.ts";

test("streaming server addresses are trimmed and keep their scheme", () => {
  assert.equal(
    normalizeStreamServerUrl("  https://stream.example.com/ "),
    "https://stream.example.com",
  );
  assert.equal(normalizeStreamServerUrl("HTTP://10.0.0.2:11470//"), "HTTP://10.0.0.2:11470");
});

test("a bare host gets http://, as typed on a remote", () => {
  assert.equal(normalizeStreamServerUrl("192.168.1.50:11470"), "http://192.168.1.50:11470");
});

test("an empty or slash-only address clears the setting", () => {
  assert.equal(normalizeStreamServerUrl(""), "");
  assert.equal(normalizeStreamServerUrl("   "), "");
  assert.equal(normalizeStreamServerUrl("/"), "");
});
