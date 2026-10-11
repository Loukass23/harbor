import { useEffect, useRef } from "react";
import { setBpFocus } from "@/views/big-picture/use-bp-focus";
import { ChevronLeft } from "lucide-react";
import { SFX } from "@/lib/sfx";
import type { BpOnboardStepProps } from "@/views/big-picture/bp-onboarding-frame";
import { useBpT } from "@/views/big-picture/bp-i18n";
import { BpOnboardAux } from "@/views/big-picture/onboarding/bp-onboard-aux";
import {
  BpDecisionAction,
  BpDecisionNote,
  BpDecisionRow,
  BpDecisionScroll,
  BpStepConfirmed,
} from "@/views/big-picture/onboarding/bp-step-parts";
import type { Found } from "./discovery";
import { useCompanion, type CompanionPhase } from "./use-companion";

type T = ReturnType<typeof useBpT>;

const CHIP =
  "flex h-[clamp(48px,6.8vh,80px)] items-center rounded-[var(--bp-r-md)] border px-[clamp(22px,2vw,40px)] text-[clamp(17px,2.2vh,24px)] font-semibold";

function statusText(t: T, phase: CompanionPhase, found: number): string {
  switch (phase.kind) {
    case "scanning":
      return found > 0
        ? t("Still looking. {count} found so far.", { count: found })
        : t("Looking for Harbor on your network.");
    case "noNetwork":
      return t("This TV has no network address Harbor can scan from.");
    case "waiting":
      return t("On {name}, approve the request showing this code.", {
        name: phase.target.identity.name,
      });
    case "paired":
      return phase.serverUrl
        ? t("Paired with {name}. Torrents stream through it.", { name: phase.name })
        : t(
            "Paired with {name}. Its streaming server did not start, so torrents need it running.",
            {
              name: phase.name,
            },
          );
    case "server":
      return t("Torrents stream through {url}.", { url: phase.url });
    case "failed":
      return {
        denied: t("The computer turned the request down."),
        expired: t("Nobody answered on the computer in time. Try again."),
        unreachable: t("That computer did not answer."),
        busy: t("That computer has other requests waiting. Try again in a minute."),
        invalid: t("That computer runs a Harbor too old to pair. Update it and try again."),
      }[phase.reason];
    case "idle":
      return found > 0
        ? t("Pick a computer to pair with, or a streaming server to use.")
        : t(
            "Nothing found. On your computer, open Harbor, then Settings, Remotes, and turn on Serve Harbor on your network.",
          );
  }
}

function foundLabel(t: T, f: Found): { title: string; detail: string } {
  return f.kind === "harbor"
    ? {
        title: f.identity.name,
        detail: t("Harbor {version} at {host}", { version: f.identity.version, host: f.host }),
      }
    : { title: t("Streaming server"), detail: f.host };
}

/**
 * Pressing a found computer unmounts its row, which would drop the ring onto
 * the back chip, and the next OK would leave mid-pairing. Cancel takes it
 * instead. The onboarding Cancel is portaled a frame later, hence the retry.
 */
function useFocusWhileWaiting(waiting: boolean) {
  const ref = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!waiting) return;
    let frame = 0;
    const place = (tries: number) => {
      if (setBpFocus(ref.current, { silent: true }) || tries <= 0) return;
      frame = requestAnimationFrame(() => place(tries - 1));
    };
    place(5);
    return () => cancelAnimationFrame(frame);
  }, [waiting]);
  return ref;
}

function Code({ code }: { code: string }) {
  return (
    <div
      aria-live="polite"
      className="font-mono text-[clamp(48px,9vh,110px)] font-semibold leading-none tracking-[0.3em] text-ink"
    >
      {code}
    </div>
  );
}

