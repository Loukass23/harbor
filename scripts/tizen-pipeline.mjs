#!/usr/bin/env node
import { execSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const TIZEN_DIR = join(ROOT, "src-tizen");
const DIST_DIR = join(TIZEN_DIR, "dist");

// Optional .env loading
function loadEnv() {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  try {
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed
          .slice(eq + 1)
          .trim()
          .replace(/^["']|["']$/g, "");
        if (!process.env[key]) process.env[key] = val;
      }
    }
  } catch {
    // Ignore .env read errors
  }
}
loadEnv();

function getArg(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return fallback;
}

function hasFlag(...flags) {
  return flags.some((f) => process.argv.includes(f));
}

// Find latest backup file in harbor-backups/ or from --backup
function findBackupFile() {
  const custom = getArg("--backup", process.env.HARBOR_TIZEN_BACKUP);
  if (custom && existsSync(custom)) return resolve(ROOT, custom);

  const backupDir = join(ROOT, "harbor-backups");
  if (existsSync(backupDir)) {
    const files = readdirSync(backupDir)
      .filter((f) => f.endsWith(".harbx") || f.endsWith(".json"))
      .sort()
      .reverse();
    if (files.length > 0) return join(backupDir, files[0]);
  }
  return null;
}

// Read application ID and package ID from config.xml
function getManifestInfo() {
  const configPath = join(TIZEN_DIR, "config.xml");
  if (!existsSync(configPath)) {
    return { appId: "kmDHFrYo6a.Harbor", pkgId: "kmDHFrYo6a" };
  }
  const xml = readFileSync(configPath, "utf8");
  const idMatch = xml.match(/<tizen:application[^>]*\sid="([^"]+)"/);
  const pkgMatch = xml.match(/<tizen:application[^>]*\spackage="([^"]+)"/);
  return {
    appId: idMatch ? idMatch[1] : "kmDHFrYo6a.Harbor",
    pkgId: pkgMatch ? pkgMatch[1] : "kmDHFrYo6a",
  };
}

// Auto-detect connected device target (name for tz, serial for sdb)
function detectTarget() {
  const override = getArg("--target", process.env.HARBOR_TIZEN_TARGET);
  if (override) return override;

  try {
    const out = execSync("sdb devices", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const lines = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("List of"));
    if (lines.length > 0) {
      const parts = lines[0].split(/\s+/);
      const target = parts[2] || parts[0];
      if (target) return target;
    }
  } catch {
    // SDB not available or no devices
  }
  return "GU43DU7199UXZG";
}

