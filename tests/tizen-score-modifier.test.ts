// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { parseStream } from "../src/lib/streams/parser.ts";
import { scoreStream, setPlatformScoreModifier } from "../src/lib/streams/scoring.ts";
import { tizenScoreModifier } from "../src-tizen/streams/score-modifier.ts";

const parsed = (title: string) =>
  parseStream({
    addonId: "fixture",
    addonName: "Fixture",
    title,
    url: "https://fixture.invalid/a.mkv",
    behaviorHints: { videoSize: 12 * 1024 ** 3 },
  });

const opts = { activeDebrids: [] };

function scored(title: string) {
  setPlatformScoreModifier(tizenScoreModifier);
  try {
    return scoreStream(parsed(title), opts);
  } finally {
    setPlatformScoreModifier(null);
  }
}

test("a DTS release ranks below the same release with DD+", () => {
  const dts = scored("Film.2020.1080p.BluRay.DTS.x264-GRP.mkv");
  const ddp = scored("Film.2020.1080p.BluRay.DDP5.1.x264-GRP.mkv");
  assert.ok(ddp.score > dts.score, `${ddp.score} > ${dts.score}`);
});

test("Dolby Vision without HDR10 ranks below DV with an HDR10 base layer", () => {
  const dvOnly = scored("Film.2020.2160p.WEB-DL.DV.DDP5.1.H.265-GRP.mkv");
  const dvHdr = scored("Film.2020.2160p.WEB-DL.DV.HDR10.DDP5.1.H.265-GRP.mkv");
  assert.ok(dvHdr.score > dvOnly.score, `${dvHdr.score} > ${dvOnly.score}`);
});

test("every Tizen reason adds exactly its own delta", () => {
  const s = parsed("Film.2020.1080p.BluRay.TrueHD.7.1.x265-GRP.mkv");
  const base = scoreStream(s, opts);
  const tizen = scored("Film.2020.1080p.BluRay.TrueHD.7.1.x265-GRP.mkv");
  const added = tizen.reasons.filter((r) => r.signal.startsWith("tizen-"));
  assert.ok(added.some((r) => r.signal === "tizen-truehd"));
  assert.equal(
    tizen.score - base.score,
    added.reduce((sum, r) => sum + r.delta, 0),
  );
});
