import { useRef, type KeyboardEvent } from "react";
import { useLanguage } from "../../i18n/LanguageContext";
import { LIBRARY_GROUPS, type LibraryGroupId } from "./libraryModel";

const TABLIST_LOOK =
  "gap-1 rounded-full bg-[rgb(23_23_25/0.75)] p-1 shadow-[0_0_0_1px_rgba(255,255,255,0.06),inset_0_1px_0_rgba(255,255,255,0.12),inset_0_-1px_0_rgba(0,0,0,0.3),0_10px_35px_rgba(0,0,0,0.28)] backdrop-blur-2xl";

const tabShape = (fill: boolean) =>
  `${fill ? "flex-auto gap-1.5 px-2.5 max-[359px]:text-xs" : "gap-2 px-4"} flex h-10 items-center justify-center whitespace-nowrap rounded-full text-sm font-black`;

interface LibraryGroupTabsProps {
  activeGroup: LibraryGroupId;
  /** How many of the current search's results sit under each tab. */
  counts: Record<LibraryGroupId, number>;
  onChange: (group: LibraryGroupId) => void;
  /** Share the full width between the tabs, each growing from its label. */
  fill?: boolean;
  className?: string;
}

export function LibraryGroupTabs({
  activeGroup,
  counts,
  onChange,
  fill = false,
  className = "",
}: LibraryGroupTabsProps) {
  const { t } = useLanguage();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Arrow keys move between tabs and select as they go, as a tablist should.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) {
      return;
    }
    event.preventDefault();
    const current = LIBRARY_GROUPS.findIndex(({ id }) => id === activeGroup);
    const next =
      (current + step + LIBRARY_GROUPS.length) % LIBRARY_GROUPS.length;
    onChange(LIBRARY_GROUPS[next].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      onKeyDown={handleKeyDown}
      className={`${fill ? "flex" : "inline-flex"} ${TABLIST_LOOK} ${className}`}
    >
      {LIBRARY_GROUPS.map(({ id, titleKey }, index) => {
        const isSelected = id === activeGroup;
        return (
          <button
            key={id}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            type="button"
            role="tab"
            aria-selected={isSelected}
            tabIndex={isSelected ? 0 : -1}
            onClick={() => onChange(id)}
            className={`${tabShape(fill)} transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30 ${
              isSelected
                ? "bg-white text-zinc-950"
                : "text-white/70 hover:bg-white/[0.09] hover:text-white"
            }`}
          >
            {t(titleKey)}
            <span
              className={`tabular-nums ${
                isSelected ? "text-zinc-950/55" : "text-white/40"
              }`}
            >
              {counts[id]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The tabs while the library loads: the same bar, each tab its own label's
 * width (with room for a two-digit count), so little moves when they come.
 */
export function LibraryGroupTabsSkeleton({
  fill = false,
  className = "",
}: {
  fill?: boolean;
  className?: string;
}) {
  const { t } = useLanguage();
  return (
    <div
      aria-hidden="true"
      className={`${fill ? "flex" : "inline-flex"} ${TABLIST_LOOK} ${className}`}
    >
      {LIBRARY_GROUPS.map(({ id, titleKey }) => (
        <span
          key={id}
          className={`${tabShape(fill)} shimmer text-transparent`}
        >
          {t(titleKey)}
          <span className="tabular-nums">00</span>
        </span>
      ))}
    </div>
  );
}
