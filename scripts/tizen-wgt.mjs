// Collects the files of an unsigned .wgt. A .wgt is a zip of the widget folder;
// signing (tz pack) adds the signature files, so CI can build everything else.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// tz treats the build folder as a project and writes these into it. None of it is the app.
export const PACKAGING = new Set(["Debug", "tizen_web_project.yaml", ".tizen-rds"]);

export function wgtEntries(dir) {
  const entries = {};
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!rel && PACKAGING.has(entry.name)) continue;
      const path = join(abs, entry.name);
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path, name);
      else entries[name] = new Uint8Array(readFileSync(path));
    }
  };
  walk(dir, "");
  return entries;
}
