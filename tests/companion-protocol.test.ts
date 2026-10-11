// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { parseCompanionIdentity, parseCompanionPayload } from "../src/lib/companion/protocol.ts";
import { availableSections, buildCompanionPayload } from "../src/lib/companion/build-payload.ts";

const SOURCE = {
  stremioAuthKey: "stremio-auth-key-123",
  settings: { tmdbKey: "abcdef1234", tbKey: "torbox-key-123", rdKey: "" },
  addons: [{ id: "com.example.addon", transportUrl: "https://addon.example/manifest.json" }],
};

test("only sections with something in them are offered", () => {
  assert.deepEqual(availableSections(SOURCE), ["stremio", "tmdb", "debrid", "addons"]);
  assert.deepEqual(
    availableSections({ stremioAuthKey: null, settings: { tmdbKey: " " }, addons: [] }),
    [],
  );
});

test("the payload carries exactly the chosen sections", () => {
  const payload = buildCompanionPayload(new Set(["tmdb", "debrid"]), SOURCE);
  assert.deepEqual(payload.handoff, [{ step: "tmdb", key: "abcdef1234" }]);
  assert.deepEqual(payload.debrid, { tbKey: "torbox-key-123" });
  assert.deepEqual(payload.addons, []);
});

test("the Stremio sign-in travels as the hand-off step the TV already applies", () => {
  const payload = buildCompanionPayload(new Set(["stremio"]), SOURCE);
  assert.deepEqual(payload.handoff, [
    { step: "stremio", authKey: "stremio-auth-key-123", label: null },
  ]);
});

test("the device drops anything malformed or unexpected from the LAN", () => {
  const parsed = parseCompanionPayload({
    proto: 1,
    handoff: [
      { step: "tmdb", key: "bad key with spaces" },
      { step: "harbor", session: "x".repeat(20), handle: "me" },
      { step: "stremio", authKey: "stremio-auth-key-123" },
    ],
    debrid: { tbKey: "torbox-key-123", evil: "x", rdKey: 5 },
    addons: [
      { id: "ok.addon", transportUrl: "https://addon.example/manifest.json" },
      { id: "bad", transportUrl: "javascript:alert(1)" },
    ],
    extra: true,
  });
  assert.deepEqual(parsed, {
    proto: 1,
    handoff: [{ step: "stremio", authKey: "stremio-auth-key-123", label: null }],
    debrid: { tbKey: "torbox-key-123" },
    addons: [{ id: "ok.addon", transportUrl: "https://addon.example/manifest.json" }],
  });
  assert.equal(parseCompanionPayload({ proto: 2 }), null);
  assert.equal(parseCompanionPayload(null), null);
});

test("an identity must be Harbor's and carry a well-formed instance id", () => {
  const ok = parseCompanionIdentity({
    app: "harbor",
    proto: 1,
    instanceId: "0123456789abcdef0123456789abcdef",
    name: "Desk",
    platform: "windows",
    version: "0.9.132",
    streamServer: { running: false, port: null },
  });
  assert.equal(ok?.name, "Desk");
  assert.equal(ok?.streamServer.port, null);
  assert.equal(parseCompanionIdentity({ app: "harbor", proto: 1, instanceId: "x" }), null);
});
