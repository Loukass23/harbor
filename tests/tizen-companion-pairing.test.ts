// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  pairingCode,
  requestPairing,
  streamServerUrl,
  waitForAnswer,
} from "../src-tizen/net/pairing.ts";
import { deviceId, loadCompanion, saveCompanion } from "../src-tizen/net/companion-store.ts";
import { tvName } from "../src-tizen/net/device-name.ts";

const REQUEST = "0123456789abcdef0123456789abcdef";
const TOKEN = "ab".repeat(32);
const HOST = "10.0.0.2";
const PAYLOAD = {
  proto: 1,
  handoff: [{ step: "tmdb", key: "abcdef1234" }],
  debrid: { tbKey: "torbox-key-123" },
  addons: [],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function memory(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

test("the code is always four digits", () => {
  assert.equal(
    pairingCode(() => 0),
    "0000",
  );
  assert.equal(
    pairingCode(() => 0.0042),
    "0042",
  );
  assert.equal(
    pairingCode(() => 0.99999),
    "9999",
  );
});

test("a pair request sends the device and code and returns the request id", async () => {
  let sent: unknown = null;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(url), `http://${HOST}:11471/api/companion/pair`);
    sent = JSON.parse(String(init?.body));
    return json({ requestId: REQUEST });
  }) as typeof fetch;
  const result = await requestPairing({
    fetchImpl,
    host: HOST,
    deviceId: "tv-0123456789abcdef",
    deviceName: "Samsung TV",
    code: "4821",
  });
  assert.deepEqual(result, { requestId: REQUEST });
  assert.deepEqual(sent, {
    deviceId: "tv-0123456789abcdef",
    deviceName: "Samsung TV",
    code: "4821",
  });
});

test("a busy computer and an unreachable one are told apart", async () => {
  const busy = (async () => json({ error: "busy" }, 429)) as typeof fetch;
  const down = (async () => {
    throw new TypeError("refused");
  }) as typeof fetch;
  const base = { host: HOST, deviceId: "tv-0123456789abcdef", deviceName: "TV", code: "1234" };
  assert.deepEqual(await requestPairing({ ...base, fetchImpl: busy }), { error: "busy" });
  assert.deepEqual(await requestPairing({ ...base, fetchImpl: down }), { error: "unreachable" });
});

test("polling waits through pending answers and returns the approval", async () => {
  const answers = [
    json({ status: "pending" }),
    json({ status: "approved", token: TOKEN, payload: PAYLOAD }),
  ];
  const fetchImpl = (async () => answers.shift()!) as typeof fetch;
  const result = await waitForAnswer({ fetchImpl, host: HOST, requestId: REQUEST });
  assert.equal(result.status, "approved");
  if (result.status === "approved") {
    assert.equal(result.token, TOKEN);
    assert.deepEqual(result.payload.debrid, { tbKey: "torbox-key-123" });
  }
});

test("a denial ends the wait", async () => {
  const fetchImpl = (async () => json({ status: "denied" })) as typeof fetch;
  assert.deepEqual(await waitForAnswer({ fetchImpl, host: HOST, requestId: REQUEST }), {
    status: "denied",
  });
});

test("a dropped connection is retried, and the request's lifetime ends the wait", async () => {
  let clock = 0;
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    throw new TypeError("network blip");
  }) as typeof fetch;
  const result = await waitForAnswer({
    fetchImpl,
    host: HOST,
    requestId: REQUEST,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.deepEqual(result, { status: "expired" });
  assert.ok(calls > 10);
});

test("an approval with a malformed payload is not accepted as one", async () => {
  let clock = 0;
  const fetchImpl = (async () =>
    json({ status: "approved", token: "short", payload: PAYLOAD })) as typeof fetch;
  const result = await waitForAnswer({
    fetchImpl,
    host: HOST,
    requestId: REQUEST,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.deepEqual(result, { status: "expired" });
});

test("a running streaming server is used without asking the computer", async () => {
  const fetchImpl = (async () => {
    throw new Error("must not be called");
  }) as typeof fetch;
  const url = await streamServerUrl({
    fetchImpl,
    host: HOST,
    token: TOKEN,
    identity: {
      app: "harbor",
      proto: 1,
      instanceId: REQUEST,
      name: "Desk",
      platform: "",
      version: "",
      streamServer: { running: true, port: 11480 },
    },
  });
  assert.equal(url, `http://${HOST}:11480`);
});

test("a stopped streaming server is started with the pairing token", async () => {
  let auth: string | null = null;
  const fetchImpl = (async (_: RequestInfo | URL, init?: RequestInit) => {
    auth = new Headers(init?.headers).get("authorization");
    return json({ port: 11470 });
  }) as typeof fetch;
  const url = await streamServerUrl({
    fetchImpl,
    host: HOST,
    token: TOKEN,
    identity: {
      app: "harbor",
      proto: 1,
      instanceId: REQUEST,
      name: "Desk",
      platform: "",
      version: "",
      streamServer: { running: false, port: null },
    },
  });
  assert.equal(url, `http://${HOST}:11470`);
  assert.equal(auth, `Bearer ${TOKEN}`);
});

test("the device id is minted once and kept", () => {
  const storage = memory();
  const first = deviceId(storage);
  assert.match(first, /^tv-[0-9a-f]{16}$/);
  assert.equal(deviceId(storage), first);
});

test("the saved companion survives a round trip and junk reads as nothing", () => {
  const storage = memory();
  const saved = { instanceId: REQUEST, host: HOST, name: "Desk", token: TOKEN, serverUrl: "" };
  saveCompanion(saved, storage);
  assert.deepEqual(loadCompanion(storage), saved);
  storage.setItem("harbor.tizen.companion", "{not json");
  assert.equal(loadCompanion(storage), null);
});

test("the TV names itself by model, and survives productinfo throwing", () => {
  assert.equal(tvName({ getRealModel: () => "UE43DU7100" }), "Samsung TV UE43DU7100");
  assert.equal(
    tvName({
      getRealModel: () => {
        throw new Error("SecurityError");
      },
    }),
    "Samsung TV",
  );
  assert.equal(tvName(null), "Samsung TV");
});
