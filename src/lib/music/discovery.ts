import { safeFetch } from "@/lib/safe-fetch";
import type { MusicCatalogItem, MusicTrack } from "./types";
import { MUSIC_GENRES, musicGenre, genreSearchKey } from "./genre-catalog";
import type { MusicDiscoveryGenre } from "./genre-catalog";
export type { MusicDiscoveryGenre } from "./genre-catalog";

export type MusicDiscoveryChart = {
  tracks: MusicTrack[];
  positions: (number | null)[];
  artists: Extract<MusicCatalogItem, { kind: "artist" }>[];
  popularity?: Record<string, number>;
  albums?: Extract<MusicCatalogItem, { kind: "album" }>[];
};

type RecordValue = Record<string, unknown>;
const cache = new Map<string, { at: number; data: unknown[] }>();
const pending = new Map<string, Promise<unknown[]>>();
const CACHE_MS = 15 * 60 * 1000;

function record(value: unknown): RecordValue {
  return value !== null && typeof value === "object" ? (value as RecordValue) : {};
}

function label(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function image(...values: unknown[]): string {
  return values.map(label).find((value) => value.startsWith("https://")) ?? "";
}

async function entries(path: string): Promise<unknown[]> {
  const stored = cache.get(path);
  if (stored && Date.now() - stored.at < CACHE_MS) return stored.data;
  const active = pending.get(path);
  if (active) return active;
  const request = (async () => {
    const response = await safeFetch(`https://api.deezer.com/${path}`, {
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`Deezer: ${response.status}`);
    const body = record(await response.json());
    if (body.error || !Array.isArray(body.data)) throw new Error("Deezer discovery unavailable");
    cache.set(path, { at: Date.now(), data: body.data });
    return body.data;
  })().finally(() => {
    pending.delete(path);
  });
  pending.set(path, request);
  return request;
}

export async function loadMusicDiscoveryGenres(): Promise<MusicDiscoveryGenre[]> {
  return MUSIC_GENRES;
}

export function parseMusicDiscoveryChart(data: unknown[]): MusicDiscoveryChart {
  const tracks: MusicTrack[] = [];
  const positions: (number | null)[] = [];
  const artists = new Map<string, Extract<MusicCatalogItem, { kind: "artist" }>>();
  const seen = new Set<number>();
  const popularity: Record<string, number> = {};
  const albums = new Map<number, Extract<MusicCatalogItem, { kind: "album" }>>();
  for (const value of data) {
    const entry = record(value);
    const credit = record(entry.artist);
    const album = record(entry.album);
    const id = Number(entry.id);
    const title = label(entry.title);
    const artist = label(credit.name);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id) || !title || !artist) continue;
    seen.add(id);
    if (typeof entry.rank === "number" && Number.isFinite(entry.rank) && entry.rank > 0)
      popularity[`deezer:track:${id}`] = entry.rank;
    const albumId = Number(album.id);
    if (Number.isSafeInteger(albumId) && albumId > 0 && label(album.title))
      albums.set(albumId, {
        kind: "album",
        id: `deezer:album:${albumId}`,
        connectorId: "catalog",
        title: label(album.title),
        artist,
        artwork: image(album.cover_xl, album.cover_big, album.cover_medium),
      });
    const duration =
      typeof entry.duration === "number" && Number.isFinite(entry.duration)
        ? Math.max(0, Math.floor(entry.duration))
        : 0;
    tracks.push({
      id: `deezer:track:${id}`,
      sourceId: String(id),
      connectorId: "catalog",
      title,
      artist,
      album: label(album.title) || undefined,
      artwork: image(album.cover_xl, album.cover_big, album.cover_medium),
      durationSeconds: duration,
      durationLabel: `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, "0")}`,
    });
    positions.push(
      typeof entry.position === "number" &&
        Number.isSafeInteger(entry.position) &&
        entry.position > 0
        ? entry.position
        : null,
    );
    const artistId = Number(credit.id);
    if (Number.isSafeInteger(artistId) && artistId > 0 && !artists.has(String(artistId))) {
      artists.set(String(artistId), {
        kind: "artist",
        id: `deezer:artist:${artistId}`,
        connectorId: "catalog",
        name: artist,
        artwork: image(credit.picture_big, credit.picture_medium, credit.picture_xl),
      });
    }
  }
  return {
    tracks,
    positions,
    artists: [...artists.values()],
    albums: [...albums.values()],
    popularity,
  };
}

