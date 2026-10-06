import { useEffect, type RefObject } from "react";
import type { PlayerBridge } from "@/lib/player/bridge";
import { notifyMediaSeeked } from "@/lib/media-session";

export function usePendingSeekApply(params: {
  pendingSeekSec: number | null;
  clearPendingSeek: () => void;
  durationSec: number;
  bridgeRef: RefObject<PlayerBridge | null>;
  inRoomRef: RefObject<boolean>;
}) {
  const { pendingSeekSec, clearPendingSeek, durationSec, bridgeRef, inRoomRef } = params;
  useEffect(() => {
    if (pendingSeekSec == null) return;
    const b = bridgeRef.current;
    if (!b) return;
    const target = pendingSeekSec;
    clearPendingSeek();
    const t =
      durationSec > 0
        ? target <= 5 || target >= durationSec - 20
          ? 0
          : Math.min(target, durationSec - 1)
        : target <= 5
          ? 0
          : target;
    b.seek(t);
    notifyMediaSeeked(t);
    if (!inRoomRef.current) b.play().catch(() => {});
  }, [pendingSeekSec, durationSec, clearPendingSeek, bridgeRef, inRoomRef]);
}
