// @ts-expect-error Node test types are outside the browser tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are outside the browser tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are outside the browser tsconfig.
import test from "node:test";
import ts from "typescript";

type Mocks = {
  requestCalls: number;
  requestResult: { coverImage: { extraLarge: string | null } | null } | null;
  disk: Map<string, string>;
};

function loadTitle() {
  const source = readFileSync(new URL("../src/lib/manga/title.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: Record<string, any> = {};
  new Function("require", "exports", js)(() => {
    throw new Error("title.ts should have no runtime dependencies");
  }, exports);
  return exports;
}

const titleModule = loadTitle();

function load(mocks: Mocks) {
  const source = readFileSync(
    new URL("../src/lib/discord/manga-cover.ts", import.meta.url),
    "utf8",
  );
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: Record<string, any> = {};
  new Function("require", "exports", js)(
    (id: string) => {
      if (id === "@/lib/anilist/client") {
        return {
          anilistRequest: async () => {
            mocks.requestCalls += 1;
            return mocks.requestResult ? { m: { media: [mocks.requestResult] } } : null;
          },
        };
      }
      if (id === "@/lib/manga/art-cache") {
        return {
          readArt: (_ns: string, key: string) => mocks.disk.get(key) ?? null,
          writeArt: (ns: string, key: string, url: string) => {
            mocks.disk.set(key, url);
            void ns;
          },
        };
      }
      if (id === "@/lib/manga/title") return titleModule;
      throw new Error(`Unexpected dependency: ${id}`);
    },
    exports,
  );
  return exports;
}

function freshMocks(overrides: Partial<Mocks> = {}): Mocks {
  return {
    requestCalls: 0,
    requestResult: null,
    disk: new Map(),
    ...overrides,
  };
}

test("only public, short HTTPS covers pass through untouched", () => {
  const mod = load(freshMocks());
  const fetchable = mod.discordFetchableCover as (c?: string | null) => string | undefined;
  assert.equal(fetchable(undefined), undefined);
  assert.equal(fetchable(""), undefined);
  assert.equal(fetchable("http://example.com/c.jpg"), undefined);
  assert.equal(fetchable("blob:http://localhost/x"), undefined);
  assert.equal(fetchable("https://localhost/c.jpg"), undefined);
  assert.equal(fetchable("https://asset.localhost/c.jpg"), undefined);
  assert.equal(fetchable("https://192.168.1.10/thumb.jpg"), undefined);
  assert.equal(fetchable("https://10.0.0.5/thumb.jpg"), undefined);
  assert.equal(fetchable("https://172.20.4.4/thumb.jpg"), undefined);
  assert.equal(fetchable("https://example.com/c.jpg"), "https://example.com/c.jpg");
  assert.equal(
    fetchable(`https://example.com/${"a".repeat(300)}.jpg`),
    undefined,
    "over Discord's length limit",
  );
});

test("a fetchable source cover wins without any AniList lookup", () => {
  const mocks = freshMocks();
  const mod = load(mocks);
  const cover = mod.mangaDiscordCover as (c?: string, t?: string) => string | undefined;
  assert.equal(cover("https://cdn.example.com/jojo.jpg", "JoJo"), "https://cdn.example.com/jojo.jpg");
  assert.equal(mocks.requestCalls, 0);
});

test("a local cover falls back to the cached AniList cover", () => {
  const mocks = freshMocks();
  const mod = load(mocks);
  mocks.disk.set("jojo part 7", "https://s4.anilist.co/file/manga/cover/large/1.jpg");
  const cover = mod.mangaDiscordCover as (c?: string, t?: string) => string | undefined;
  assert.equal(
    cover("http://192.168.1.4/api/v1/manga/9/thumbnail", "JoJo Part 7"),
    "https://s4.anilist.co/file/manga/cover/large/1.jpg",
  );
  assert.equal(mocks.requestCalls, 0, "cache hit must not re-query AniList");
});

test("a local cover triggers an AniList lookup that later flushes", async () => {
  const mocks = freshMocks({
    requestResult: { coverImage: { extraLarge: "https://s4.anilist.co/file/manga/cover/large/2.jpg" } },
  });
  const mod = load(mocks);
  const cover = mod.mangaDiscordCover as (c?: string, t?: string) => string | undefined;
  let flushed = 0;
  (mod.onMangaCoverResolved as (cb: () => void) => void)(() => {
    flushed += 1;
  });

  assert.equal(cover("http://10.0.0.9/thumb.jpg", "Some Manga"), undefined);
  assert.equal(mocks.requestCalls, 1);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(flushed, 1, "resolved cover must notify the presence layer");
  assert.equal(cover("http://10.0.0.9/thumb.jpg", "Some Manga"), "https://s4.anilist.co/file/manga/cover/large/2.jpg");
});

test("no title and no cover resolves to nothing", () => {
  const mocks = freshMocks();
  const mod = load(mocks);
  const cover = mod.mangaDiscordCover as (c?: string, t?: string) => string | undefined;
  assert.equal(cover("http://10.0.0.9/thumb.jpg", undefined), undefined);
  assert.equal(cover(undefined, ""), undefined);
  assert.equal(mocks.requestCalls, 0);
});

test("the color tag is dropped from the AniList lookup key", () => {
  const mocks = freshMocks();
  const mod = load(mocks);
  mocks.disk.set("solo leveling", "https://s4.anilist.co/file/manga/cover/large/3.jpg");
  const cover = mod.mangaDiscordCover as (c?: string, t?: string) => string | undefined;
  assert.equal(
    cover("http://192.168.1.4/thumb.jpg", "Solo Leveling (Color)"),
    "https://s4.anilist.co/file/manga/cover/large/3.jpg",
  );
  assert.equal(mocks.requestCalls, 0);
});