export async function loadMusicDiscoveryChart(genreId = 0): Promise<MusicDiscoveryChart> {
  if (!Number.isSafeInteger(genreId) || genreId < 0) throw new Error("Invalid music genre");
  const genre = musicGenre(genreId);
  if (genre && !genre.deezerId) return loadMusicGenreSelection(genreId);
  if (genreId !== 0 && !genre) throw new Error("Unknown music genre");
  // The genre artist endpoint currently ignores its filter. Credits from these genre charts
  // keep artist browsing relevant and avoid a second provider request.
  return parseMusicDiscoveryChart(await entries(`chart/${genreId}/tracks?limit=24`));
}

type DiscoveryPlaylist = Extract<MusicCatalogItem, { kind: "playlist" }>;
export type MusicGenreSelection = MusicDiscoveryChart & { playlists: DiscoveryPlaylist[] };

/** Match whole genre terms: a search hit alone is not evidence of genre membership. */
export function matchesGenrePlaylist(title: string, terms: readonly string[]): boolean {
  const name = ` ${genreSearchKey(title)} `;
  return terms.some((term) => name.includes(` ${genreSearchKey(term)} `));
}

export async function loadMusicGenreSelection(genreId: number): Promise<MusicGenreSelection> {
  const genre = musicGenre(genreId);
  if (!genre) throw new Error("Unknown music genre");
  if (genre.deezerId) return { ...(await loadMusicDiscoveryChart(genre.deezerId)), playlists: [] };
  const query =
    genre.aliases[0] && ["hardcore", "regional-mexican"].includes(genre.slug)
      ? genre.aliases[0]
      : genre.name;
  const results = await entries(`search/playlist?q=${encodeURIComponent(query)}&limit=20`);
  const playlists: DiscoveryPlaylist[] = results
    .flatMap((value) => {
      const entry = record(value),
        id = Number(entry.id),
        name = label(entry.title);
      if (
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        !matchesGenrePlaylist(name, [genre.name, ...genre.aliases])
      )
        return [];
      const artwork = image(entry.picture_xl, entry.picture_big, entry.picture_medium);
      return [
        {
          kind: "playlist" as const,
          id: `deezer:playlist:${id}`,
          connectorId: "catalog",
          name,
          artwork: artwork ? [artwork] : [],
          trackCount: typeof entry.nb_tracks === "number" ? entry.nb_tracks : undefined,
          subtitle: label(record(entry.user).name) || "Deezer",
        },
      ];
    })
    .slice(0, 8);
  // Two playlists give breadth without fan-out for every genre tile or artist.
  const pages = await Promise.allSettled(
    playlists
      .slice(0, 2)
      .map((playlist) => entries(`playlist/${playlist.id.split(":").at(-1)}/tracks?limit=24`)),
  );
  if (pages.length && pages.every((page) => page.status === "rejected"))
    throw new Error("Genre selections unavailable");
  const lanes = pages.flatMap((page) => (page.status === "fulfilled" ? [page.value] : []));
  const mixed: unknown[] = [];
  for (let index = 0; index < 24; index++)
    for (const lane of lanes) if (lane[index]) mixed.push(lane[index]);
  const parsed = parseMusicDiscoveryChart(mixed);
  return {
    ...parsed,
    tracks: parsed.tracks.slice(0, 30),
    positions: parsed.tracks.slice(0, 30).map(() => null),
    playlists,
  };
}

export async function loadMusicDiscoveryPlaylists(
  genreId = 0,
  limit = 50,
): Promise<Extract<MusicCatalogItem, { kind: "playlist" }>[]> {
  return (await entries(`chart/${genreId}/playlists?limit=${limit}`)).flatMap((value) => {
    const entry = record(value);
    const id = Number(entry.id);
    if (!Number.isSafeInteger(id) || id <= 0 || !label(entry.title)) return [];
    const artwork = image(entry.picture_xl, entry.picture_big, entry.picture_medium);
    return [
      {
        kind: "playlist" as const,
        id: `deezer:playlist:${id}`,
        connectorId: "catalog",
        name: label(entry.title),
        artwork: artwork ? [artwork] : [],
        trackCount: typeof entry.nb_tracks === "number" ? entry.nb_tracks : undefined,
        subtitle: label(record(entry.user).name) || "Deezer",
      },
    ];
  });
}
