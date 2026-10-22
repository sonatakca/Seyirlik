import { useEffect } from "react";
import { useLanguage } from "../i18n/LanguageContext";
import { beginLoadingActivity } from "../lib/loadingActivity";
import { LoadingRing } from "./LoadingRing";

interface LoadingSpinnerProps {
  label?: string;
  className?: string;
}

export function LoadingSpinner({ label, className }: LoadingSpinnerProps) {
  const { t } = useLanguage();
  const displayLabel = label ?? t("common.loading");
  const accessibleLabel = displayLabel || t("common.loading");

  // A spinner on screen is something loading, including a lazy route's fallback.
  useEffect(() => beginLoadingActivity(), []);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={accessibleLabel}
      className={`flex min-h-48 flex-col items-center justify-center text-2xl font-semibold ${className ?? "text-white/70"} ${
        displayLabel ? "gap-3" : ""
      }`}
    >
      <LoadingRing />
      {displayLabel ? <span aria-hidden="true">{displayLabel}</span> : null}
    </div>
  );
}
