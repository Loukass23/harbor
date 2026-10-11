import { useEffect, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { useSettings } from "@/lib/settings";
import { normalizeStreamServerUrl, probeStremioServer } from "@/lib/stremio-server";
import { SFX } from "@/lib/sfx";
import { useBpT } from "./bp-i18n";
import { BpOnboardField } from "./onboarding/bp-onboard-field";

type Reach = "off" | "checking" | "connected" | "unreachable";

const STATUS: Record<Reach, { label: string; tone: string }> = {
  off: { label: "Not set", tone: "text-ink-subtle" },
  checking: { label: "Checking", tone: "text-ink-subtle" },
  connected: { label: "Connected", tone: "text-success" },
  unreachable: { label: "Unreachable", tone: "text-danger" },
};

const CHIP =
  "flex h-[clamp(48px,6.8vh,80px)] items-center rounded-[var(--bp-r-md)] border px-[clamp(22px,2vw,40px)] text-[clamp(17px,2.2vh,24px)] font-semibold";

/**
 * The same remoteStreamServerUrl the desktop player settings edit, for screens
 * with no desktop settings to reach. Rows are numbered from 0 with no gaps, as
 * bpRailStep treats a missing index as the end of the rail.
 */
export function BpStreamServer({ onBack }: { onBack: () => void }) {
  const t = useBpT();
  const { settings, update } = useSettings();
  const saved = settings.remoteStreamServerUrl;
  const [draft, setDraft] = useState(saved);
  const [reach, setReach] = useState<Reach>(saved ? "checking" : "off");
  const next = normalizeStreamServerUrl(draft);
  const dirty = next !== saved;
  const pending = useRef({ next, dirty, update });
  pending.current = { next, dirty, update };

  // On a TV, Back closes the keyboard and this pane in one press, so a typed
  // address would be lost if only OK or Save kept it. Leaving keeps the draft,
  // the way the desktop field commits on blur.
  useEffect(
    () => () => {
      const { next: value, dirty: unsaved, update: write } = pending.current;
      if (unsaved) write({ remoteStreamServerUrl: value });
    },
    [],
  );

  useEffect(() => {
    if (!saved) {
      setReach("off");
      return;
    }
    let alive = true;
    setReach("checking");
    void probeStremioServer(true, saved).then((ok) => {
      if (alive) setReach(ok ? "connected" : "unreachable");
    });
    return () => {
      alive = false;
    };
  }, [saved]);

  const save = () => {
    if (!dirty) return;
    SFX.click();
    setDraft(next);
    update({ remoteStreamServerUrl: next });
  };

  const forget = () => {
    SFX.click();
    setDraft("");
    update({ remoteStreamServerUrl: "" });
  };

  const status = STATUS[reach];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[clamp(8px,1.6vh,26px)]">
      <div data-bp-row data-bp-rail-row="0">
        <button
          type="button"
          data-bp-focusable
          data-bp-chip
          data-bp-autofocus="true"
          data-bp-restore-key="bp-stream-server-back"
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
          {t("Remote streaming server")}
        </h2>
        <p className="max-w-[70ch] text-[clamp(17px,2.3vh,22px)] font-medium leading-snug text-ink-subtle">
          {t(
            "Point Harbor at a streaming server on another machine, like the Stremio service on a home server. P2P streams download and play from that machine instead of this one.",
          )}
        </p>
      </div>

      <div data-bp-rail-row="1">
        <BpOnboardField
          label={t("Server address")}
          value={draft}
          placeholder="http://192.168.1.50:11470"
          onChange={setDraft}
          onSubmit={save}
        />
      </div>

      <div
        data-bp-row
        data-bp-rail-row="2"
        className="flex items-center gap-[clamp(9px,0.9vw,16px)]"
      >
        <button
          type="button"
          data-bp-focusable
          data-bp-chip
          disabled={!dirty}
          onClick={save}
          // Never a resting --bp-touch fill: the focused chip already uses it.
          className={`${CHIP} ${
            dirty
              ? "border-transparent bg-[var(--bp-on)] text-ink"
              : "border-[var(--bp-edge-2)] bg-[var(--bp-panel)] text-ink-subtle"
          }`}
        >
          {t("Save")}
        </button>
        {saved && (
          <button
            type="button"
            data-bp-focusable
            data-bp-chip
            onClick={forget}
            className={`${CHIP} border-[var(--bp-edge-2)] bg-[var(--bp-panel)] text-ink`}
          >
            {t("Forget")}
          </button>
        )}
        <span
          role="status"
          aria-live="polite"
          className={`text-[clamp(15px,1.9vh,18px)] font-semibold ${status.tone}`}
        >
          {t(status.label)}
        </span>
      </div>
    </div>
  );
}
