import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";

// PostToolUse hook: after an Edit/Write under src/, run the Tizen boundary check on that
// file. Exit code 2 sends the violation back to Claude so it moves the code behind a seam.

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let file;
try {
  file = JSON.parse(raw.replace(/^﻿/, ""))?.tool_input?.file_path;
} catch {
  process.exit(0);
}
if (!file) process.exit(0);

const rel = relative(root, resolve(root, file)).replace(/\\/g, "/");
if (!rel.startsWith("src/")) process.exit(0);

const result = spawnSync(
  process.execPath,
  ["scripts/check-tizen-boundary.mjs", resolve(root, file)],
  {
    cwd: root,
    encoding: "utf8",
  },
);
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(2);
}
