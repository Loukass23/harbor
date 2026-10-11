import type { PlayerSource, TrackInfo } from "@/lib/player/bridge";
import type { SubTrack } from "@/lib/player/html5/types";
import {
  SubtitleSelectionCoordinator,
  type SubtitleSelectionOrigin,
} from "@/lib/player/subtitle-selection";
import { fetchAndParse, findActiveCue, type SubCue } from "@/lib/subtitles/parser";
import { clearPendingSub, markPendingSub } from "@/lib/subtitles/pending-subs";
import { SubtitlePreparationError, prepareSubtitle } from "@/lib/subtitles/prepare";
import { takePreparedSubtitle } from "@/lib/subtitles/prepared-registry";
import { subtitleTrackDownloadHeaders } from "@/lib/subtitles/provider-auth";
import { isSafeProviderSubtitleUrl } from "@/lib/subtitles/provider-url";
import { stripSdhText } from "@/lib/subtitles/sdh-filter";
import { PreparedSubtitleSeedBatch } from "@/lib/subtitles/seed-batch";
import { noteSubtitleOrigin } from "@/lib/subtitles/subtitle-memory";
import { registerTranslationJob } from "@/lib/subtitles/translation-jobs";
import type { SubtitleLoadMetadata } from "@/lib/subtitles/types";

export type CueText = {
  subText: string;
  subStartSec: number;
  secondarySubText: string;
};

/**
 * External subtitles for a player that cannot render text itself. AVPlay's own
 * text tracks crash the decoder on some streams (lessons.md), so cues are
 * parsed here and the shared DOM overlay draws `subText`. Same loading,
 * selection and SDH rules as the HTML5 bridge, built from the same modules.
 */