function ensureSdbConnected() {
  const serial = getArg("--serial", process.env.HARBOR_TIZEN_SERIAL || "192.168.178.26:26101");
  try {
    const out = execSync("sdb devices", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (!out.includes(serial) && serial.includes(":")) {
      execSync(`sdb connect ${serial}`, { stdio: "ignore" });
    }
  } catch {}
}

function detectSerial() {
  const override = getArg("--serial", process.env.HARBOR_TIZEN_SERIAL);
  if (override) return override;

  ensureSdbConnected();
  try {
    const out = execSync("sdb devices", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const lines = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("List of"));
    if (lines.length > 0) {
      const parts = lines[0].split(/\s+/);
      return parts[0] || "192.168.178.26:26101";
    }
  } catch {
    // SDB not available
  }
  return "192.168.178.26:26101";
}

// Probe an HTTP URL with a short timeout
function probePort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/list`, { timeout: 400 }, (res) => {
      if (res.statusCode === 200) {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Auto-detect forwarded debugging port
async function detectDebugPort() {
  const override = getArg("--port", process.env.HARBOR_CDP_PORT);
  if (override) return override;

  try {
    const out = execSync("sdb forward --list", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const matches = [...out.matchAll(/LOCAL\s+tcp:(\d+)/gi)].map((m) => m[1]);
    if (matches.length === 0) {
      const fallbackMatches = [...out.matchAll(/tcp:(\d+)/g)].map((m) => m[1]);
      matches.push(...fallbackMatches);
    }
    const uniquePorts = [...new Set(matches)];
    for (const port of uniquePorts) {
      if (await probePort(port)) {
        return port;
      }
    }
    if (uniquePorts.length > 0) return uniquePorts[0];
  } catch {
    // SDB not available
  }
  return "34181";
}

function getSigningProfile() {
  return getArg("--profile", process.env.HARBOR_TIZEN_PROFILE || "SwormHarbor");
}

function runCommand(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: opts.cwd || ROOT,
    shell: true,
    ...opts,
  });
  if (res.status !== 0) {
    throw new Error(`Command failed with exit code ${res.status}: ${cmd} ${args.join(" ")}`);
  }
  return res;
}

// 1. Build step
function stepBuild() {
  console.log("\n--- [1/3] Building Web Assets with Vite ---");
  // Type check and compile
  runCommand("pnpm", ["exec", "tsc", "-b"]);
  runCommand("pnpm", ["exec", "vite", "build", "--mode", "tizen"]);
}

// 2. Stage metadata and package step
function stepPackage() {
  console.log("\n--- [2/3] Staging & Packaging Tizen Widget ---");
  if (!existsSync(DIST_DIR)) {
    throw new Error(`Build output directory does not exist: ${DIST_DIR}. Run build first.`);
  }

  // Copy template files into dist for packaging
  const filesToCopy = ["config.xml", "icon.png", ".project", ".tproject"];
  for (const file of filesToCopy) {
    const src = join(TIZEN_DIR, file);
    const dest = join(DIST_DIR, file);
    if (existsSync(src)) {
      copyFileSync(src, dest);
      console.log(`Staged ${file} -> dist/${file}`);
    }
  }

  // Optional: Stage dev seed script if requested via --seed
  const shouldSeed = hasFlag("--seed") || Boolean(process.env.HARBOR_TIZEN_SEED);
  if (shouldSeed) {
    const backupPath = findBackupFile();
    if (backupPath) {
      try {
        const raw = JSON.parse(readFileSync(backupPath, "utf8"));
        if (raw && raw.data) {
          const marker = raw.exportedAt || "seed-v1";
          const seedScript = `// Auto-generated dev seed by tizen-pipeline.mjs
(function () {
  try {
    var v = ${JSON.stringify(marker)};
    if (localStorage.getItem("harbor.tizen.dev_seed") === v) return;
    var data = ${JSON.stringify(raw.data)};
    var count = 0;
    for (var k in data) {
      if (typeof data[k] === "string") {
        try { localStorage.setItem(k, data[k]); count++; } catch (e) {}
      }
    }
    localStorage.setItem("harbor.tizen.dev_seed", v);
    console.info("[tizen-seed] Preloaded " + count + " keys from dev backup");
  } catch (err) {
    console.warn("[tizen-seed] Preload failed:", err);
  }
})();
`;
          writeFileSync(join(DIST_DIR, "dev-seed.js"), seedScript, "utf8");

          const htmlPath = join(DIST_DIR, "index-tv.html");
          if (existsSync(htmlPath)) {
            let html = readFileSync(htmlPath, "utf8");
            if (!html.includes("dev-seed.js")) {
              html = html.replace("<head>", '<head>\n    <script src="./dev-seed.js"></script>');
              writeFileSync(htmlPath, html, "utf8");
            }
          }
          console.log(
            `Staged dev seed from ${basename(backupPath)} (${Object.keys(raw.data).length} keys) into dist/dev-seed.js`,
          );
        }
      } catch (err) {
        console.warn(`[tizen-seed] Failed to stage dev seed: ${err.message}`);
      }
    } else {
      console.warn("[tizen-seed] Flag --seed provided but no backup file found in harbor-backups/");
    }
  }

  const profile = getSigningProfile();
  console.log(`Using signing profile: ${profile}`);
  runCommand("tz", ["pack", "-w", DIST_DIR, "-t", "wgt", "-s", profile]);
}

// Find generated .wgt file
function findWgt() {
  const searchDirs = [join(DIST_DIR, "Debug"), DIST_DIR, TIZEN_DIR];
  for (const dir of searchDirs) {
    if (existsSync(dir)) {
      const wgts = readdirSync(dir).filter((f) => f.endsWith(".wgt"));
      if (wgts.length > 0) {
        return join(dir, wgts[0]);
      }
    }
  }
  throw new Error("No .wgt package found. Did packaging succeed?");
}

// 3. Install step
function stepInstall() {
  console.log("\n--- [3/3] Installing Widget on Target Device ---");
  const target = detectTarget();
  const wgtPath = findWgt();
  console.log(`Target device: ${target}`);
  console.log(`Package: ${wgtPath}`);
  runCommand("tz", ["install", "-t", target, "-p", wgtPath]);
}

// 4. Run step
function stepRun(debug = false) {
  const { appId, pkgId } = getManifestInfo();
  const target = detectTarget();
  console.log(`\n--- Launching App on ${target} (${debug ? "Debug" : "Normal"} Mode) ---`);
  console.log(`Application ID: ${appId} (Package: ${pkgId})`);

  if (debug) {
    const serial = detectSerial();
    // Terminate existing instance first so a fresh debug port is reliably bound
    try {
      execSync(`sdb -s ${serial} shell 0 was_kill ${pkgId}.dist`, { stdio: "ignore" });
    } catch {
      // Ignore if not running
    }

    try {
      const out = execSync(`sdb -s ${serial} shell 0 debug ${pkgId}.dist`, { encoding: "utf8" });
      console.log(out.trim());
      const m = out.match(/port:\s*(\d+)/i);
      if (m) {
        const port = m[1];
        console.log(`Forwarding debug port ${port}...`);
        try {
          execSync(`sdb -s ${serial} forward tcp:${port} tcp:${port}`, { stdio: "ignore" });
        } catch {
          // Ignore
        }
        console.log(`\n✓ Web Inspector active on: http://127.0.0.1:${port}/json/list`);
        console.log(`Open in Chrome: http://127.0.0.1:${port}/devtools/inspector.html`);
      }
    } catch {
      // Fallback to tz run if direct sdb debug fails
      runCommand("tz", ["run", "-t", target, "-p", pkgId, "-d"]);
    }
  } else {
    runCommand("tz", ["run", "-t", target, "-p", pkgId]);
  }
}

