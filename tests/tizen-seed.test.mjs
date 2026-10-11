import assert from "node:assert/strict";
import test from "node:test";
import { runInThisContext } from "node:vm";
import { pageSeed, seedPlan } from "../scripts/tizen-seed.mjs";

function fakeStorage(initial) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

function withStorage(initial, run) {
  const storage = fakeStorage(initial);
  globalThis.localStorage = storage;
  try {
    return run(storage);
  } finally {
    delete globalThis.localStorage;
  }
}

const profiles = (list, activeId) => JSON.stringify({ profiles: list, activeId });

test("seedPlan only takes what .env.tizen sets", () => {
  assert.deepEqual(seedPlan({}), { stremio: null, settings: {} });
  assert.deepEqual(seedPlan({ STREMIO_EMAIL: "a@b.c" }).stremio, null);
  const plan = seedPlan({
    STREMIO_EMAIL: "a@b.c",
    STREMIO_PASSWORD: "pw",
    TORBOX_API_KEY: "tb",
    TMDB_API_KEY: "tm",
    HARBOR_USERNAME: "ignored",
  });
  assert.deepEqual(plan.stremio, { email: "a@b.c", password: "pw" });
  assert.deepEqual(plan.settings, { tmdbKey: "tm", tbKey: "tb" });
});

test("pageSeed refuses before onboarding has made a profile", () => {
  withStorage({}, () => {
    const out = pageSeed({ session: { authKey: "k" }, settings: {} });
    assert.match(out.error, /no active profile/);
  });
});

test("pageSeed writes the session to the active profile and keys to shared settings", () => {
  withStorage(
    {
      "harbor.profiles.v1": profiles([{ id: "p1" }], "p1"),
      "harbor.settings.shared": JSON.stringify({ tmdbKey: "", uiLanguage: "en" }),
    },
    (storage) => {
      const out = pageSeed({
        session: { authKey: "k", user: { _id: "u" } },
        settings: { tbKey: "tb" },
      });
      assert.deepEqual(out.done, ["stremio session", "tbKey"]);
      assert.deepEqual(JSON.parse(storage.getItem("harbor.auth.p1")), {
        authKey: "k",
        user: { _id: "u" },
      });
      assert.deepEqual(JSON.parse(storage.getItem("harbor.settings.shared")), {
        tmdbKey: "",
        uiLanguage: "en",
        tbKey: "tb",
      });
      assert.equal(JSON.parse(storage.getItem("harbor.settings")).tbKey, "tb");
    },
  );
});

test("pageSeed follows a shared Stremio account and unlinked settings", () => {
  withStorage(
    {
      "harbor.profiles.v1": profiles(
        [{ id: "owner" }, { id: "kid", shareStremioWith: "owner", settingsLinked: false }],
        "kid",
      ),
    },
    (storage) => {
      pageSeed({ session: { authKey: "k" }, settings: { tmdbKey: "tm" } });
      assert.ok(storage.getItem("harbor.auth.owner"));
      assert.equal(storage.getItem("harbor.auth.kid"), null);
      assert.equal(JSON.parse(storage.getItem("harbor.settings.kid")).tmdbKey, "tm");
    },
  );
});

test("pageSeed still works after the round trip through toString()", () => {
  withStorage({ "harbor.profiles.v1": profiles([{ id: "p1" }], "p1") }, (storage) => {
    const payload = JSON.stringify({ session: null, settings: { tmdbKey: "tm" } });
    const out = runInThisContext(`(${pageSeed.toString()})(${payload})`);
    assert.deepEqual(out.done, ["tmdbKey"]);
    assert.equal(JSON.parse(storage.getItem("harbor.settings.shared")).tmdbKey, "tm");
  });
});
