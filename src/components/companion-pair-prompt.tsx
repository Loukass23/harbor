import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MonitorSmartphone } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useSettings } from "@/lib/settings";
import { readActiveStremioAuthKey } from "@/lib/auth";
import { loadInstalled } from "@/lib/addon-store";
import { availableSections, buildCompanionPayload } from "@/lib/companion/build-payload";
import type { CompanionPairRequest, CompanionSection } from "@/lib/companion/protocol";

/** The device stops waiting after two minutes; so does the dialog. */
const REQUEST_TTL_MS = 120_000;

const SECTION_LABELS: Record<CompanionSection, string> = {
  stremio: "Stremio account (signs the device in)",
  tmdb: "TMDB key",
  debrid: "Debrid keys",
  addons: "Installed addons",
};

/**
 * Asks before a device on the LAN pairs with this Harbor. The device shows
 * the same code, which is the only thing tying the request on screen to the
 * device in the room, so it is the largest text here.
 */
export function CompanionPairPrompt() {
  const t = useT();
  const { settings } = useSettings();
  // Queued, never replaced: a second request must not swap the code under the
  // user's cursor while they compare it with the one on the TV.
  const [queue, setQueue] = useState<CompanionPairRequest[]>([]);
  const request = queue[0] ?? null;
  const [chosen, setChosen] = useState<Set<CompanionSection>>(new Set());
  const [busy, setBusy] = useState(false);
  const denyRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const offs: Array<() => void> = [];
    let cancelled = false;
    const drop = (requestId: string) =>
      setQueue((cur) => cur.filter((r) => r.requestId !== requestId));
    void listen<CompanionPairRequest>("companion://pair-request", (e) => {
      setQueue((cur) => [...cur, e.payload]);
      window.setTimeout(() => drop(e.payload.requestId), REQUEST_TTL_MS);
    }).then((off) => (cancelled ? off() : offs.push(off)));
    void listen<{ requestId: string }>("companion://pair-closed", (e) => {
      drop(e.payload.requestId);
    }).then((off) => (cancelled ? off() : offs.push(off)));
    return () => {
      cancelled = true;
      for (const off of offs) off();
    };
  }, []);

  const source = useMemo(
    () =>
      request
        ? { stremioAuthKey: readActiveStremioAuthKey(), settings, addons: loadInstalled() }
        : null,
    [request, settings],
  );
  const offered = useMemo(() => (source ? availableSections(source) : []), [source]);
  const offeredKey = offered.join(",");
  const requestId = request?.requestId;

  // Reset per request, not on every settings change while the dialog is open.
  useEffect(() => {
    setChosen(new Set(offeredKey ? (offeredKey.split(",") as CompanionSection[]) : []));
    setBusy(false);
  }, [requestId, offeredKey]);

  // Deny is the safe default for a stray Enter from a remote or a gamepad.
  useEffect(() => {
    if (requestId) denyRef.current?.focus();
  }, [requestId]);

  if (!request || !source) return null;

  const answer = async (approved: boolean) => {
    setBusy(true);
    const payload = approved ? buildCompanionPayload(chosen, source) : null;
    await invoke("companion_pair_resolve", {
      requestId: request.requestId,
      approved,
      payload,
    }).catch((e) => console.warn("[companion] resolve failed", e));
    setQueue((cur) => cur.filter((r) => r.requestId !== request.requestId));
  };

  // Big Picture's focus engine stands down for a [data-bp-overlay], so the
  // dialog moves focus itself: arrows step through its controls, Escape denies.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (!busy) void answer(false);
      return;
    }
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>("input, button:not([disabled])"),
    );
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = items[(at + step + items.length) % items.length];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  const toggle = (section: CompanionSection) =>
    setChosen((cur) => {
      const next = new Set(cur);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });

  return createPortal(
    <div
      data-bp-overlay
      className="fixed inset-0 z-[230] flex items-center justify-center bg-black/60 px-6 animate-fade-in"
    >
      <div
        role="dialog"
        aria-modal="true"
        onKeyDown={onKeyDown}
        aria-label={t("Allow this device?")}
        className="w-full max-w-md rounded-2xl border border-edge bg-surface p-6 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)] animate-modal-in"
      >
        <div className="flex items-start gap-3.5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-elevated text-ink">
            <MonitorSmartphone size={20} strokeWidth={2} />
          </span>
          <div className="flex flex-col gap-1.5">
            <h2 className="text-[17px] font-semibold text-ink">
              {t("Allow {name} to pair?", { name: request.deviceName })}
            </h2>
            <p className="text-[14px] leading-relaxed text-ink-muted">
              {t("Only approve if this code matches the one on the device.")}
            </p>
          </div>
        </div>
        <div className="mt-5 text-center font-mono text-[40px] font-semibold tracking-[0.3em] text-ink">
          {request.code}
        </div>
        {offered.length > 0 && (
          <fieldset className="mt-5 flex flex-col gap-2">
            <legend className="mb-1 text-[13px] font-semibold text-ink-muted">
              {t("Send to the device")}
            </legend>
            {offered.map((section) => (
              <label key={section} className="flex items-center gap-2.5 text-[14px] text-ink">
                <input
                  type="checkbox"
                  checked={chosen.has(section)}
                  onChange={() => toggle(section)}
                />
                {t(SECTION_LABELS[section])}
              </label>
            ))}
          </fieldset>
        )}
        <div className="mt-6 flex items-center justify-end gap-2.5">
          <button
            ref={denyRef}
            type="button"
            disabled={busy}
            onClick={() => void answer(false)}
            className="inline-flex h-11 items-center rounded-xl border border-edge px-5 text-[14px] font-semibold text-ink-muted transition-colors hover:text-ink"
          >
            {t("Deny")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void answer(true)}
            className="inline-flex h-11 items-center rounded-xl bg-ink px-5 text-[14px] font-semibold text-canvas transition-transform hover:scale-[1.02] active:scale-[0.98]"
          >
            {t("Approve")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
