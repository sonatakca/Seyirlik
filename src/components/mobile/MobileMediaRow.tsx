import { useRef } from "react";
import { AnimatePresence } from "framer-motion";
import { useFlipLayout } from "../../hooks/useFlipLayout";
import type { MediaItem } from "../../lib/types";
import { MobileMediaCard } from "./MobileMediaCard";

interface MobileMediaRowProps {
  title: string;
  items: MediaItem[];
  getItemTo: (item: MediaItem) => string;
  variant?: "poster" | "landscape";
  emptyMessage?: string;
  showRestartWatching?: boolean;
  onClearContinueWatching?: (item: MediaItem) => void;
}

export function MobileMediaRow({
  title,
  items,
  getItemTo,
  variant = "poster",
  emptyMessage,
  showRestartWatching = false,
  onClearContinueWatching,
}: MobileMediaRowProps) {
  const cardsRef = useRef<HTMLDivElement>(null);
  // A cleared card leaves its neighbours to close the gap: a measured FLIP on
  // the compositor, in place of framer-motion's layout projection.
  useFlipLayout(cardsRef, items.map((item) => item.Id).join("|"));

  if (items.length === 0 && !emptyMessage) {
    return null;
  }

  return (
    <section className="py-4">
      <h2 className="mb-3 text-xl font-black tracking-tight text-white">
        {title}
      </h2>

      {items.length > 0 ? (
        <div
          ref={cardsRef}
          className="media-scroll relative -mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2"
        >
          {/* A leaving card steps out of the row at once, so the rest close
              up together with its exit. */}
          <AnimatePresence initial={false} mode="popLayout">
            {items.map((item) => (
              <MobileMediaCard
                key={item.Id}
                item={item}
                to={getItemTo(item)}
                variant={variant}
                showRestartWatching={showRestartWatching}
                animateRemoval={Boolean(onClearContinueWatching)}
                onClearContinueWatching={onClearContinueWatching}
              />
            ))}
          </AnimatePresence>
        </div>
      ) : (
        <p className="rounded-xl border border-white/10 bg-[var(--surface)] p-4 text-sm text-white/60">
          {emptyMessage}
        </p>
      )}
    </section>
  );
}
