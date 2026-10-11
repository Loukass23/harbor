import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useT } from "@/lib/i18n";
import { ROW_ACTION_DANGER, ROW_DESC, SettingRow } from "../kit";
import { Section } from "../shared";

type PairedDevice = { deviceId: string; name: string; pairedAt: number };

/**
 * Devices that paired from the LAN (a TV that found this computer). Forgetting
 * one revokes its token; it can pair again from the device.
 */
export function PairedDevicesSection({ enabled }: { enabled: boolean }) {
  const t = useT();
  const [devices, setDevices] = useState<PairedDevice[]>([]);

  const refresh = useCallback(() => {
    void invoke<PairedDevice[]>("companion_paired_list")
      .then(setDevices)
      .catch(() => setDevices([]));
  }, []);

  useEffect(() => {
    refresh();
    let off: (() => void) | null = null;
    let cancelled = false;
    void listen("companion://paired-changed", refresh).then((f) => (cancelled ? f() : (off = f)));
    return () => {
      cancelled = true;
      off?.();
    };
  }, [refresh]);

  const forget = (deviceId: string) => {
    void invoke("companion_forget", { deviceId }).finally(refresh);
  };

  return (
    <Section
      title={t("Paired devices")}
      subtitle={t(
        "TVs running Harbor find this computer while it's served on your network, then ask to pair. You approve each one here with a code.",
      )}
    >
      {!enabled && (
        <p className={`max-w-[70ch] ${ROW_DESC}`}>
          {t("Turn on serving above so TVs can find this computer.")}
        </p>
      )}
      {devices.length === 0 ? (
        <p className={`max-w-[70ch] ${ROW_DESC}`}>{t("No devices paired yet.")}</p>
      ) : (
        devices.map((d) => (
          <SettingRow
            key={d.deviceId}
            label={d.name}
            desc={t("Paired {date}", {
              date: new Date(d.pairedAt * 1000).toLocaleDateString(),
            })}
          >
            <button type="button" className={ROW_ACTION_DANGER} onClick={() => forget(d.deviceId)}>
              {t("Forget")}
            </button>
          </SettingRow>
        ))
      )}
    </Section>
  );
}
