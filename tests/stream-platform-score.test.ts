// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { parseStream } from "../src/lib/streams/parser.ts";
import { scoreStream, setPlatformScoreModifier } from "../src/lib/streams/scoring.ts";

const parsed = (title: string) =>
  parseStream({
    addonId: "fixture",
    addonName: "Fixture",
    title,
    url: "https://fixture.invalid/a.mkv",
    behaviorHints: { videoSize: 8 * 1024 ** 3 },
  });

const opts = { activeDebrids: [] };

test("a platform modifier adds its reasons and exactly their deltas", () => {
  const s = parsed("Film.2020.1080p.BluRay.DTS.x264.mkv");
  const base = scoreStream(s, opts);
  setPlatformScoreModifier((st) =>
    st.audio.codec === "DTS" ? [{ signal: "platform-dts", delta: -30 }] : [],
  );
  try {
    const modded = scoreStream(s, opts);
    assert.equal(modded.score, base.score - 30);
    assert.deepEqual(modded.reasons.at(-1), { signal: "platform-dts", delta: -30 });
  } finally {
    setPlatformScoreModifier(null);
  }
  assert.equal(scoreStream(s, opts).score, base.score);
});

test("zero-delta reasons are dropped", () => {
  const s = parsed("Film.2020.1080p.WEB-DL.AAC.x264.mkv");
  const base = scoreStream(s, opts);
  setPlatformScoreModifier(() => [{ signal: "noop", delta: 0 }]);
  try {
    assert.deepEqual(scoreStream(s, opts).reasons, base.reasons);
  } finally {
    setPlatformScoreModifier(null);
  }
});
