import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// libmpv-2.dll from shinchiro's mpv-dev build, the same release as the mpv.exe in
// fetch-mpv.mjs. src-tauri/libmpv/mpv.lib imports by name, so a newer libmpv-2.dll
// links without regenerating it. The archive is pinned, not the DLL inside it.
const RELEASE = "20261010";
const ASSET = "mpv-dev-x86_64-20261010-git-b2c255c13e.7z";
const SHA256 = "394490ed6354c2294b87c63dfa3663b23524b5551aace9cbe35c4085682b14fa";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "src-tauri", "libmpv", "libmpv-2.dll");

if (process.platform !== "win32" && !process.env.HARBOR_LIBMPV_FORCE) {
  console.log("[libmpv] not Windows, skipping (linux links system libmpv)");
  process.exit(0);
}

if (existsSync(dest) && statSync(dest).size > 0) {
  console.log(`[libmpv] ${dest} already present`);
  process.exit(0);
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(path, name);
      if (found) return found;
    } else if (entry.name === name) {
      return path;
    }
  }
  return null;
}

const url = `https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/${RELEASE}/${ASSET}`;
const temp = mkdtempSync(join(tmpdir(), "harbor-libmpv-"));

try {
  console.log(`[libmpv] fetching ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`[libmpv] download failed (${response.status} ${response.statusText})`);

  const archive = join(temp, ASSET);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== SHA256) throw new Error(`[libmpv] checksum mismatch (expected ${SHA256}, got ${digest})`);
  writeFileSync(archive, bytes);

  const extracted = join(temp, "extracted");
  mkdirSync(extracted);
  try {
    execFileSync("7z", ["x", "-y", archive, `-o${extracted}`], { stdio: "inherit" });
  } catch {
    throw new Error("[libmpv] extraction failed; install 7-Zip and ensure `7z` is on PATH");
  }

  const dll = findFile(extracted, "libmpv-2.dll");
  if (!dll) throw new Error("[libmpv] libmpv-2.dll was not found in the archive");
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(dll, dest);
  console.log(`[libmpv] wrote ${dest} (${(statSync(dest).size / 1048576).toFixed(1)} MB)`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
