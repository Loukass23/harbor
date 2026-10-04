import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Meta } from "@/lib/cinemeta";
import { BpTile, type BpTileShape } from "./bp-tile";

/**
 * Phase 1 — virtualized Big Picture row for Tizen 9.0.
 *
 * The default BpRow mounts `shown` tiles per row and keeps every mounted tile
 * alive forever. On a 4-row viewport that is fine; on a 20-row home screen it
 * blows past Tizen's strict WebKit memory ceiling and every later D-pad move
 * pays style+layout over hundreds of off-screen nodes.
 *
 * This row renders a fixed window around the focused index (overscan 2 on each
 * side), positions it with a GPU-only `translate3d` track offset, and
 * aggressively unmounts cells outside the window. Item widths are fixed per
 * shape so no measurement pass is needed on the main thread.
 *
 * Backed by the same Meta[] shape as BpRow so server payloads need no
 * client-side transformation (Phase 3 flat /api/tv/home rows drop in).
 */

const POSTER_W = 180;
const RANK_W = 240;
const GAP = 14;
const OVERSCAN = 2;

function itemWidth(shape: BpTileShape): number {
  return shape === "rank" ? RANK_W : POSTER_W;
}

type Props = {
  title: string;
  metas: Meta[];
  shape?: BpTileShape;
  onSelect: (meta: Meta) => void;
  autofocusFirst?: boolean;
  focusIndex?: number;
  onFocusIndex?: (index: number) => void;
};

export const BpVirtualRow = memo(function BpVirtualRow({
  title,
  metas,
  shape = "poster",
  onSelect,
  autofocusFirst,
  focusIndex,
  onFocusIndex,
}: Props) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [innerFocus, setInnerFocus] = useState(autofocusFirst ? 0 : -1);
  const [viewportW, setViewportW] = useState(1140);
  const active = focusIndex ?? innerFocus;

  const width = itemWidth(shape);
  const stride = width + GAP;

  const visibleCount = useMemo(
    () => Math.max(4, Math.ceil(viewportW / stride) + OVERSCAN * 2),
    [viewportW, stride],
  );

  const start = useMemo(() => {
    if (active < 0) return 0;
    return Math.max(0, Math.min(metas.length - visibleCount, active - OVERSCAN));
  }, [active, metas.length, visibleCount]);
  const end = Math.min(metas.length, start + visibleCount);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const measure = () => setViewportW(el.clientWidth || 1140);
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  if (metas.length === 0) return null;

  const offsetX = -(start * stride);

  return (
    <section data-bp-row data-bp-virtual-row aria-label={title} className="relative">
      <div className="px-[var(--bp-gutter)] pt-[clamp(12px,1.5vh,24px)]">
        <h2 className="text-[22px] font-bold text-[var(--color-ink)]">{title}</h2>
      </div>
      {/* Outer viewport clips; inner track moves on the compositor only. */}
      <div ref={trackRef} data-bp-scroll-x className="overflow-hidden px-[var(--bp-gutter)]">
        <div
          className="bp-virtual-track flex"
          style={{
            gap: GAP,
            transform: `translate3d(${offsetX}px, 0, 0)`,
            willChange: "transform",
          }}
        >
          {metas.slice(start, end).map((m, i) => {
            const index = start + i;
            return (
              <div
                key={`${m.id}-${index}`}
                data-bp-focusable={index === active ? "true" : undefined}
                onFocus={() => {
                  setInnerFocus(index);
                  onFocusIndex?.(index);
                }}
                style={{ width, flex: "none" }}
              >
                <BpTile
                  meta={m}
                  shape={shape}
                  rank={shape === "rank" ? index + 1 : undefined}
                  onSelect={onSelect}
                  autofocus={autofocusFirst && index === 0}
                />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
});
