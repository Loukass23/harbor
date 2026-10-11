#!/usr/bin/env node
// Inspect Harbor on a Tizen TV over CDP. Start the inspector first with
// `node scripts/tizen.mjs debug`, then pass its port in HARBOR_CDP_PORT.
//
//   console                 stream console messages and exceptions
//   eval <expr>             evaluate in the page (read-only inspection)
//   keys <Key...>           press remote keys: Up Down Left Right Enter Back
//   screenshot <file.png>   save a screenshot (the AVPlay plane shows blank)
//   heap                    JS heap, DOM nodes and decoded image MB, after a GC
//   measure [n]             relaunch n times (default 5); boot and heap stats
//
// `measure` relaunches through `tizen.mjs debug`, which needs .env.tizen and a
// packaged dist. HARBOR_TIZEN_ROOT picks the checkout that has them (default: this one).
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Cdp, COUNTS_EXPR } from "./harbor-diag.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BOOT_TIMEOUT_MS = 60_000;
// Home keeps loading art after the first row shows. Readings taken before it
// settles measure the network, not the app.
const SETTLE_MS = 15_000;
const STEP_MS = 350;

// Tizen remote keyCodes. Back is the TV's own code, not Escape.
const KEYS = {
  Left: { code: 37, key: "ArrowLeft" },
  Up: { code: 38, key: "ArrowUp" },
  Right: { code: 39, key: "ArrowRight" },
  Down: { code: 40, key: "ArrowDown" },
  Enter: { code: 13, key: "Enter" },
  Back: { code: 10009, key: "XF86Back" },
};

// The fixed walk for before/after comparisons: a heap reading only means
// something against another one taken over the same path.
const WALK = [
  "Down",
  "Down",
  "Right",
  "Right",
  "Right",
  "Right",
  "Right",
  "Enter",
  "wait",
  "Back",
  "wait",
  ...Array.from({ length: 25 }, () => ["Right", "Down"]).flat(),
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function port() {
  const p = Number(process.env.HARBOR_CDP_PORT);
  if (!p) throw new Error("set HARBOR_CDP_PORT to the port `node scripts/tizen.mjs debug` printed");
  return p;
}

async function withCdp(p, fn) {
  const cdp = await Cdp.connect(p);
  try {
    return await fn(cdp);
  } finally {
    cdp.close();
  }
}

async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? "page error");
  }
  return r.result.value;
}

async function press(cdp, names) {
  for (const name of names) {
    if (name === "wait") {
      await sleep(3000);
      continue;
    }
    const k = KEYS[name];
    if (!k) throw new Error(`unknown key ${name}; use ${Object.keys(KEYS).join(" ")}`);
    const base = { windowsVirtualKeyCode: k.code, nativeVirtualKeyCode: k.code, key: k.key };
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(STEP_MS);
  }
}

async function heap(cdp) {
  await cdp.send("HeapProfiler.collectGarbage");
  const counts = await evaluate(cdp, COUNTS_EXPR);
  // performance.memory is bucketed outside --enable-precise-memory-info, so
  // two different heaps read the same; the inspector's figure is exact.
  const { usedSize } = await cdp.send("Runtime.getHeapUsage");
  return { ...counts, jsHeapMB: +(usedSize / 1048576).toFixed(1) };
}

