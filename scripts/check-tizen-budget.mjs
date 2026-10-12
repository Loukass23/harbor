#!/usr/bin/env node
// Fails when the Tizen build outgrows src-tizen/budget.json. Run after
// `pnpm build:tizen`, which writes the stats this reads. The heap budget needs
// the TV and is checked by hand: see src-tizen/docs/performance.md.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGING } from "./tizen-wgt.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "src-tizen", "dist");
const STATS = join(ROOT, "src-tizen", ".stats", "bundle.json");
const BUDGET = join(ROOT, "src-tizen", "budget.json");

// Packaging also writes the manifest and icon into dist; neither is the app.
const NOT_APP = new Set([...PACKAGING, "config.xml", "icon.png"]);

function dirBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (dir === DIST && NOT_APP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? dirBytes(path) : statSync(path).size;
  }
  return total;
}

if (!existsSync(STATS) || !existsSync(DIST)) {
  console.error("no Tizen build to check; run `pnpm build:tizen` first");
  process.exit(1);
}

const budget = JSON.parse(readFileSync(BUDGET, "utf8"));
const { files } = JSON.parse(readFileSync(STATS, "utf8"));
const js = files.filter((f) => f.file.endsWith(".js"));
const entry = js.find((f) => f.entry);
const lazy = js.filter((f) => !f.entry).sort((a, b) => b.bytes - a.bytes)[0];
const css = files.filter((f) => f.file.endsWith(".css"));

const KB = 1024;
const MB = 1024 * 1024;
const checks = [
  ["dist (app files)", dirBytes(DIST) / MB, budget.distMB, "MB"],
  ["entry chunk", (entry?.bytes ?? 0) / KB, budget.entryKB, "KB"],
  ["entry chunk, gzip", (entry?.gzip ?? 0) / KB, budget.entryGzipKB, "KB"],
  [
    `largest lazy chunk (${lazy?.file ?? "none"})`,
    (lazy?.bytes ?? 0) / KB,
    budget.largestLazyChunkKB,
    "KB",
  ],
  ["all JavaScript", js.reduce((s, f) => s + f.bytes, 0) / KB, budget.jsTotalKB, "KB"],
  ["CSS", css.reduce((s, f) => s + f.bytes, 0) / KB, budget.cssKB, "KB"],
];

let failed = false;
for (const [label, actual, limit, unit] of checks) {
  const over = actual > limit;
  failed ||= over;
  const mark = over ? "OVER" : "ok  ";
  console.log(`${mark} ${label.padEnd(48)} ${actual.toFixed(0).padStart(6)} / ${limit} ${unit}`);
}
if (failed) {
  console.error(
    "\nTizen budget exceeded. Split or exclude the growth (src-tizen/.stats/bundle.json lists the" +
      " biggest modules per chunk), or raise src-tizen/budget.json with the reason in the commit.",
  );
  process.exit(1);
}
