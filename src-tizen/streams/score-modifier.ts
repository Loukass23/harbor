import type { PlatformScoreModifier } from "@/lib/streams/scoring";

// What a Samsung TV can decode, as score signals added to the shared scorer
// (lessons.md → Codecs). Each reason carries the exact delta it adds.

/** No audio on most models. */
const DTS = -34;
/** No audio on most models. */
const TRUEHD = -16;
/** Dolby Vision profile 5 with no HDR10 base layer shows wrong colours. */
const DV_ONLY = -60;
/** Containers AVPlay rarely opens. */
const LEGACY_CONTAINER = -17;
/** An HDR10 base layer named anywhere in the release, apart from "DV" itself. */
const HDR_LAYER = /\bHDR(?:10\+?)?\b/i;
const DDP = 4;
const AAC = 2;
const EFFICIENT_VIDEO = 2;

export const tizenScoreModifier: PlatformScoreModifier = (s) => {
  const out: { signal: string; delta: number }[] = [];
  const audio = s.audio.codec;
  if (audio === "DTS" || audio === "DTS-HD MA") out.push({ signal: "tizen-dts", delta: DTS });
  // A remux's Atmos is TrueHD Atmos; a web release's is DD+ Atmos, which plays.
  else if (audio === "TrueHD" || (audio === "Atmos" && s.remux))
    out.push({ signal: "tizen-truehd", delta: TRUEHD });
  else if (audio === "DD+" || audio === "Atmos") out.push({ signal: "tizen-ddp", delta: DDP });
  else if (audio === "AAC") out.push({ signal: "tizen-aac", delta: AAC });

  // The parser says "DV+HDR10" only when HDR10 sits right after DV, so the usual
  // "DV.HDR" and "HDR.DV" tags (profile 8, which plays) also arrive as "DV".
  if (
    s.hdrFormat === "DV" &&
    !HDR_LAYER.test(`${s.name ?? ""} ${s.title ?? ""} ${s.description ?? ""}`)
  )
    out.push({ signal: "tizen-dv-no-hdr10", delta: DV_ONLY });
  if (s.codec === "HEVC" || s.codec === "AV1")
    out.push({ signal: "tizen-hw-codec", delta: EFFICIENT_VIDEO });
  if (s.container === "avi" || s.container === "wmv")
    out.push({ signal: "tizen-legacy-container", delta: LEGACY_CONTAINER });
  return out;
};
