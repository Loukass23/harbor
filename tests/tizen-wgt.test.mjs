import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wgtEntries } from "../scripts/tizen-wgt.mjs";

test("collects the widget files with posix paths and skips tz leftovers", () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-wgt-"));
  try {
    writeFileSync(join(dir, "index-tv.html"), "<html></html>");
    writeFileSync(join(dir, "config.xml"), "<widget/>");
    mkdirSync(join(dir, "assets", "nested"), { recursive: true });
    writeFileSync(join(dir, "assets", "nested", "a.js"), "export {}");
    mkdirSync(join(dir, "Debug"));
    writeFileSync(join(dir, "Debug", "dist.wgt"), "old");
    mkdirSync(join(dir, ".tizen-rds"));
    writeFileSync(join(dir, ".tizen-rds", "state"), "x");
    writeFileSync(join(dir, "tizen_web_project.yaml"), "x");

    const entries = wgtEntries(dir);
    assert.deepEqual(Object.keys(entries).sort(), [
      "assets/nested/a.js",
      "config.xml",
      "index-tv.html",
    ]);
    assert.equal(new TextDecoder().decode(entries["config.xml"]), "<widget/>");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
