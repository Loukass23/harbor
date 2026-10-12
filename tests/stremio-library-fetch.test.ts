import assert from "node:assert/strict";
import { test } from "node:test";

type Call = { url: string; body: Record<string, unknown> };

// The web fetch path reads window.location; a packaged TV app loads from file://.
(globalThis as { window?: unknown }).window ??= {
  location: { hostname: "", protocol: "file:", origin: "null", href: "file:///index-tv.html" },
};

function stubFetch(result: unknown): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ result }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

test("library pulls the whole collection in one datastoreGet", async () => {
  const items = [
    { _id: "tt1", name: "One" },
    { _id: "tt2", name: "Two", removed: true },
  ];
  const calls = stubFetch(items);
  const { library } = await import("../src/lib/stremio.ts");

  const got = await library("key-1");

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/datastoreGet$/);
  assert.deepEqual(calls[0].body, {
    authKey: "key-1",
    collection: "libraryItem",
    ids: [],
    all: true,
  });
  assert.deepEqual(got, items);
});

test("library returns an empty list when the API has no result", async () => {
  stubFetch(null);
  const { library } = await import("../src/lib/stremio.ts");
  assert.deepEqual(await library("key-2"), []);
});
