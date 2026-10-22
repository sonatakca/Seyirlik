import { useSyncExternalStore } from "react";
import { RefreshCw } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { move, settle } from "../lib/compositorMotion";
import { useLanguage } from "../i18n/LanguageContext";
import {
  applyAppUpdate,
  getAppUpdateState,
  subscribeToAppUpdate,
} from "../lib/appVersion/appUpdate";
import { formatBuildLabel } from "../lib/appVersion/buildInfo";
import { Tooltip } from "./ui/Tooltip";

interface AppUpdateButtonProps {
  variant?: "desktop" | "mobile";
}

/** Shown only while a newer build of the site is live than the one running. */
export function AppUpdateButton({ variant = "desktop" }: AppUpdateButtonProps) {
  const { t, language } = useLanguage();
  const shouldReduceMotion = useReducedMotion();
  const update = useSyncExternalStore(
    subscribeToAppUpdate,
    getAppUpdateState,
    getAppUpdateState,
  );
  const applying = update.status === "applying";
  const label = applying ? t("appUpdate.applying") : t("appUpdate.available");
  const isDesktop = variant === "desktop";

  return (
    <AnimatePresence initial={false}>
      {update.status === "current" ? null : (
        <motion.div
          key="app-update"
          initial={
            shouldReduceMotion
              ? { opacity: 0 }
              : { opacity: 0, transform: move({ scale: 0.9 }) }
          }
          animate={{ opacity: 1, ...(shouldReduceMotion ? {} : settle) }}
          exit={{ opacity: 0 }}
          transition={{ type: "spring", bounce: 0, duration: 0.3 }}
        >
          <Tooltip
            content={`${t("appUpdate.tooltip")} (${formatBuildLabel(update.latest, language)})`}
          >
            <button
              type="button"
              onClick={() => void applyAppUpdate()}
              disabled={applying}
              aria-label={isDesktop ? undefined : label}
              className={
                isDesktop
                  ? "inline-flex min-h-9 items-center gap-2 rounded-full bg-[var(--accent)] px-3.5 text-sm font-bold text-[var(--accent-label)] transition-[background-color,opacity] duration-200 hover:bg-[var(--accent-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2 focus:ring-offset-black disabled:opacity-70 sm:min-h-10"
                  : "inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-label)] disabled:opacity-70"
              }
            >
              <RefreshCw
                size={isDesktop ? 16 : 17}
                aria-hidden="true"
                className={`shrink-0 ${applying ? "motion-safe:animate-spin" : ""}`}
              />
              {isDesktop ? <span>{label}</span> : null}
            </button>
          </Tooltip>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