export function createCueTracks(onChange: () => void) {
  const tracks: SubTrack[] = [];
  let activeId: string | null = null;
  let secondaryId: string | null = null;
  let delaySec = 0;
  let hideSdh = false;
  let revision = 0;
  let lastCueId = "";
  let lastSecondRaw: string | null = null;
  const text: CueText = { subText: "", subStartSec: 0, secondarySubText: "" };
  const main = new SubtitleSelectionCoordinator();
  const secondary = new SubtitleSelectionCoordinator();
  const has = (id: string) => tracks.some((t) => t.id === id);

  const dispose = () => {
    for (const t of tracks) t.cleanup?.();
    tracks.length = 0;
  };

  const ensureLoaded = (track: SubTrack): Promise<boolean> => {
    if (track.cues) return Promise.resolve(track.cues.length > 0);
    if (track.loadingPromise) return track.loadingPromise;
    const rev = revision;
    track.loading = true;
    const loading = (async () => {
      try {
        if (/^https?:/i.test(track.url)) {
          const prepared = await prepareSubtitle({
            url: track.url,
            format: track.metadata?.format,
            encoding: track.metadata?.encoding,
            language: track.lang,
            release: track.metadata?.release,
            filename: track.metadata?.rawFilename,
            requestHeaders: subtitleTrackDownloadHeaders(
              track.metadata?.downloadAuth,
              track.url,
              track.metadata?.providerDerived ?? Boolean(track.metadata?.provider),
            ),
          });
          if (rev !== revision || !tracks.includes(track)) {
            prepared.cleanup();
            return false;
          }
          track.cleanup?.();
          track.cleanup = prepared.cleanup;
          track.url = prepared.playableUrl;
          track.cues = prepared.cues;
          track.metadata = {
            ...track.metadata,
            format: prepared.format,
            encoding: prepared.encoding,
            rawFilename: prepared.rawFilename,
            archive: prepared.archive,
            prepared: true,
          };
          clearPendingSub(track.originalUrl ?? track.url);
        } else {
          const cues = await fetchAndParse(track.url, { ...track.metadata, lang: track.lang });
          if (rev !== revision || !tracks.includes(track)) return false;
          track.cues = cues;
        }
        return track.cues.length > 0;
      } catch (e) {
        console.warn("[avplay] subtitle failed to load", e instanceof Error ? e.name : "unknown");
        if (
          track.metadata?.refreshable === true &&
          e instanceof SubtitlePreparationError &&
          (e.reason === "invalid-cues" || e.reason === "unsupported-format")
        ) {
          const pendingUrl = track.originalUrl ?? track.url;
          markPendingSub(pendingUrl);
          registerTranslationJob({
            url: pendingUrl,
            lang: track.lang,
            title: track.title,
            metadata: track.metadata,
          });
        }
        if (rev === revision && tracks.includes(track)) track.cues = [];
        return false;
      } finally {
        delete track.loadingPromise;
        track.loading = false;
        if (rev === revision && tracks.includes(track)) onChange();
      }
    })();
    track.loadingPromise = loading;
    return loading;
  };

  return {
    text,
    delaySec: () => delaySec,

    /** A new source: drops every track, then seeds the source's own subtitles. */
    reset(seeds: PlayerSource["subtitles"]) {
      revision += 1;
      main.invalidate();
      secondary.invalidate();
      dispose();
      activeId = null;
      secondaryId = null;
      delaySec = 0;
      lastCueId = "";
      lastSecondRaw = null;
      text.subText = "";
      text.subStartSec = 0;
      text.secondarySubText = "";
      const seeded: SubTrack[] = [];
      (seeds ?? []).forEach((s, i) => {
        if (s.trustedSource !== true && !isSafeProviderSubtitleUrl(s.url)) return;
        const track: SubTrack = {
          id: s.id ?? `seed-${i}`,
          url: s.url,
          originalUrl: s.url,
          lang: s.lang,
          external: true,
          cues: null,
          loading: false,
          metadata: {
            originalUrl: s.url,
            providerDerived: s.trustedSource !== true,
            autoSelectionEligible: false,
          },
        };
        tracks.push(track);
        seeded.push(track);
      });
      if (seeded.length === 0) return;
      const rev = revision;
      const batch = new PreparedSubtitleSeedBatch(seeded);
      void Promise.all(
        seeded.map(async (t) => {
          if (await ensureLoaded(t)) batch.markReady(t);
        }),
      ).then(() =>
        batch.commit(
          () => rev === revision,
          (ready) => {
            for (const t of ready) {
              if (!tracks.includes(t)) continue;
              t.metadata = { ...t.metadata, prepared: true, autoSelectionEligible: true };
            }
            onChange();
          },
        ),
      );
    },

    list(): TrackInfo[] {
      return tracks.map((t) => ({
        id: t.id,
        label: t.title || (t.lang ? t.lang.toUpperCase() : "Subtitle"),
        lang: t.lang,
        title: t.title,
        kind: "subtitle" as const,
        selected: t.id === activeId,
        secondary: t.id === secondaryId,
        external: t.external,
        prepared: t.metadata?.prepared === true || (t.cues != null && t.cues.length > 0),
        autoSelectionEligible: t.metadata?.autoSelectionEligible,
        url: t.originalUrl ?? t.url,
        originalUrl: t.metadata?.originalUrl ?? t.originalUrl,
        downloadAuth: t.metadata?.downloadAuth,
        format: t.metadata?.format,
        release: t.metadata?.release,
        provider: t.metadata?.provider,
        providerDerived: t.metadata?.providerDerived,
        fps: t.metadata?.fps,
        downloads: t.metadata?.downloads,
        author: t.metadata?.author,
        uploadedAt: t.metadata?.uploadedAt,
        rating: t.metadata?.rating,
        productionType: t.metadata?.productionType,
        releaseType: t.metadata?.releaseType,
        hearingImpaired: t.metadata?.hearingImpaired,
        forced: t.metadata?.forced,
        foreignOnly: t.metadata?.foreignOnly,
        machineTranslated: t.metadata?.machineTranslated,
        fromTrusted: t.metadata?.fromTrusted,
        providerMatch: t.metadata?.providerMatch,
        timingStatus: t.metadata?.timingStatus,
        timingMeasurementStatus: t.metadata?.timingMeasurementStatus,
        matchExplanation: t.metadata?.matchExplanation,
        matchScore: t.metadata?.matchScore,
        matchConfidence: t.metadata?.matchConfidence,
        matchReasons: t.metadata?.matchReasons,
        subId: t.metadata?.subId,
      }));
    },

    /** Updates `text` for the playback position. True when anything changed. */
    tick(positionSec: number): boolean {
      const t = positionSec - delaySec;
      let changed = false;
      const track = tracks.find((s) => s.id === activeId);
      if (!track?.cues) {
        if (text.subText !== "") {
          text.subText = "";
          text.subStartSec = 0;
          lastCueId = "";
          changed = true;
        }
      } else {
        const cue = findActiveCue(track.cues, t);
        const cueId = cue ? `${cue.start}|${cue.text}` : "";
        if (cueId !== lastCueId) {
          lastCueId = cueId;
          const raw = cue?.text ?? "";
          text.subText = hideSdh ? stripSdhText(raw) : raw;
          text.subStartSec = cue?.start ?? 0;
          changed = true;
        }
      }
      const second = secondaryId ? tracks.find((s) => s.id === secondaryId) : null;
      const secondRaw = (second?.cues ? findActiveCue(second.cues, t) : null)?.text ?? "";
      if (secondRaw !== lastSecondRaw) {
        lastSecondRaw = secondRaw;
        const next = hideSdh ? stripSdhText(secondRaw) : secondRaw;
        if (next !== text.secondarySubText) {
          text.secondarySubText = next;
          changed = true;
        }
      }
      return changed;
    },

    canAutoSelect: () => main.canAutoSelect(revision),

    select(id: string | null, origin: SubtitleSelectionOrigin = "manual") {
      if (!main.claim(revision, origin)) return;
      if (id == null) {
        main.invalidate();
        activeId = null;
        lastCueId = "";
        onChange();
        return;
      }
      const track = tracks.find((t) => t.id === id);
      if (!track) return;
      const request = main.begin(revision, id, activeId);
      void ensureLoaded(track).then((loaded) => {
        const settled = main.settle(request, revision, loaded, has);
        if (!settled.current) return;
        activeId = settled.selectedId;
        lastCueId = "";
        onChange();
      });
    },

    selectSecondary(id: string | null) {
      if (id == null) {
        secondary.invalidate();
        secondaryId = null;
        lastSecondRaw = null;
        text.secondarySubText = "";
        onChange();
        return;
      }
      const track = tracks.find((t) => t.id === id);
      if (!track) return;
      const request = secondary.begin(revision, id, secondaryId);
      void ensureLoaded(track).then((loaded) => {
        const settled = secondary.settle(request, revision, loaded, has);
        if (!settled.current) return;
        secondaryId = settled.selectedId;
        lastSecondRaw = null;
        if (secondaryId == null) text.secondarySubText = "";
        onChange();
      });
    },

    setHideSdh(on: boolean) {
      if (hideSdh === on) return;
      hideSdh = on;
      lastCueId = "";
      lastSecondRaw = null;
      onChange();
    },

    setDelay(sec: number) {
      delaySec = sec;
      lastCueId = "";
      onChange();
    },

    async add(
      url: string,
      lang?: string,
      title?: string,
      select?: boolean,
      metadata?: SubtitleLoadMetadata,
      origin: SubtitleSelectionOrigin = "manual",
    ): Promise<boolean> {
      const rev = revision;
      const id = `ext-${tracks.length}-${Date.now()}`;
      const request =
        select === true && main.claim(revision, origin) ? main.begin(revision, id, activeId) : null;
      const prepared = takePreparedSubtitle(url);
      const providerDerived = metadata?.providerDerived ?? Boolean(metadata?.provider);
      if (!prepared && providerDerived && !isSafeProviderSubtitleUrl(url)) return false;
      // A re-fetched provider subtitle replaces its earlier copy instead of stacking.
      const sourceUrl = metadata?.originalUrl ?? url;
      if (!prepared) {
        const prior = tracks.findIndex((t) => t.originalUrl === sourceUrl || t.url === sourceUrl);
        if (prior >= 0) {
          const [old] = tracks.splice(prior, 1);
          old.cleanup?.();
          if (activeId === old.id) activeId = null;
        }
      }
      if (rev !== revision) {
        prepared?.cleanup();
        return false;
      }
      const track: SubTrack = {
        id,
        url,
        originalUrl: metadata?.originalUrl ?? url,
        lang,
        title,
        external: true,
        cues: prepared?.cues ?? null,
        loading: false,
        metadata: prepared
          ? {
              ...metadata,
              format: prepared.format,
              encoding: prepared.encoding,
              rawFilename: prepared.rawFilename,
              archive: prepared.archive,
              prepared: true,
            }
          : metadata,
        cleanup: prepared?.cleanup,
      };
      tracks.push(track);
      noteSubtitleOrigin(url, url);
      if (!request) {
        onChange();
        return true;
      }
      const loaded = await ensureLoaded(track);
      if (rev !== revision || !tracks.includes(track) || !loaded) {
        const index = tracks.indexOf(track);
        if (index >= 0) tracks.splice(index, 1);
        track.cleanup?.();
        track.cleanup = undefined;
        if (rev !== revision) return false;
      }
      const settled = main.settle(request, revision, loaded, has);
      if (settled.current) {
        activeId = settled.selectedId;
        lastCueId = "";
      }
      onChange();
      return loaded;
    },

    selectedCues(): SubCue[] | null {
      return tracks.find((t) => t.id === activeId)?.cues ?? null;
    },

    selectedUrl(): string | null {
      return tracks.find((t) => t.id === activeId)?.url ?? null;
    },

    destroy() {
      revision += 1;
      main.invalidate();
      secondary.invalidate();
      dispose();
      activeId = null;
      secondaryId = null;
    },
  };
}

export type CueTracks = ReturnType<typeof createCueTracks>;
