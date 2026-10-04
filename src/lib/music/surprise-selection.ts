import { dailyArtistKey } from "./daily-discovery-selection";
import { mixRecordings } from "./mix-quality";
import { musicTrackIdentity } from "./track-identity";
import type { MusicTrack } from "./types";

export function shuffleSurprise<T>(values: readonly T[], random = Math.random): T[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Familiar artists are welcome; known recordings never pad a discovery queue. */
export function selectSurpriseTracks(
  candidates: readonly MusicTrack[],
  familiar: ReadonlySet<string>,
  excluded: ReadonlySet<string>,
  previous: readonly MusicTrack[] = [],
  size = 12,
  random = Math.random,
): MusicTrack[] {
  const pool = shuffleSurprise(
    mixRecordings(candidates).filter((track) => !excluded.has(musicTrackIdentity(track))),
    random,
  );
  const fresh = pool.filter((track) => !familiar.has(musicTrackIdentity(track)));
  const out: MusicTrack[] = [];
  const artists = new Map<string, number>();
  for (const track of previous.slice(-4))
    artists.set(dailyArtistKey(track), (artists.get(dailyArtistKey(track)) ?? 0) + 1);
  const take = (lane: MusicTrack[]) => {
    const before = out.at(-1) ?? previous.at(-1);
    const last = before ? dailyArtistKey(before) : "";
    const index = lane.findIndex(
      (track) => dailyArtistKey(track) !== last && (artists.get(dailyArtistKey(track)) ?? 0) < 3,
    );
    if (index < 0) return false;
    const track = lane.splice(index, 1)[0];
    artists.set(dailyArtistKey(track), (artists.get(dailyArtistKey(track)) ?? 0) + 1);
    out.push({ ...track, mediaKind: "audio" });
    return true;
  };
  while (out.length < size) {
    if (!take(fresh)) break;
  }
  return out;
}