// 5. Diagnostics step
async function stepDiag() {
  const port = await detectDebugPort();
  console.log(`\n--- Running Diagnostics against Tizen TV on port :${port} ---`);
  const diagArgs = process.argv.slice(process.argv.indexOf("--diag") + 1);
  if (diagArgs.length === 0) diagArgs.push("counts");

  const env = { ...process.env, HARBOR_CDP_PORT: port };
  runCommand("node", ["scripts/harbor-diag.mjs", ...diagArgs], { env });
}

// 6. Live Seeding step via CDP WebSocket (bypasses OS command-line character limits)
async function stepLiveSeed() {
  const backupPath = findBackupFile();
  if (!backupPath) {
    throw new Error("No backup file found in harbor-backups/ or specified with --backup");
  }
  const raw = JSON.parse(readFileSync(backupPath, "utf8"));
  if (!raw || !raw.data) {
    throw new Error("Invalid backup format: missing 'data' field");
  }

  const port = await detectDebugPort();
  process.env.HARBOR_CDP_PORT = port;
  console.log(`\n--- Live Seeding Backup (${basename(backupPath)}) via CDP on port :${port} ---`);

  const { Cdp } = await import("./harbor-diag.mjs");
  const cdp = await Cdp.connect();

  let count = 0;
  const entries = Object.entries(raw.data).filter(([, v]) => typeof v === "string");
  const chunkSize = 25;
  for (let i = 0; i < entries.length; i += chunkSize) {
    const chunk = entries.slice(i, i + chunkSize);
    const chunkObj = Object.fromEntries(chunk);
    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const items = ${JSON.stringify(chunkObj)};
        for (const [k, v] of Object.entries(items)) {
          try { localStorage.setItem(k, v); } catch(e) {}
        }
      })()`,
    });
    count += chunk.length;
  }
  await cdp.send("Runtime.evaluate", { expression: `location.reload()` });
  cdp.close();

  console.log(`✓ Successfully seeded ${count} keys into TV localStorage and reloaded.`);
}

// CLI Orchestration
async function main() {
  const isAll = hasFlag("--all", "--deploy") || process.argv.length <= 2;
  const isBuild = hasFlag("--build") || isAll;
  const isPackage = hasFlag("--package") || isAll;
  const isInstall = hasFlag("--install") || isAll;
  const isRun = hasFlag("--run");
  const isDebug = hasFlag("--debug");
  const isDiag = hasFlag("--diag");
  const isLiveSeed = hasFlag("--live-seed", "--seed-live");

  if (isLiveSeed) {
    await stepLiveSeed();
    return;
  }

  if (isDiag) {
    await stepDiag();
    return;
  }

  if (isBuild) stepBuild();
  if (isPackage) stepPackage();
  if (isInstall) stepInstall();
  if (isDebug) stepRun(true);
  else if (isRun) stepRun(false);

  console.log("\n✓ Tizen pipeline completed successfully.");
}

main().catch((err) => {
  console.error(`\n✖ Pipeline failed: ${err.message}`);
  process.exit(1);
});
