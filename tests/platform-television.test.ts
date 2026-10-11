// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { isTelevision, markTelevision } from "../src/lib/platform.ts";

test("a target that marks itself a television stays one", () => {
  assert.equal(isTelevision(), false);
  markTelevision();
  assert.equal(isTelevision(), true);
});