const FOCUS_EXPR = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  return {
    tag: el.tagName.toLowerCase(),
    label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 60),
    row: el.closest("[data-bp-row-key]")?.getAttribute("data-bp-row-key") ?? null,
    path: location.hash || location.pathname.slice(-40),
  };
})()`;

const READY_EXPR = `(() => {
  const boot = document.getElementById("boot");
  const booted = !boot || boot.hasAttribute("data-leaving");
  // Focus inside a Home row: onboarding also draws rows behind itself.
  const focused = document.activeElement?.closest("[data-bp-row-key]");
  return booted && !!focused && document.querySelectorAll("[data-bp-row-key]").length >= 2;
})()`;

// Milliseconds from navigation start, so runs compare across relaunches.
const MARKS_EXPR = `(() => Object.fromEntries(
  performance.getEntriesByType("mark")
    .filter((m) => m.name.startsWith("harbor:"))
    .map((m) => [m.name.slice(7), Math.round(m.startTime)])
))()`;

function relaunch() {
  const root = process.env.HARBOR_TIZEN_ROOT ? resolve(process.env.HARBOR_TIZEN_ROOT) : ROOT;
  const res = spawnSync(process.execPath, [join(root, "scripts", "tizen.mjs"), "debug"], {
    cwd: root,
    encoding: "utf8",
  });
  const p = /HARBOR_CDP_PORT=(\d+)/.exec(res.stdout ?? "")?.[1];
  if (res.status !== 0 || !p) {
    throw new Error(`tizen.mjs debug failed:\n${res.stderr || res.stdout}`);
  }
  return Number(p);
}

async function waitReady(p) {
  const start = Date.now();
  while (Date.now() - start < BOOT_TIMEOUT_MS) {
    const ready = await withCdp(p, (cdp) => evaluate(cdp, READY_EXPR)).catch(() => false);
    if (ready) return Date.now() - start;
    await sleep(500);
  }
  throw new Error("Home did not take focus within 60s (onboarding or a dialog may be open)");
}

function stats(values) {
  const v = values.filter((x) => typeof x === "number");
  if (v.length === 0) return "no readings";
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const spread = mean ? ((hi - lo) * 100) / mean : 0;
  const line = `mean=${mean.toFixed(1)} min=${lo} max=${hi} spread=${spread.toFixed(1)}%`;
  return spread > 15 ? `${line}  (spread over 15%: smaller differences are noise)` : line;
}

async function measure(n) {
  const runs = [];
  for (let i = 0; i < n; i++) {
    const p = relaunch();
    const readyMs = await waitReady(p);
    await sleep(SETTLE_MS);
    const run = await withCdp(p, async (cdp) => {
      const marks = await evaluate(cdp, MARKS_EXPR);
      const idle = await heap(cdp);
      await press(cdp, WALK);
      await sleep(3000);
      const walked = await heap(cdp);
      const end = await evaluate(cdp, FOCUS_EXPR);
      return { marks, idle, walked, end };
    });
    run.readyMs = readyMs;
    runs.push(run);
    console.log(
      `run ${i + 1}: render-called=${run.marks["render-called"]}ms home=${readyMs}ms ` +
        `idle heap=${run.idle.jsHeapMB}MB nodes=${run.idle.nodes} | ` +
        `walked heap=${run.walked.jsHeapMB}MB nodes=${run.walked.nodes} img=${run.walked.estImgDecodeMB}MB ` +
        `ended on ${run.end?.row ?? "?"}`,
    );
  }
  console.log(`\n${n} runs`);
  const row = (label, pick) => console.log(`  ${label.padEnd(26)} ${stats(runs.map(pick))}`);
  row("render-called ms", (r) => r.marks["render-called"]);
  row("home ready ms (from attach)", (r) => r.readyMs);
  row("idle JS heap MB", (r) => r.idle.jsHeapMB);
  row("idle DOM nodes", (r) => r.idle.nodes);
  row("walked JS heap MB", (r) => r.walked.jsHeapMB);
  row("walked DOM nodes", (r) => r.walked.nodes);
  row("walked decoded images MB", (r) => r.walked.estImgDecodeMB);
}

async function streamConsole(p) {
  const cdp = await Cdp.connect(p);
  cdp.on("Runtime.consoleAPICalled", ({ type, args }) => {
    console.log(`[${type}]`, args.map((a) => a.value ?? a.description ?? a.type).join(" "));
  });
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    console.log("[exception]", exceptionDetails.exception?.description ?? exceptionDetails.text);
  });
  await cdp.send("Runtime.enable");
  console.log("streaming console; Ctrl+C to stop");
  await new Promise(() => {});
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const print = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
  switch (cmd) {
    case "console":
      return streamConsole(port());
    case "eval":
      return print(await withCdp(port(), (cdp) => evaluate(cdp, args.join(" "))));
    case "keys":
      return withCdp(port(), (cdp) => press(cdp, args));
    case "focus":
      return print(await withCdp(port(), (cdp) => evaluate(cdp, FOCUS_EXPR)));
    case "screenshot": {
      if (!args[0]) throw new Error("usage: screenshot <file.png>");
      const { data } = await withCdp(port(), (cdp) => cdp.send("Page.captureScreenshot"));
      writeFileSync(args[0], Buffer.from(data, "base64"));
      return print(`saved ${args[0]}`);
    }
    case "heap":
      return print(await withCdp(port(), heap));
    case "measure":
      return measure(Number(args[0] ?? 5));
    default:
      return print(
        "usage: tizen-cdp <console|eval <js>|keys <Key...>|screenshot <file>|heap|measure [n]>",
      );
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
