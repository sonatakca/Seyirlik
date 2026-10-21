import { useId } from "react";
import { useLanguage } from "../../../i18n/LanguageContext";
import {
  setAdminDockHidden,
  useAdminDockHidden,
} from "../../../lib/adminDockPreference";

/**
 * The way back to the admin dock, and the way to watch without it.
 *
 * Lives beside every DevTools page rather than on the title pages themselves:
 * a switch to bring the dock back cannot sit inside the dock it brings back.
 */
export function AdminDockSwitch() {
  const { t } = useLanguage();
  const hidden = useAdminDockHidden();
  const labelId = useId();
  const descriptionId = useId();
  const on = !hidden;

  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-3">
        <p
          id={labelId}
          className="min-w-0 flex-1 text-sm font-bold text-white/80"
        >
          {t("titleDock.setting.label")}
        </p>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          onClick={() => setAdminDockHidden(on)}
          className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-black ${
            on ? "bg-[var(--accent)]" : "bg-white/15"
          }`}
        >
          <span
            aria-hidden="true"
            className={`h-5 w-5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.45)] transition-transform duration-150 ease-out ${
              on ? "translate-x-[1.125rem]" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>
      <p
        id={descriptionId}
        className="mt-1 text-xs font-medium leading-5 text-white/40"
      >
        {t("titleDock.setting.description")}
      </p>
    </div>
  );
}
