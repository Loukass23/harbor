#!/usr/bin/env node
import { execSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

// Auto-detect connected device target
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

// Auto-detect forwarded debugging port
function detectDebugPort() {
  const override = getArg("--port", process.env.HARBOR_CDP_PORT);
  if (override) return override;

  try {
    const out = execSync("sdb forward --list", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = out.match(/LOCAL\s+tcp:(\d+)/i) || out.match(/tcp:(\d+)/);
    if (match) return match[1];
  } catch {
    // SDB not available
  }
  return "40405";
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

  const args = ["run", "-t", target, "-p", pkgId];
  if (debug) args.push("-d");
  runCommand("tz", args);
}

// 5. Diagnostics step
function stepDiag() {
  const port = detectDebugPort();
  console.log(`\n--- Running Diagnostics against Tizen TV on port :${port} ---`);
  const diagArgs = process.argv.slice(process.argv.indexOf("--diag") + 1);
  if (diagArgs.length === 0) diagArgs.push("counts");

  const env = { ...process.env, HARBOR_CDP_PORT: port };
  runCommand("node", ["scripts/harbor-diag.mjs", ...diagArgs], { env });
}

// 6. Live Seeding step via CDP
function stepLiveSeed() {
  const backupPath = findBackupFile();
  if (!backupPath) {
    throw new Error("No backup file found in harbor-backups/ or specified with --backup");
  }
  const raw = JSON.parse(readFileSync(backupPath, "utf8"));
  if (!raw || !raw.data) {
    throw new Error("Invalid backup format: missing 'data' field");
  }

  const port = detectDebugPort();
  console.log(`\n--- Live Seeding Backup (${basename(backupPath)}) via CDP on port :${port} ---`);
  const expr = `(() => {
    const data = ${JSON.stringify(raw.data)};
    let count = 0;
    for (const [k, v] of Object.entries(data)) {
      try { localStorage.setItem(k, v); count++; } catch (e) {}
    }
    location.reload();
    return { count, keys: Object.keys(data).length };
  })()`;
  const env = { ...process.env, HARBOR_CDP_PORT: port };
  runCommand("node", ["scripts/harbor-diag.mjs", "eval", expr], { env });
  console.log(
    `✓ Successfully seeded ${Object.keys(raw.data).length} keys into TV localStorage and reloaded.`,
  );
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
    stepLiveSeed();
    return;
  }

  if (isDiag) {
    stepDiag();
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
