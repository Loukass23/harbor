import assert from "node:assert/strict";
import { test } from "node:test";
import { bpSnapshotRows } from "../src/views/big-picture/bp-home-cache.ts";
import type { HomeRow } from "../src/views/home/home-types.ts";

const meta = (i: number) => ({ id: `tt${i}`, type: "movie" as const, name: `Title ${i}` });

test("snapshot rows can be cloned into IndexedDB even when a row has a fetcher", () => {
  const rows: HomeRow[] = [
    {
      key: "tmdb-trending-movies",
      type: "movie",
      name: "Trending This Week",
      metas: Array.from({ length: 40 }, (_, i) => meta(i)),
      page: 1,
      hasMore: true,
      fetcher: async () => [],
    },
  ];
  // structuredClone throws DataCloneError on a function, exactly as IDBObjectStore.put does.
  assert.throws(() => structuredClone(rows), { name: "DataCloneError" });

  const stored = bpSnapshotRows(rows);
  assert.doesNotThrow(() => structuredClone(stored));
  assert.equal("fetcher" in stored[0], false);
  assert.equal(stored[0].metas.length, 30);
  assert.equal(stored[0].key, "tmdb-trending-movies");
});

test("snapshot drops episode lists from catalog metas", () => {
  const episodes = Array.from({ length: 500 }, (_, i) => ({ id: `tt1:1:${i}`, title: `Ep ${i}` }));
  const rows = [
    {
      key: "addon-series",
      type: "series",
      name: "Series",
      metas: [{ ...meta(1), type: "series", videos: episodes }],
      page: 1,
      hasMore: false,
    },
  ] as unknown as HomeRow[];
  const [row] = bpSnapshotRows(rows);
  assert.equal("videos" in row.metas[0], false);
  assert.equal(row.metas[0].name, "Title 1");
});

test("snapshot keeps at most 24 rows", () => {
  const rows: HomeRow[] = Array.from({ length: 30 }, (_, i) => ({
    key: `row-${i}`,
    type: "movie" as const,
    name: `Row ${i}`,
    metas: [meta(i)],
    page: 1,
    hasMore: false,
  }));
  assert.equal(bpSnapshotRows(rows).length, 24);
});
