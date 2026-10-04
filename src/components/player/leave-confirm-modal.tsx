import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useT } from "@/lib/i18n";
import { useTvFocusScope } from "@/lib/keyboard-navigation";
import {
  closeLeaveConfirm,
  getLeaveConfirm,
  subscribeLeaveConfirm,
} from "@/lib/player/leave-confirm";

export function LeaveConfirmModal() {
  const t = useT();
  const state = useSyncExternalStore(subscribeLeaveConfirm, getLeaveConfirm);
  const [remember, setRemember] = useState(false);
  const scopeRef = useRef<HTMLDivElement>(null);
  const leaveRef = useRef<HTMLButtonElement>(null);
  const rememberRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.open) setRemember(false);
  }, [state.open]);

  // D-pad entry: focus starts on the safe action, never the destructive one.
  useTvFocusScope(state.open, scopeRef);

  useEffect(() => {
    if (!state.open) return;
    const BACK_KEYCODES = new Set([27, 4, 461, 10009, 166]);
    const BACK_KEYS = new Set(["Escape", "Esc", "BrowserBack", "GoBack", "Back"]);
    const onKey = (e: KeyboardEvent) => {
      if (BACK_KEYS.has(e.key) || BACK_KEYCODES.has(e.keyCode)) {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
        closeLeaveConfirm();
        return;
      }
      // Enter must activate the FOCUSED control, not always confirm-leave:
      // remotes send Enter (not Space), so route it explicitly. Anything
      // else (arrows, etc.) belongs to spatial navigation — leave it alone.
      if (e.key === "Enter" || e.keyCode === 13) {
        const active = document.activeElement;
        if (active === leaveRef.current) {
          e.preventDefault();
          e.stopPropagation();
          if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
          const fn = state.onConfirm;
          closeLeaveConfirm();
          fn?.(remember);
        } else if (active === rememberRef.current) {
          e.preventDefault();
          e.stopPropagation();
          if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
          setRemember((v) => !v);
        }
        // "Keep watching" (and anything else): fall through so the focused
        // button receives its native click instead of exiting playback.
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
      closeLeaveConfirm();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("tizenhwkey", onHwKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("tizenhwkey", onHwKey, true);
    };
  }, [state.open, state.onConfirm, remember]);

  if (!state.open) return null;

  const leave = () => {
    const fn = state.onConfirm;
    closeLeaveConfirm();
    fn?.(remember);
  };

  return (
    <div
      ref={scopeRef}
      data-tv-focus-scope
      data-avplay-overlay="open"
      role="dialog"
      aria-modal="true"
      aria-label={t("Leave the show?")}
      className="absolute inset-0 z-[110] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={closeLeaveConfirm}
    >
      <div
        className="mx-4 w-full max-w-md rounded-2xl border border-edge bg-surface p-7 text-center shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[22px] font-bold text-ink">{t("Leave the show?")}</h2>
        <p className="mt-2.5 text-[15px] leading-relaxed text-ink-muted">
          {t("We'll save your spot so you can pick up right where you left off.")}
        </p>
        <label className="mt-5 inline-flex cursor-pointer items-center justify-center gap-2.5 text-[14px] text-ink-muted">
          <input
            ref={rememberRef}
            type="checkbox"
            tabIndex={0}
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-[18px] w-[18px] cursor-pointer"
            aria-label={t("Don't ask me again")}
          />
          {t("Don't ask me again")}
        </label>
        <div className="mt-6 flex gap-3">
          <button
            type="button"
            tabIndex={0}
            data-tv-initial-focus
            onClick={closeLeaveConfirm}
            data-tv-modal-close
            className="h-12 flex-1 rounded-xl bg-elevated text-[16px] font-semibold text-ink transition-colors hover:bg-raised"
          >
            {t("Keep watching")}
          </button>
          <button
            ref={leaveRef}
            type="button"
            tabIndex={0}
            onClick={leave}
            className="h-12 flex-1 rounded-xl bg-ink text-[16px] font-semibold text-canvas transition-transform hover:scale-[1.02]"
          >
            {t("Leave")}
          </button>
        </div>
      </div>
    </div>
  );
}
