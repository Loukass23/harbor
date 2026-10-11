// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  LANGUAGES,
  normalizeLanguage,
  setAllowedUiLanguages,
  uiLanguageOptions,
} from "../src/lib/i18n/languages.ts";

test("a restricted build offers only its languages and maps the rest to English", () => {
  try {
    setAllowedUiLanguages(["fr"]);
    assert.deepEqual(
      uiLanguageOptions().map((l) => l.code),
      ["en", "fr"],
    );
    assert.equal(normalizeLanguage("fr-CA"), "fr");
    assert.equal(normalizeLanguage("de"), "en");
  } finally {
    setAllowedUiLanguages(null);
  }
  assert.equal(uiLanguageOptions(), LANGUAGES);
  assert.equal(normalizeLanguage("de"), "de");
});
