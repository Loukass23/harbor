// Development seeding for a TV install: `node scripts/tizen.mjs seed`.
// Signs in to Stremio from this PC and writes the session and API keys from
// .env.tizen into the app's storage over CDP. Only the Stremio session goes to
// the TV, never the password, and no value is ever printed.

const STREMIO_LOGIN = "https://api.strem.io/api/login";
const BOOT_TIMEOUT_MS = 60_000;

/** What .env.tizen asks for. Pure, so it can be tested without a TV. */
export function seedPlan(env) {
  const settings = {};
  if (env.TMDB_API_KEY) settings.tmdbKey = env.TMDB_API_KEY;
  if (env.TORBOX_API_KEY) settings.tbKey = env.TORBOX_API_KEY;
  const stremio =
    env.STREMIO_EMAIL && env.STREMIO_PASSWORD
      ? { email: env.STREMIO_EMAIL, password: env.STREMIO_PASSWORD }
      : null;
  return { stremio, settings };
}

/**
 * Runs inside the TV page, serialised with toString(), so it uses nothing from
 * this module. Mirrors src/lib/auth.tsx (session per Stremio source profile)
 * and src/lib/settings/profile-store.ts (shared or per-profile settings, plus
 * the legacy mirror).
 */
export function pageSeed(seed) {
  let state = null;
  try {
    state = JSON.parse(localStorage.getItem("harbor.profiles.v1") || "null");
  } catch {
    state = null;
  }
  const profiles = Array.isArray(state && state.profiles) ? state.profiles : [];
  const active = profiles.find((p) => p.id === (state && state.activeId)) || null;
  if (!active) {
    return { error: "no active profile yet: skip or finish onboarding on the TV, then seed again" };
  }
  const done = [];
  if (seed.session) {
    const shared = active.shareStremioWith;
    const owner = shared && profiles.some((p) => p.id === shared) ? shared : active.id;
    localStorage.setItem(`harbor.auth.${owner}`, JSON.stringify(seed.session));
    done.push("stremio session");
  }
  const fields = Object.keys(seed.settings);
  if (fields.length > 0) {
    const source =
      active.settingsLinked !== false ? "harbor.settings.shared" : `harbor.settings.${active.id}`;
    for (const key of [source, "harbor.settings"]) {
      let current = {};
      try {
        current = JSON.parse(localStorage.getItem(key) || "{}") || {};
      } catch {
        current = {};
      }
      localStorage.setItem(key, JSON.stringify({ ...current, ...seed.settings }));
    }
    done.push(...fields);
  }
  if (seed.reload) setTimeout(() => location.reload(), 100);
  return { done };
}

async function stremioSession({ email, password }) {
  const res = await fetch(STREMIO_LOGIN, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "Login", email, password, facebook: false }),
  });
  let json = {};
  try {
    json = await res.json();
  } catch {
    json = {};
  }
  const result = json.result;
  if (json.error || !result || !result.authKey) {
    throw new Error(`Stremio sign-in failed: ${(json.error && json.error.message) || res.status}`);
  }
  return { authKey: result.authKey, user: result.user };
}

async function evaluate(port, expression) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((p) => p.type === "page");
  if (!page) throw new Error(`no page on CDP port ${port}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP connection failed")), { once: true });
  });
  try {
    const reply = await new Promise((resolve) => {
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id === 1) resolve(msg);
      });
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    });
    if (reply.exceptionDetails) {
      const text = reply.exceptionDetails.exception?.description ?? "page error";
      throw new Error(text.split("\n")[0]);
    }
    return reply.result?.result?.value;
  } finally {
    ws.close();
  }
}

async function waitForBoot(port) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // Booted means #boot is gone or leaving (lessons.md), not that #root has children.
    const booted = await evaluate(
      port,
      "(() => { const b = document.getElementById('boot'); return !b || b.hasAttribute('data-leaving'); })()",
    ).catch(() => false);
    if (booted) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("the app did not finish booting within 60s");
}

export async function seed(port, env) {
  const plan = seedPlan(env);
  const wanted = [...(plan.stremio ? ["stremio session"] : []), ...Object.keys(plan.settings)];
  if (wanted.length === 0) {
    throw new Error(
      "nothing to seed: set STREMIO_EMAIL and STREMIO_PASSWORD, TORBOX_API_KEY or TMDB_API_KEY in .env.tizen",
    );
  }
  const session = plan.stremio ? await stremioSession(plan.stremio) : null;
  await waitForBoot(port);
  const payload = JSON.stringify({ session, settings: plan.settings, reload: true });
  const result = await evaluate(port, `(${pageSeed.toString()})(${payload})`);
  if (!result || result.error) throw new Error(result?.error ?? "seed returned nothing");
  console.log(`\nseeded: ${result.done.join(", ")} (the app reloads to pick them up)`);
}
