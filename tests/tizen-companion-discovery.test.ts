// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { localAddress, sweepHosts } from "../src-tizen/net/network.ts";
import { probeHost, sweep, type Found } from "../src-tizen/net/discovery.ts";
import { refindCompanion } from "../src-tizen/net/refind.ts";

const ID = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";

function identity(instanceId = ID) {
  return {
    app: "harbor",
    proto: 1,
    instanceId,
    name: "Desk",
    platform: "windows",
    version: "0.9.132",
    streamServer: { running: true, port: 11470 },
  };
}

/** Answers like a LAN where only the listed URLs exist; everything else refuses. */
function lan(routes: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!(url in routes)) throw new TypeError("connection refused");
    return new Response(JSON.stringify(routes[url]), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

test("a /24 sweep covers every other host and skips the TV itself", () => {
  const hosts = sweepHosts({ ip: "192.168.1.20", mask: "255.255.255.0" });
  assert.equal(hosts.length, 253);
  assert.ok(!hosts.includes("192.168.1.20"));
  assert.equal(hosts[0], "192.168.1.1");
  assert.equal(hosts.at(-1), "192.168.1.254");
});

test("a wider mask is capped at the TV's /24", () => {
  const hosts = sweepHosts({ ip: "10.0.5.9", mask: "255.255.0.0" });
  assert.equal(hosts.length, 253);
  assert.ok(hosts.every((h) => h.startsWith("10.0.5.")));
});

test("a narrower mask sweeps only its own range", () => {
  const hosts = sweepHosts({ ip: "192.168.1.130", mask: "255.255.255.128" });
  assert.equal(hosts.length, 125);
  assert.equal(hosts[0], "192.168.1.129");
});

test("a missing or malformed mask falls back to a /24", () => {
  assert.equal(sweepHosts({ ip: "192.168.1.20", mask: "" }).length, 253);
  assert.equal(sweepHosts({ ip: "192.168.1.20", mask: "255.0.255.0" }).length, 253);
  assert.deepEqual(sweepHosts({ ip: "nonsense", mask: "" }), []);
});

test("the address comes from webapis.network first", async () => {
  const addr = await localAddress({
    network: { getIp: () => "192.168.1.20", getSubnetMask: () => "255.255.255.0" },
    systeminfo: null,
  });
  assert.deepEqual(addr, { ip: "192.168.1.20", mask: "255.255.255.0" });
});

test("systeminfo is the fallback when webapis.network throws", async () => {
  const addr = await localAddress({
    network: {
      getIp: () => {
        throw new Error("SecurityError");
      },
    },
    systeminfo: {
      getPropertyValue: (prop, ok, err) =>
        prop === "WIFI_NETWORK"
          ? ok({ ipAddress: "192.168.0.7", subnetMask: "255.255.255.0" })
          : err?.(new Error("not connected")),
    },
  });
  assert.deepEqual(addr, { ip: "192.168.0.7", mask: "255.255.255.0" });
});

test("no network API at all means no address", async () => {
  assert.equal(await localAddress({ network: null, systeminfo: null }), null);
});

test("a host is classed as Harbor, a plain streaming server, or nothing", async () => {
  const fetchImpl = lan({
    "http://10.0.0.2:11471/api/companion/identity": identity(),
    "http://10.0.0.3:11470/settings": { values: { serverVersion: "4.20.8" } },
  });
  const harbor = await probeHost("10.0.0.2", { fetchImpl });
  assert.equal(harbor?.kind, "harbor");
  const stremio = await probeHost("10.0.0.3", { fetchImpl });
  assert.deepEqual(stremio, { kind: "stremio", host: "10.0.0.3", url: "http://10.0.0.3:11470" });
  assert.equal(await probeHost("10.0.0.4", { fetchImpl }), null);
});

test("an identity that is not Harbor's is not taken for one", async () => {
  const fetchImpl = lan({
    "http://10.0.0.2:11471/api/companion/identity": { app: "other", instanceId: ID },
  });
  assert.equal(await probeHost("10.0.0.2", { fetchImpl }), null);
});

test("a probe that hangs is given up after the timeout", async () => {
  const hang = ((_: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof fetch;
  const started = Date.now();
  assert.equal(await probeHost("10.0.0.9", { fetchImpl: hang, timeoutMs: 30 }), null);
  assert.ok(Date.now() - started < 1000);
});

test("the sweep never runs more probes at once than its concurrency", async () => {
  let live = 0;
  let peak = 0;
  const hosts = Array.from({ length: 50 }, (_, i) => `10.0.0.${i + 1}`);
  const seen: Found[] = [];
  await sweep({
    hosts,
    concurrency: 6,
    fetchImpl: lan({}),
    onFound: (f) => seen.push(f),
    probe: async (host) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 2));
      live -= 1;
      return host === "10.0.0.7" ? { kind: "stremio", host, url: `http://${host}:11470` } : null;
    },
  });
  assert.equal(peak, 6);
  assert.deepEqual(
    seen.map((f) => f.host),
    ["10.0.0.7"],
  );
});

test("the paired computer is found again after its address moved", async () => {
  const saved = { instanceId: ID, host: "10.0.0.2", name: "Desk", token: "t", serverUrl: "" };
  const fetchImpl = lan({
    "http://10.0.0.2:11471/api/companion/identity": identity(OTHER),
    "http://10.0.0.5:11471/api/companion/identity": identity(OTHER),
    "http://10.0.0.8:11471/api/companion/identity": identity(ID),
  });
  const found = await refindCompanion({
    saved,
    fetchImpl,
    hosts: async () => ["10.0.0.2", "10.0.0.5", "10.0.0.8", "10.0.0.9"],
  });
  assert.equal(found?.host, "10.0.0.8");
});

test("the saved host is used as-is when it still answers as the same computer", async () => {
  const saved = { instanceId: ID, host: "10.0.0.2", name: "Desk", token: "t", serverUrl: "" };
  let swept = false;
  const found = await refindCompanion({
    saved,
    fetchImpl: lan({ "http://10.0.0.2:11471/api/companion/identity": identity(ID) }),
    hosts: async () => {
      swept = true;
      return [];
    },
  });
  assert.equal(found?.host, "10.0.0.2");
  assert.equal(swept, false);
});

test("no match anywhere leaves the companion unfound", async () => {
  const saved = { instanceId: ID, host: "10.0.0.2", name: "Desk", token: "t", serverUrl: "" };
  const found = await refindCompanion({
    saved,
    fetchImpl: lan({}),
    hosts: async () => ["10.0.0.3", "10.0.0.4"],
  });
  assert.equal(found, null);
});
