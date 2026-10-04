import { Check, AlertCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import { useT } from "@/lib/i18n";
import { useActiveKid } from "@/lib/profiles";
import { useTvFocusScope } from "@/lib/keyboard-navigation";

type Variant = "check" | "stalled" | "failed";

export function StreamCheckPill({
  variant,
  visible,
  onDismiss,
  onLooksGood,
  onPickAnother,
  compact,
  live,
}: {
  variant: Variant;
  visible: boolean;
  onDismiss: () => void;
  onLooksGood?: () => void;
  onPickAnother: () => void;
  compact?: boolean;
  live?: boolean;
}) {
  const t = useT();
  const kid = useActiveKid();
  if (!visible || kid) return null;

  const copy = live
    ? variant === "check"
      ? {
          title: t("Is the channel playing right?"),
          sub: t("Wrong channel or source?"),
          icon: Check,
          accent: "rgba(255,255,255,0.85)",
        }
      : variant === "stalled"
        ? {
            title: t("Channel is taking a while"),
            sub: t("This source is slow. Try another."),
            icon: AlertCircle,
            accent: "#f59e0b",
          }
        : {
            title: t("Channel won't load"),
            sub: t("Try another source."),
            icon: AlertCircle,
            accent: "#ef4444",
          }
    : variant === "check"
      ? {
          title: t("Does this stream look right?"),
          sub: t("Wrong episode or quality?"),
          icon: Check,
          accent: "rgba(255,255,255,0.85)",
        }
      : variant === "stalled"
        ? {
            title: t("Stream is taking a while"),
            sub: t("Probably not cached. Pick another?"),
            icon: AlertCircle,
            accent: "#f59e0b",
          }
        : {
            title: t("Stream failed to load"),
            sub: t("Try a different source."),
            icon: AlertCircle,
            accent: "#ef4444",
          };

  const Icon = copy.icon;
  const scopeRef = useRef<HTMLDivElement>(null);
  const isCheck = variant === "check";
  // The start-of-show "does this look right?" question must be D-pad
  // reachable: pull TV focus into the pill when it appears so arrows start
  // on its actions instead of staying stranded in the sidebar zone.
  // Stalled/failed pills stay non-intrusive (no focus steal mid-buffering).
  useTvFocusScope(visible && isCheck, scopeRef);

  useEffect(() => {
    if (!visible) return;
    const BACK_KEYCODES = new Set([27, 4, 461, 10009, 166]);
    const BACK_KEYS = new Set(["Escape", "Esc", "BrowserBack", "GoBack", "Back"]);
    const onKey = (e: KeyboardEvent) => {
      if (!BACK_KEYS.has(e.key) && !BACK_KEYCODES.has(e.keyCode)) return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
      if (isCheck && onLooksGood) {
        onLooksGood();
      } else {
        // Non-dismissible states (stalled/failed re-derive from playback):
        // swallow Back and return focus to the player instead of bubbling
        // up into a player exit.
        const fallback = document.querySelector<HTMLElement>(
          "[data-harbor-player] [data-tv-initial-focus], [data-harbor-player] button:not([disabled])",
        );
        fallback?.focus();
      }
    };
    const onHwKey = (e: Event) => {
      if ((e as unknown as { keyName?: string }).keyName !== "back") return;
      e.preventDefault();
      e.stopPropagation();
      const stopImmediate = (e as unknown as { stopImmediatePropagation?: () => void })
        .stopImmediatePropagation;
      if (typeof stopImmediate === "function") {
        try {
          stopImmediate.call(e);
        } catch {}
      }
      if (isCheck && onLooksGood) onLooksGood();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("tizenhwkey", onHwKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("tizenhwkey", onHwKey, true);
    };
  }, [visible, isCheck, onLooksGood]);

  return (
    <div
      ref={scopeRef}
      data-tv-focus-scope
      data-avplay-overlay="open"
      className={`pointer-events-auto absolute left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-2xl border border-white/12 bg-black/85 py-2.5 ps-3.5 pe-2.5 shadow-[0_18px_48px_-18px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-2xl animate-in fade-in slide-in-from-top-2 duration-300 ${compact ? "top-2" : "top-7"}`}
      role="status"
    >
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
        style={{ background: variant === "check" ? "rgba(255,255,255,0.08)" : `${copy.accent}26` }}
      >
        <Icon size={14} strokeWidth={2.4} style={{ color: copy.accent }} />
      </span>
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="text-[13px] font-semibold text-white">{copy.title}</span>
        <span className="text-[11px] text-white/55">{copy.sub}</span>
      </div>
      <div className="flex items-center gap-1.5 ps-1">
        {variant === "check" && onLooksGood ? (
          <button
            type="button"
            tabIndex={0}
            data-tv-initial-focus
            onClick={onLooksGood}
            className="flex h-7 items-center gap-1 rounded-full px-3 text-[11.5px] font-semibold text-white/75 transition-colors hover:bg-white/8 hover:text-white"
            aria-label={t("Dismiss")}
          >
            {t("Looks good")}
          </button>
        ) : (
          <button
            onClick={onDismiss}
            className="flex h-7 items-center gap-1 rounded-full px-3 text-[11.5px] font-semibold text-white/75 transition-colors hover:bg-white/8 hover:text-white"
            aria-label={t("Dismiss")}
          >
            {variant === "check" ? t("Looks good") : t("Dismiss")}
          </button>
        )}
        <button
          type="button"
          tabIndex={0}
          onClick={onPickAnother}
          className="flex h-7 items-center gap-1.5 rounded-full bg-white/12 px-3 text-[11.5px] font-semibold text-white transition-colors hover:bg-white/22"
        >
          {live ? t("Other sources") : t("Pick another")}
        </button>
      </div>
    </div>
  );
}