/** Settings, Setup: find the computer, pair, or forget it. */
export function CompanionPane({ onBack }: { onBack: () => void }) {
  const t = useBpT();
  const c = useCompanion();
  const { phase, found, saved, scan } = c;
  const cancelRef = useFocusWhileWaiting(phase.kind === "waiting");

  useEffect(() => {
    if (!saved) void scan();
    // Once, on open. A paired TV searches only when asked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  let row = 1;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[clamp(8px,1.6vh,26px)]">
      <div data-bp-row data-bp-rail-row="0">
        <button
          type="button"
          data-bp-focusable
          data-bp-chip
          data-bp-autofocus="true"
          data-bp-restore-key="bp-companion-back"
          onClick={() => {
            SFX.close();
            onBack();
          }}
          className="flex h-[clamp(48px,7vh,68px)] items-center gap-[clamp(7px,0.7vw,12px)] rounded-[var(--bp-r-md)] border border-[var(--bp-edge-2)] px-[clamp(16px,1.5vw,28px)] text-[clamp(17px,2.2vh,22px)] font-bold text-ink"
        >
          <ChevronLeft size={20} strokeWidth={2.4} />
          {t("Settings")}
        </button>
      </div>

      <div className="flex flex-col gap-[clamp(4px,0.6vh,9px)]">
        <h2 className="font-display text-[clamp(30px,3.9vh,40px)] font-semibold leading-tight text-ink">
          {t("Pair with a computer")}
        </h2>
        <p className="max-w-[70ch] text-[clamp(17px,2.3vh,22px)] font-medium leading-snug text-ink-subtle">
          {t(
            "Harbor on a computer on the same network can stream torrents to this TV and send over your accounts, keys and addons. Nothing to type.",
          )}
        </p>
      </div>

      {saved && phase.kind !== "waiting" && (
        <p className="text-[clamp(17px,2.2vh,22px)] font-semibold text-ink">
          {t("Paired with {name}", { name: saved.name })}
        </p>
      )}

      {phase.kind === "waiting" && <Code code={phase.code} />}

      <p
        role="status"
        className="max-w-[70ch] text-[clamp(15px,1.9vh,19px)] font-semibold text-ink-subtle"
      >
        {statusText(t, phase, found.length)}
      </p>

      <div
        data-bp-row
        data-bp-rail-row={row++}
        className="flex items-center gap-[clamp(9px,0.9vw,16px)]"
      >
        {phase.kind === "waiting" ? (
          <button
            ref={cancelRef}
            type="button"
            data-bp-focusable
            data-bp-chip
            onClick={() => {
              SFX.close();
              c.cancel();
            }}
            className={`${CHIP} border-[var(--bp-edge-2)] bg-[var(--bp-panel)] text-ink`}
          >
            {t("Cancel")}
          </button>
        ) : (
          <button
            type="button"
            data-bp-focusable
            data-bp-chip
            onClick={() => {
              SFX.click();
              void scan();
            }}
            className={`${CHIP} border-[var(--bp-edge-2)] bg-[var(--bp-panel)] text-ink`}
          >
            {phase.kind === "scanning" ? t("Searching") : t("Search again")}
          </button>
        )}
        {saved && phase.kind !== "waiting" && (
          <button
            type="button"
            data-bp-focusable
            data-bp-chip
            onClick={() => {
              SFX.click();
              c.forget();
            }}
            className={`${CHIP} border-[var(--bp-edge-2)] bg-[var(--bp-panel)] text-ink`}
          >
            {t("Forget")}
          </button>
        )}
      </div>

      {phase.kind !== "waiting" &&
        found.map((f) => {
          const label = foundLabel(t, f);
          return (
            <div key={`${f.kind}:${f.host}`} data-bp-row data-bp-rail-row={row++}>
              <button
                type="button"
                data-bp-focusable
                data-bp-chip
                onClick={() => {
                  SFX.click();
                  if (f.kind === "harbor") void c.pair(f);
                  else c.chooseServer(f.url);
                }}
                className="flex w-full max-w-[70ch] flex-col items-start gap-1 rounded-[var(--bp-r-md)] border border-[var(--bp-edge-2)] bg-[var(--bp-panel)] px-[clamp(18px,1.7vw,34px)] py-[clamp(12px,1.6vh,22px)] text-start"
              >
                <span className="text-[clamp(17px,2.3vh,24px)] font-semibold text-ink">
                  {label.title}
                </span>
                <span className="text-[clamp(14px,1.8vh,19px)] font-medium text-ink-subtle">
                  {label.detail}
                </span>
              </button>
            </div>
          );
        })}
    </div>
  );
}

/** Onboarding: takes the phone step's slot on a TV that serves no phone pages. */
export function CompanionStep({ setSatisfied }: BpOnboardStepProps) {
  const t = useBpT();
  const c = useCompanion();
  const { phase, found, saved, scan } = c;
  const cancelRef = useFocusWhileWaiting(phase.kind === "waiting");
  const done = phase.kind === "paired" || phase.kind === "server";

  useEffect(() => {
    setSatisfied(done);
  }, [done, setSatisfied]);

  useEffect(() => {
    void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <BpDecisionScroll bottom>
      {phase.kind === "paired" || phase.kind === "server" ? (
        <BpStepConfirmed
          title={
            phase.kind === "paired"
              ? t("Paired with {name}", { name: phase.name })
              : t("Streaming server set")
          }
          detail={statusText(t, phase, found.length)}
        />
      ) : (
        <>
          {phase.kind === "waiting" && <Code code={phase.code} />}
          {phase.kind !== "waiting" &&
            found.map((f) => {
              const label = foundLabel(t, f);
              return (
                <BpDecisionRow key={`${f.kind}:${f.host}`}>
                  <BpDecisionAction
                    label={`${label.title} · ${label.detail}`}
                    tone={f.kind === "harbor" ? "solid" : "quiet"}
                    onSelect={() => (f.kind === "harbor" ? void c.pair(f) : c.chooseServer(f.url))}
                  />
                </BpDecisionRow>
              );
            })}
          <BpDecisionNote
            text={statusText(t, phase, found.length)}
            alert={phase.kind === "failed" || phase.kind === "noNetwork"}
          />
        </>
      )}

      {saved && !done && phase.kind !== "waiting" && (
        <BpDecisionNote text={t("Paired with {name}", { name: saved.name })} />
      )}

      {phase.kind === "waiting" ? (
        <BpOnboardAux>
          <BpDecisionAction
            label={t("Cancel")}
            tone="quiet"
            onSelect={c.cancel}
            buttonRef={cancelRef}
          />
        </BpOnboardAux>
      ) : (
        !done &&
        phase.kind !== "scanning" && (
          <BpOnboardAux>
            <BpDecisionAction label={t("Search again")} tone="quiet" onSelect={() => void scan()} />
          </BpOnboardAux>
        )
      )}
    </BpDecisionScroll>
  );
}
