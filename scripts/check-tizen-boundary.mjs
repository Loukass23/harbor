import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

// src/ is shared with upstream Harbor and must stay platform-neutral. Tizen code
// lives in src-tizen/ and plugs into src/ through registration seams, so
// beta-branch merges stay cheap and every seam can be contributed back.
// Pass file paths to check only those (used by the Claude hook); no args scans src/.

const root = resolve("src");
const forbidden = [
  { pattern: /src-tizen/, reason: "imports src-tizen" },
  { pattern: /\bwebapis\b/, reason: "uses Samsung webapis" },
  { pattern: /\btizen\s*\./, reason: "uses the tizen global" },
  { pattern: /\btizenhwkey\b/, reason: "handles tizenhwkey" },
  { pattern: /\bavplay\b/i, reason: "references AVPlay" },
];

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (/\.(ts|tsx|js|mjs|css)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const args = process.argv.slice(2).map((p) => resolve(p));
const files = args.length
  ? args.filter((p) => p.startsWith(root + (process.platform === "win32" ? "\\" : "/")))
  : await walk(root);

const violations = [];
for (const file of files) {
  let source;
  try {
    source = await readFile(file, "utf8");
  } catch {
    continue;
  }
  source.split("\n").forEach((line, i) => {
    for (const { pattern, reason } of forbidden) {
      if (pattern.test(line))
        violations.push(`${relative(process.cwd(), file)}:${i + 1} ${reason}`);
    }
  });
}

if (violations.length) {
  console.error("Tizen boundary violations (move this into src-tizen/ behind a seam):");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`tizen boundary ok (${files.length} files)`);
