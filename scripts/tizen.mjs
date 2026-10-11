#!/usr/bin/env node
// Tizen device pipeline. Usage: node scripts/tizen.mjs <command...>
// Commands run in the order given; see src-tizen/docs/pipeline.md.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readApplicationId, renderManifest } from "./tizen-manifest.mjs";
import { seed } from "./tizen-seed.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIZEN_DIR = join(ROOT, "src-tizen");
const DIST_DIR = join(TIZEN_DIR, "dist");

// .env.tizen holds the signing profile and the TV address. Values already in the
// environment win, and none of them is ever printed.
function loadEnv() {
  const path = join(ROOT, ".env.tizen");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function run(cmd, args) {
  console.log(`\n> ${cmd} ${args.join(" ")}`);
  // shell: Windows resolves pnpm, tz and sdb through their .cmd/.bat shims.
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, shell: true });
  if (res.status !== 0)
    throw new Error(`${cmd} ${args[0] ?? ""} failed with exit code ${res.status}`);
}

function capture(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function serial() {
  if (process.env.HARBOR_TIZEN_SERIAL) return process.env.HARBOR_TIZEN_SERIAL;
  const devices = capture("sdb", ["devices"])
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols[1] === "device");
  if (devices.length === 1) return devices[0][0];
  throw new Error(
    devices.length === 0
      ? "no Tizen device connected (sdb connect <tv-ip>, or start an emulator)"
      : `${devices.length} devices connected; set HARBOR_TIZEN_SERIAL to one of: ${devices.map((d) => d[0]).join(", ")}`,
  );
}

function manifestXml() {
  const path = join(DIST_DIR, "config.xml");
  if (!existsSync(path)) throw new Error("src-tizen/dist/config.xml is missing; run package first");
  return readFileSync(path, "utf8");
}

function packageId() {
  return readApplicationId(manifestXml()).split(".")[0];
}

function wgtPath() {
  const out = join(DIST_DIR, "Debug");
  const found = existsSync(out) ? readdirSync(out).filter((f) => f.endsWith(".wgt")) : [];
  if (found.length !== 1) throw new Error("no .wgt in src-tizen/dist/Debug; run package first");
  return join(out, found[0]);
}

function build() {
  run("pnpm", ["exec", "vite", "build", "--config", "src-tizen/vite.config.ts"]);
  run("node", ["scripts/check-tizen-budget.mjs"]);
}

// Writes config.xml and the icon next to the build output. Enough for the Web
// Simulator, which loads the unpacked folder.
function stage() {
  if (!existsSync(join(DIST_DIR, "index-tv.html"))) {
    throw new Error("src-tizen/dist has no build; run build first");
  }
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const template = readFileSync(join(TIZEN_DIR, "config.xml.tpl"), "utf8");
  const xml = renderManifest(template, { packageId: process.env.HARBOR_TIZEN_PACKAGE_ID, version });
  writeFileSync(join(DIST_DIR, "config.xml"), xml);
  copyFileSync(join(TIZEN_DIR, "icon.png"), join(DIST_DIR, "icon.png"));
}

function pack() {
  stage();
  // tz treats the folder as a project and writes these into it. Stale copies would
  // end up inside the next .wgt.
  for (const leftover of ["Debug", "tizen_web_project.yaml", ".tizen-rds"]) {
    rmSync(join(DIST_DIR, leftover), { recursive: true, force: true });
  }
  // Empty profile: tz signs with the active profile from Certificate Manager.
  if (process.env.HARBOR_TIZEN_PROFILE) {
    run("tz", ["set", "-w", DIST_DIR, "-s", process.env.HARBOR_TIZEN_PROFILE]);
  }
  run("tz", ["pack", "-w", DIST_DIR]);
  console.log(`\npackaged ${wgtPath()}`);
}

function install() {
  run("tz", ["install", "-e", serial(), "-p", wgtPath()]);
}

function launch() {
  run("tz", ["run", "-e", serial(), "-p", packageId()]);
}

// `tz run -r` only accepts a project whose page is index.html, so start the
// Samsung TV Web Simulator directly. It copies the folder next to --file into
// its own app directory, keyed by the package id in config.xml.
function simulator() {
  stage();
  const exe =
    process.env.HARBOR_TIZEN_SIMULATOR ||
    join(
      homedir(),
      ".tizen-extension-platform/server/sdktools/data/tools/sec-tv-simulator/simulator.exe",
    );
  if (!existsSync(exe))
    throw new Error(`Web Simulator not found at ${exe}; set HARBOR_TIZEN_SIMULATOR`);
  const port = process.env.HARBOR_CDP_PORT || "9333";
  const args = [
    `--file=${join(DIST_DIR, "index-tv.html")}`,
    `--remote-debugging-port=${port}`,
    "--disableInspector",
  ];
  spawn(exe, args, { detached: true, stdio: "ignore" }).unref();
  console.log(
    `\nWeb Simulator started. CDP: http://127.0.0.1:${port}/json/list (the app is a child frame)`,
  );
}

function debug() {
  const target = serial();
  const appId = readApplicationId(manifestXml());
  // A running instance keeps its old inspector port, so start fresh.
  spawnSync("sdb", ["-s", target, "shell", "0", "was_kill", packageId()], {
    shell: true,
    stdio: "ignore",
  });
  const out = capture("sdb", ["-s", target, "shell", "0", "debug", appId]);
  const port = /port:\s*(\d+)/i.exec(out)?.[1];
  if (!port) throw new Error(`no inspector port in debug output:\n${out.trim()}`);
  run("sdb", ["-s", target, "forward", `tcp:${port}`, `tcp:${port}`]);
  console.log(`\nCDP: http://127.0.0.1:${port}/json/list  (HARBOR_CDP_PORT=${port})`);
  return port;
}

function logs() {
  run("sdb", ["-s", serial(), "dlog", "-v", "time", "ConsoleMessage:V", "*:S"]);
}

const commands = {
  build,
  package: pack,
  install,
  launch,
  simulator,
  debug,
  logs,
  // Reuses a forwarded inspector when HARBOR_CDP_PORT is set; otherwise restarts in debug mode.
  seed: () => seed(process.env.HARBOR_CDP_PORT || debug(), process.env),
  deploy() {
    build();
    pack();
    install();
    launch();
  },
};

const requested = process.argv.slice(2);
const unknown = requested.filter((c) => !commands[c]);
if (requested.length === 0 || unknown.length) {
  console.error(`usage: node scripts/tizen.mjs <${Object.keys(commands).join("|")}>...`);
  process.exit(1);
}

loadEnv();
try {
  for (const command of requested) await commands[command]();
} catch (err) {
  console.error(`\ntizen: ${err.message}`);
  process.exit(1);
}
