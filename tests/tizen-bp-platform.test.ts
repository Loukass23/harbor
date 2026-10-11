// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { createTizenBpPlatform } from "../src-tizen/platform/bp-platform.ts";

const fetchReturning = (resp: Response | Error): typeof fetch =>
  (async () => {
    if (resp instanceof Error) throw resp;
    return resp;
  }) as typeof fetch;

test("the TV reports no LAN address, since nothing on it listens for a phone", async () => {
  const platform = createTizenBpPlatform(fetchReturning(new Response("")));
  assert.equal(await platform.lanAddress(), null);
  assert.equal(platform.servesPhone, false);
});

test("the remote has no top-bar key, so no Nav hint is offered", () => {
  const platform = createTizenBpPlatform(fetchReturning(new Response("")));
  assert.equal(platform.remoteNavKey, false);
});

test("image bytes come straight from fetch", async () => {
  const platform = createTizenBpPlatform(
    fetchReturning(
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    ),
  );
  const blob = await platform.fetchImageBytes(
    "https://images.metahub.space/poster/medium/tt0111161/img",
  );
  assert.ok(blob);
  assert.equal(blob.size, 3);
  assert.equal(blob.type, "image/png");
});

test("image failures resolve to null instead of throwing", async () => {
  const missing = createTizenBpPlatform(fetchReturning(new Response("nope", { status: 404 })));
  assert.equal(await missing.fetchImageBytes("https://example.com/a.jpg"), null);
  const empty = createTizenBpPlatform(fetchReturning(new Response(new Uint8Array())));
  assert.equal(await empty.fetchImageBytes("https://example.com/a.jpg"), null);
  const offline = createTizenBpPlatform(fetchReturning(new TypeError("Failed to fetch")));
  assert.equal(await offline.fetchImageBytes("https://example.com/a.jpg"), null);
});

test("exit is set only when the platform can close the app", () => {
  assert.equal(createTizenBpPlatform(fetchReturning(new Response(""))).exit, undefined);
  let closed = 0;
  const platform = createTizenBpPlatform(fetchReturning(new Response("")), () => void closed++);
  platform.exit?.();
  assert.equal(closed, 1);
});
