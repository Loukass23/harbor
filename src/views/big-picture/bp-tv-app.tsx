import { Suspense, lazy, useEffect, type ComponentType, type ReactNode } from "react";
import { CurfewGuard } from "@/components/curfew-guard";
import { RemoteHostMount } from "@/lib/remote/host-mount";
import { RemoteOpenBridge } from "@/lib/remote/remote-open-bridge";
import { GamepadRunner } from "@/components/gamepad-runner";
import { HarborAvatarSync } from "@/components/harbor-avatar-sync";
import { HarborNameSync } from "@/components/harbor-name-sync";
import { ProfileIdentitySync } from "@/lib/profile-identity-sync";
import { ProfileSyncRunner } from "@/lib/profile-sync";
import { SettingsProfileBridge } from "@/lib/settings-profile-bridge";
import { TrackerProfileBridge } from "@/lib/tracker-profile-bridge";
import { AnilistProvider } from "@/lib/anilist/provider";
import { AuthProvider } from "@/lib/auth";
import { enterBigPicture, useBigPicture } from "@/lib/big-picture";
import { CharacterFavoritesProvider } from "@/lib/character-favorites";
import { ContextMenuProvider } from "@/lib/context-menu";
import { DvrProvider } from "@/lib/dvr/provider";
import { FavoritesProvider } from "@/lib/iptv/favorites";
import { LocalWatchlistProvider } from "@/lib/local-watchlist";
import { MalProvider } from "@/lib/mal/provider";
import { MangaFavoritesProvider } from "@/lib/manga-favorites";
import { MediaFavoritesProvider } from "@/lib/media-favorites";
import { OnboardingProvider } from "@/lib/onboarding";
import { ParentalProvider } from "@/lib/parental";
import { ProfilesProvider } from "@/lib/profiles";
import { RankingsProvider } from "@/lib/rankings";
import { SearchProvider } from "@/lib/search-context";
import { SettingsProvider, useSettings } from "@/lib/settings";
import { SFX } from "@/lib/sfx";
import { SimklProvider } from "@/lib/simkl/provider";
import { LetterboxdProvider } from "@/lib/stremboxd/provider";
import { TogetherProvider } from "@/lib/together/provider";
import { TopRankModalProvider } from "@/lib/top-rank-modal";
import { TraktProvider } from "@/lib/trakt/provider";
import { ViewProvider, useView } from "@/lib/view";
import { setBpTvShell } from "./bp-logic";
import { setBpOverscanDefault, TEN_FOOT_OVERSCAN } from "./bp-safe-area";

// This entry renders nothing but BigPictureShell, so Big Picture must never decline to
// mount. Without this a kid profile makes the shell return null and the television is a
// black screen a power cycle cannot clear.
setBpTvShell(true);

// This entry only ever boots on a television, so it states the inset outright
// rather than waiting for bp-safe-area to recognise the device from its agent.
// Default, not override: a panel with no crop must still be able to turn it off.
setBpOverscanDefault(TEN_FOOT_OVERSCAN);

const BigPictureShell = lazy(() =>
  import("./bp-shell").then((m) => ({ default: m.BigPictureShell })),
);

const PlayerView = lazy(() =>
  import("@/views/player").then((m) => ({ default: m.PlayerView })),
);

type BpTvProvider = ComponentType<{ children: ReactNode }>;

function BpTvSettingsProvider({ children }: { children: ReactNode }) {
  return <SettingsProvider syncTorrentEnginePolicy>{children}</SettingsProvider>;
}

const BP_TV_PROVIDERS: BpTvProvider[] = [
  BpTvSettingsProvider,
  ProfilesProvider,
  ParentalProvider,
  TraktProvider,
  AnilistProvider,
  MalProvider,
  SimklProvider,
  LetterboxdProvider,
  RankingsProvider,
  AuthProvider,
  OnboardingProvider,
  TogetherProvider,
  ViewProvider,
  SearchProvider,
  DvrProvider,
  FavoritesProvider,
  MediaFavoritesProvider,
  CharacterFavoritesProvider,
  MangaFavoritesProvider,
  LocalWatchlistProvider,
  ContextMenuProvider,
  TopRankModalProvider,
];

function BpTvSound() {
  const { settings } = useSettings();
  useEffect(() => {
    SFX.setTheme(settings.soundTheme);
    SFX.setVolume((settings.sfxVolume ?? 50) / 100);
  }, [settings.soundTheme, settings.sfxVolume]);
  return null;
}

function SmartViewReceiverMount() {
  useEffect(() => {
    if (typeof window === "undefined" || !("tizen" in window || "webapis" in window)) return;
    let ws: WebSocket | null = null;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      try {
        ws = new WebSocket("ws://127.0.0.1:8001/api/v2/channels/samsung.smartview.harbor?name=HarborTV");
        ws.onmessage = (evt) => {
          try {
            const parsed = JSON.parse(String(evt.data));
            const data = (parsed && typeof parsed === "object" && "data" in parsed) ? (parsed as { data: any }).data : parsed;
            if (data && (data.action === "playMeta" || data.action === "openMeta")) {
              window.dispatchEvent(new CustomEvent("harbor:remote-open", { detail: data }));
            }
          } catch {}
        };
        ws.onclose = () => {
          ws = null;
          if (!cancelled) setTimeout(connect, 5000);
        };
      } catch {}
    };

    connect();
    return () => {
      cancelled = true;
      try { ws?.close(); } catch {}
    };
  }, []);

  return null;
}

function BpTvRoot() {
  const { active } = useBigPicture();
  const { player } = useView();

  // The kid check that used to guard this was the second half of the black screen: the
  // shell had already exited and this refused to re-enter, so nothing was mounted at all.
  useEffect(() => {
    if (active) return;
    enterBigPicture();
  }, [active]);

  return (
    <>
      <BpTvSound />
      <GamepadRunner />
      {/* Mounted here, not on desktop only. Without these a profile switch on the
          television changed the avatar and nothing else: settings did not reload,
          tracker sessions kept the previous profile's tokens, and CURFEW WAS NOT
          ENFORCED on the one device children actually use. */}
      <ProfileIdentitySync />
      <HarborAvatarSync />
      <HarborNameSync />
      <SettingsProfileBridge />
      <TrackerProfileBridge />
      <ProfileSyncRunner />
      {player && (
        <Suspense fallback={null}>
          <PlayerView
            key={player.meta.id.startsWith("iptv:") ? "player-live" : `player-${player.meta.id}`}
            src={player}
          />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <BigPictureShell />
      </Suspense>
      <CurfewGuard />
      <RemoteHostMount />
      <RemoteOpenBridge />
      <SmartViewReceiverMount />
    </>
  );
}

export function BpTvApp() {
  const tree = BP_TV_PROVIDERS.reduceRight<ReactNode>(
    (node, Provider) => <Provider>{node}</Provider>,
    <BpTvRoot />,
  );
  return <>{tree}</>;
}
