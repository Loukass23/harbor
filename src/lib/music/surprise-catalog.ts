import { resolveArtist } from "./artist-authority";
import { artistIdentityKey } from "./artist-popularity";
import { artistRows, artistTop } from "./catalog";
import { dailyArtistKey, dailyDayKey } from "./daily-discovery-selection";
import { loadGenreArtistRoster } from "./genre-artist-roster";
import { readMadeForYouShelf } from "./made-for-you";
import { rankMixArtists, type MixTaste } from "./made-for-you-selection";
import { mixRecordings } from "./mix-quality";
import { filterBlockedTracks } from "./artist-blocks";
import { shuffleSurprise } from "./surprise-selection";
import { musicTrackIdentity } from "./track-identity";
import type { MusicArtistRef, MusicTrack } from "./types";

export const allowedSurpriseTracks = (tracks: readonly MusicTrack[]) =>
  mixRecordings(filterBlockedTracks(filterBlockedTracks(tracks, "show"), "play"));

/** Bounded catalog work, only on refill. Neighbours remain one hop from an actual taste. */
export function createSurpriseCatalog(
  taste: MixTaste,
  genres: readonly number[],
  profile: string,
  signal: AbortSignal,
) {
  type Artist = { name: string; ref?: MusicArtistRef; seed?: MusicTrack; neighbours: boolean };
  const clean = {
    ...taste,
    recents: allowedSurpriseTracks(taste.recents),
    liked: allowedSurpriseTracks(taste.liked),
    library: allowedSurpriseTracks(taste.library),
  };
  const current = rankMixArtists({
    ...clean,
    recents: clean.recents.slice(0, 12),
    liked: [],
    library: [],
    followed: [],
  }).slice(0, 4);
  const playlistArtists = rankMixArtists({ ...clean, recents: [], liked: [], followed: [] });
  const anchors = [
    ...new Map(
      [...current, ...playlistArtists, ...rankMixArtists(clean)].map((artist) => [
        artist.key,
        artist,
      ]),
    ).values(),
  ];
  // Keep current listening in the mix while giving less-recent playlist artists a turn.
  const currentKeys = new Set(current.map((artist) => artist.key));
  const starters = [
    ...current,
    ...shuffleSurprise(anchors.filter((artist) => !currentKeys.has(artist.key))).slice(0, 8),
  ];
  const pending: Artist[] = shuffleSurprise(starters).map((artist) => ({
    name: artist.name,
    ref: artist.ref,
    seed: artist.seeds[0],
    neighbours: true,
  }));
  const queued = new Set(pending.map((artist) => artistIdentityKey(artist.name)));
  const pool = new Map<string, MusicTrack>();
  const tasteGenres = shuffleSurprise([...new Set(genres)]);
  const offsets = new Map<number, number | null>();
  let genreCursor = 0,
    warmed = false;
  const add = (tracks: readonly MusicTrack[]) => {
    for (const track of allowedSurpriseTracks(tracks)) pool.set(musicTrackIdentity(track), track);
    while (pool.size > 800) pool.delete(pool.keys().next().value!);
  };
  const enqueue = (artists: Artist[]) => {
    for (const artist of artists) {
      const key = artistIdentityKey(artist.name);
      if (!key || queued.has(key) || pending.length >= 72) continue;
      queued.add(key);
      pending.push(artist);
    }
  };
  const fetchArtist = async (artist: Artist) => {
    if (signal.aborted) return;
    const key = artistIdentityKey(artist.name);
    const ref =
      artist.ref && !artist.ref.id.startsWith("musicbrainz:")
        ? artist.ref
        : (
            await resolveArtist(artist.name, {
              track: artist.seed,
              hint: artist.ref ? [artist.ref] : undefined,
            }).catch(() => null)
          )?.canonical;
    if (
      signal.aborted ||
      !ref ||
      ref.id.startsWith("musicbrainz:") ||
      artistIdentityKey(ref.name) !== key
    )
      return;
    const tracks = await artistTop(ref).catch(() => []);
    if (signal.aborted) return;
    add(tracks.filter((track) => dailyArtistKey(track) === key));
    if (!artist.neighbours) return;
    const rows = await artistRows(ref).catch(() => []);
    if (signal.aborted) return;
    const related = rows.flatMap((row) =>
      row.id === "artist:related" || row.title === "music.detail.relatedArtists"
        ? row.items.filter(
            (item): item is MusicArtistRef & { kind: "artist" } => item.kind === "artist",
          )
        : [],
    );
    enqueue(
      shuffleSurprise(related)
        .slice(0, 8)
        .map((ref) => ({ name: ref.name, ref, neighbours: false })),
    );
  };
  return {
    async warm() {
      if (warmed) return;
      warmed = true;
      const shelf = await readMadeForYouShelf(dailyDayKey(), profile, !!anchors.length).catch(
        () => [],
      );
      if (!signal.aborted) add(shelf.flatMap((mix) => mix.tracks));
    },
    async expand() {
      if (signal.aborted) return;
      // Selected genres can broaden the taste, but never substitute an unrelated generic chart.
      if (
        tasteGenres.length &&
        pending.length < 4 &&
        (genreCursor < tasteGenres.length || !pending.length)
      ) {
        const genre = tasteGenres[genreCursor++ % tasteGenres.length];
        const offset = offsets.get(genre) ?? 0;
        if (offsets.get(genre) !== null) {
          const page = await loadGenreArtistRoster(genre, offset).catch(() => null);
          if (signal.aborted) return;
          if (page) {
            offsets.set(genre, page.next);
            enqueue(
              shuffleSurprise(page.artists)
                .slice(0, 6)
                .map((ref) => ({ name: ref.name, ref, neighbours: false })),
            );
          }
        }
      }
      if (!pending.length && anchors.length) {
        // Revisit trusted artists after catalog exhaustion; the session's recent-history window
        // still excludes repeats and allows a long-running session to discover later releases.
        queued.clear();
        enqueue(
          shuffleSurprise(anchors).map((artist) => ({
            name: artist.name,
            ref: artist.ref,
            seed: artist.seeds[0],
            neighbours: true,
          })),
        );
      }
      await Promise.all(pending.splice(0, 2).map(fetchArtist));
    },
    candidates() {
      return allowedSurpriseTracks([...pool.values()]);
    },
    consume(tracks: readonly MusicTrack[]) {
      for (const track of tracks) pool.delete(musicTrackIdentity(track));
    },
  };
}
