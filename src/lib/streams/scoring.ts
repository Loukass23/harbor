export { computeCorpusStats } from "./scoring/scoring-corpus";
export { rankAndPick } from "./scoring/scoring-rank";
export {
  scoreStream,
  setPlatformScoreModifier,
  type PlatformScoreModifier,
} from "./scoring/scoring-stream";
export type { CorpusStats, ScoreOptions } from "./scoring/scoring-types";
