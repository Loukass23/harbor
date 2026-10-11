import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { readApplicationId, renderManifest } from "../scripts/tizen-manifest.mjs";

const template = readFileSync(new URL("../src-tizen/config.xml.tpl", import.meta.url), "utf8");

test("renders package id, application id and version", () => {
  const xml = renderManifest(template, { packageId: "AbCdE12345", version: "0.9.132" });
  assert.match(xml, /package="AbCdE12345"/);
  assert.match(xml, /version="0\.9\.132"/);
  assert.equal(readApplicationId(xml), "AbCdE12345.Harbor");
  assert.doesNotMatch(xml, /\{\{/);
});

test("pins the Tizen 9.0 floor", () => {
  assert.match(template, /required_version="9\.0"/);
});

test("declares network.public, which the companion sweep's own address needs", () => {
  assert.match(template, /privilege\/network\.public"/);
});

test("rejects package ids the TV refuses to install", () => {
  for (const packageId of ["AbCdE1234", "AbCdE123456", "AbCdE-1234", "", undefined]) {
    assert.throws(() => renderManifest(template, { packageId, version: "1.0.0" }), /118,-4/);
  }
});

test("rejects versions outside Tizen's limits", () => {
  for (const version of ["1.0", "1.0.0-beta", "256.0.0", "0.256.0", "0.0.65536"]) {
    assert.throws(
      () => renderManifest(template, { packageId: "AbCdE12345", version }),
      /Tizen version/,
    );
  }
});
