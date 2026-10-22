import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { move, REST, settle } from "../lib/compositorMotion";
import { useNavigate } from "react-router-dom";
import { glassPillButton } from "./ui/glassControlStyles";

export interface SeasonPickerOption {
  id: string;
  label: string;
}

interface SeasonPickerProps {
  activeSeasonId?: string;
  currentLabel: string;
  labelContent?: ReactNode;
  options: SeasonPickerOption[];
  selectLabel: string;
  variant?: "desktop" | "mobile";
}

export function SeasonPicker({
  activeSeasonId,
  currentLabel,
  labelContent,
  options,
  selectLabel,
  variant = "desktop",
}: SeasonPickerProps) {
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const shouldReduceMotion = useReducedMotion();
  const isDesktop = variant === "desktop";

  useEffect(() => {
    setIsOpen(false);
  }, [activeSeasonId]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;

      if (target instanceof Node && !rootRef.current?.contains(target)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  const handleSelect = (seasonId: string) => {
    setIsOpen(false);

    if (seasonId !== activeSeasonId) {
      navigate(`/library/${seasonId}`);
    }
  };

  return (
    <div
      ref={rootRef}
      className={
        isDesktop
          ? "relative max-w-[44vw] sm:max-w-none"
          : "relative max-w-[44vw]"
      }
    >
      <button
        type="button"
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label={`${selectLabel}: ${currentLabel}`}
        onClick={() => setIsOpen((current) => !current)}
        className={[
          `group/season-label relative flex w-full items-center overflow-hidden ${glassPillButton}`,
          isDesktop ? "px-3 py-2 sm:min-h-12 sm:px-5 sm:py-3" : "px-3 py-2",
        ].join(" ")}
      >
        <span className="relative flex min-w-0 items-center gap-2">
          <span
            className={
              isDesktop
                ? "truncate text-xl font-black leading-none text-white sm:text-4xl"
                : "truncate text-sm font-black leading-none text-white"
            }
          >
            {labelContent ?? currentLabel}
          </span>
          <ChevronDown
            size={isDesktop ? 18 : 15}
            className={[
              "shrink-0 text-white/65 transition-transform",
              isOpen ? "rotate-180" : "",
            ].join(" ")}
          />
        </span>
      </button>

      <AnimatePresence>
        {isOpen ? (
          // Unfolds from the corner it hangs off, so the menu reads as coming
          // out of the button that opened it.
          <motion.div
            key="season-menu"
            initial={
              shouldReduceMotion
                ? { opacity: 0 }
                : { opacity: 0, transform: move({ y: -6, scale: 0.94 }) }
            }
            animate={{
              opacity: 1,
              ...(shouldReduceMotion ? {} : settle),
              transition: { type: "spring", bounce: 0, duration: 0.32 },
            }}
            exit={{
              opacity: 0,
              ...(shouldReduceMotion
                ? {}
                : { transform: [REST, move({ y: -4, scale: 0.97 })] }),
              transition: { duration: 0.12, ease: [0.4, 0, 1, 1] },
            }}
            style={{ transformOrigin: "100% 0%" }}
            role="menu"
            aria-label={selectLabel}
            className={[
              "absolute right-0 top-full z-[70] mt-2 max-h-64 min-w-full overflow-y-auto rounded-2xl border border-white/10 bg-[#171719]/95 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.055),inset_0_-1px_0_rgba(0,0,0,0.28),0_10px_35px_rgba(0,0,0,0.28)] backdrop-blur-2xl",
              isDesktop ? "w-max min-w-[11rem]" : "w-max min-w-[9rem]",
            ].join(" ")}
          >
            {options.map((option, index) => {
              const isActive = option.id === activeSeasonId;

              return (
                <motion.button
                  initial={
                    shouldReduceMotion
                      ? false
                      : { opacity: 0, transform: move({ x: 8 }) }
                  }
                  animate={{
                    opacity: 1,
                    ...(shouldReduceMotion ? {} : settle),
                    transition: {
                      duration: 0.22,
                      delay: 0.04 + Math.min(index * 0.028, 0.2),
                      ease: [0.22, 1, 0.36, 1],
                    },
                  }}
                  key={option.id}
                  type="button"
                  role="menuitem"
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => handleSelect(option.id)}
                  className={[
                    "flex w-full items-center justify-between gap-3 rounded-full border border-transparent px-3 py-2 text-left text-sm font-bold transition-[background-color,color,transform] duration-150 ease-out hover:bg-white/[0.09] hover:text-white focus-visible:bg-white/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 active:scale-[0.98]",
                    isActive ? "text-white" : "text-white/72",
                  ].join(" ")}
                >
                  <span>{option.label}</span>
                  {isActive ? (
                    <Check
                      className="shrink-0 text-[var(--accent)]"
                      size={15}
                    />
                  ) : null}
                </motion.button>
              );
            })}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
