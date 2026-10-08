/* Discord-safe manga covers.
 *
 * Discord only renders images its own servers can fetch: a public HTTPS URL
 * that is short enough to send. Manga covers usually come from the source
 * itself - a local Suwayomi server (plain HTTP / LAN), a local folder
 * (asset.localhost), or an extension whose CDN is hotlink-protected - so they
 * are not fetchable and the presence falls back to the app default art.
 *
 * When the source cover is not Discord-fetchable we resolve the title's cover
 * from AniList instead: a public third-party HTTPS image, cached per title.
 * Nothing is routed through a Harbor server.
 */
import { anilistRequest } from "@/lib/anilist/client";
import { readArt, writeArt } from "@/lib/manga/art-cache";
import { stripColorTag } from "@/lib/manga/title";

const QUERY = `query ($s: String) {
  m: Page(perPage: 1) { media(search: $s, type: MANGA) { coverImage { extraLarge } } }
  a: Page(perPage: 1) { media(search: $s, type: ANIME) { coverImage { extraLarge } } }
}`;

type Media = { coverImage: { extraLarge: string | null } | null };
type Resp = { m: { media: Media[] } | null; a: { media: Media[] } | null };

const ART_NS = "discordcover";

// Title key -> resolved AniList cover, or null when the lookup ran and found
// nothing (so a title is never re-queried for the rest of the session).
const cache = new Map<string, string | null>();
const inflight = new Set<string>();
let notify: (() => void) | null = null;

/** Registered by the presence layer so a resolved cover can be flushed. */
export function onMangaCoverResolved(cb: () => void): void {
  notify = cb;
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "::1" || h === "[::1]") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127 || a === 169) return true;
  return (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** True when Discord's servers can fetch this image: public HTTPS, <= 256 chars. */
export function discordFetchableCover(cover?: string | null): string | undefined {
  if (!cover || !cover.startsWith("https://") || cover.length > 256) return undefined;
  try {
    if (isPrivateHost(new URL(cover).hostname)) return undefined;
  } catch {
    return undefined;
  }
  return cover;
}

function keyOf(title: string): string {
  return title.trim().toLowerCase();
}

function cachedFor(title: string): string | null | undefined {
  const key = keyOf(title);
  if (!key) return undefined;
  if (cache.has(key)) return cache.get(key);
  const disk = readArt(ART_NS, key);
  if (disk) {
    cache.set(key, disk);
    return disk;
  }
  return undefined;
}

function resolve(title: string): void {
  const key = keyOf(title);
  if (!key || cache.has(key) || inflight.has(key)) return;
  inflight.add(key);
  void (async () => {
    let url: string | null = null;
    try {
      const data = await anilistRequest<Resp>(QUERY, { s: title }, undefined, true);
      url =
        data?.m?.media?.[0]?.coverImage?.extraLarge ??
        data?.a?.media?.[0]?.coverImage?.extraLarge ??
        null;
    } catch {
      url = null;
    }
    cache.set(key, url);
    if (url) writeArt(ART_NS, key, url);
    inflight.delete(key);
    notify?.();
  })();
}

/** Discord-usable cover for a manga: the source cover when Discord can fetch it,
 *  otherwise the cached AniList cover (kicks off a lookup when one is missing). */
export function mangaDiscordCover(
  cover?: string | null,
  title?: string | null,
): string | undefined {
  const direct = discordFetchableCover(cover);
  if (direct) return direct;
  const name = title ? stripColorTag(title).trim() : "";
  if (!name) return undefined;
  const cached = cachedFor(name);
  if (cached !== undefined) return cached ?? undefined;
  resolve(name);
  return undefined;
}
