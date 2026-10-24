import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  LogOut,
  Palette,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { move, REST, settle } from "../lib/compositorMotion";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useLanguage } from "../i18n/LanguageContext";
import { RUNNING_BUILD } from "../lib/appVersion/appUpdate";
import { formatBuildLabel } from "../lib/appVersion/buildInfo";
import { clearAuthSession, getCachedSession } from "../lib/authStorage";
import { isOfflineSupported } from "../lib/offline/offlineLibrary";
import { ROUTE_COLOR_TRANSITION_FORCE_EVENT } from "./RouteColorTransition";
import type { Language } from "../i18n/translations";

const ITEM =
  "flex w-full items-center gap-3 rounded-full px-3 py-2 text-left text-sm font-bold text-white/72 transition-[background-color,color] duration-150 ease-out hover:bg-white/[0.09] hover:text-white focus-visible:bg-white/[0.09] focus-visible:text-white focus-visible:outline-none";

const MENU_ITEMS = '[role="menuitem"], [role="menuitemradio"]';

// Each language in its own name: whoever is looking for the other one may
// not read the one the interface is in.
const LANGUAGES: { value: Language; flag: string; name: string }[] = [
  { value: "tr", flag: "fi-tr", name: "Türkçe" },
  { value: "en", flag: "fi-gb", name: "English" },
];

interface AccountMenuProps {
  variant?: "desktop" | "mobile";
  /** Called on every press of the trigger, before the menu toggles. */
  onTriggerClick?: () => void;
}

/**
 * Everything about the person rather than the library: downloads,
 * administration, theme, language and logout. They were loose icons in the
 * bar, and logout was one stray tap from any page. Notifications have their
 * own bell beside it (NotificationCenter).
 */
export function AccountMenu({
  variant = "desktop",
  onTriggerClick,
}: AccountMenuProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const session = getCachedSession();
  const { t, language, setLanguage } = useLanguage();
  const shouldReduceMotion = useReducedMotion();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // The page the menu was opened on; navigating anywhere else closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  // Forget it as soon as the page changes. Merely not matching hid the menu
  // without closing it, so coming back to that page reopened it unasked.
  if (openOn !== null && openOn !== location.pathname) {
    setOpenOn(null);
  }
  const isOpen = openOn === location.pathname;
  const setIsOpen = (open: boolean) =>
    setOpenOn(open ? location.pathname : null);
  const isDesktop = variant === "desktop";

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    menuRef.current
      ?.querySelector<HTMLElement>(MENU_ITEMS)
      ?.focus({ preventScroll: true });

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;

      if (target instanceof Node && !rootRef.current?.contains(target)) {
        setOpenOn(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenOn(null);
        triggerRef.current?.focus();
        return;
      }

      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
        return;
      }

      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLElement>(MENU_ITEMS) ?? [],
      );
      const index = items.indexOf(document.activeElement as HTMLElement);
      const step = event.key === "ArrowDown" ? 1 : -1;

      event.preventDefault();
      items[(index + step + items.length) % items.length]?.focus();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  if (!session) {
    return null;
  }

  const handleThemeChange = () => {
    setIsOpen(false);
    window.dispatchEvent(new Event(ROUTE_COLOR_TRANSITION_FORCE_EVENT));
  };

  const handleLogout = () => {
    clearAuthSession();
    navigate("/login", { replace: true });
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label={`${t("nav.account")}: ${session.username}`}
        onClick={() => {
          onTriggerClick?.();
          setIsOpen(!isOpen);
        }}
        className={
          isDesktop
            ? "inline-flex min-h-9 max-w-40 items-center justify-center gap-2 rounded-full px-2.5 text-sm font-semibold text-white/72 transition-[background-color,color] duration-200 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2 focus:ring-offset-black sm:min-h-10 lg:px-3 [-webkit-tap-highlight-color:transparent]"
            : "inline-flex h-9 w-9 items-center justify-center rounded-full text-white/72 transition hover:bg-white/10 hover:text-white"
        }
      >
        <UserRound
          size={isDesktop ? 17 : 18}
          className="navbar-ink-shadow shrink-0"
        />
        {isDesktop ? (
          <span className="navbar-ink-shadow hidden min-w-0 truncate lg:inline">
            {session.username}
          </span>
        ) : null}
      </button>

      <AnimatePresence>
        {isOpen ? (
          // Unfolds from the corner it hangs off, like the season picker.
          <motion.div
            ref={menuRef}
            key="account-menu"
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
            aria-label={t("nav.account")}
            className="absolute right-0 top-full z-[70] mt-2 w-max min-w-[14.5rem] rounded-2xl border border-white/10 bg-[#171719]/95 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.055),inset_0_-1px_0_rgba(0,0,0,0.28),0_10px_35px_rgba(0,0,0,0.28)] backdrop-blur-2xl"
          >
            <p className="truncate px-3 pb-2 pt-1.5 text-xs font-semibold text-white/50">
              {session.username}
            </p>
            {isOfflineSupported() ? (
              <Link to="/downloads" role="menuitem" className={ITEM}>
                <ArrowDownToLine size={16} className="shrink-0" />
                {t("downloads.title")}
              </Link>
            ) : null}
            {session.isAdministrator ? (
              <Link to="/admin" role="menuitem" className={ITEM}>
                <ShieldCheck size={16} className="shrink-0" />
                {t("admin.entry")}
              </Link>
            ) : null}
            <div aria-hidden="true" className="mx-3 my-1 h-px bg-white/10" />
            <button
              type="button"
              role="menuitem"
              onClick={handleThemeChange}
              className={ITEM}
            >
              <Palette size={16} className="shrink-0" />
              {t("nav.changeTheme")}
            </button>
            {/* Both languages in view, so the choice reads as where you are
                and where you could be, not a flag that means "the other one". */}
            <div
              role="group"
              aria-label={t("nav.language")}
              className="relative mx-1 mb-1 mt-0.5 grid grid-cols-2 rounded-full bg-white/[0.05] p-1"
            >
              <span
                aria-hidden="true"
                className="absolute bottom-1 left-1 top-1 w-[calc(50%-0.25rem)] rounded-full bg-white/[0.12] shadow-[0_1px_3px_rgba(0,0,0,0.4)] transition-transform duration-300 ease-[cubic-bezier(0.37,0,0.63,1)] motion-reduce:transition-none"
                style={{
                  transform:
                    language === LANGUAGES[0].value
                      ? "translateX(0)"
                      : "translateX(100%)",
                }}
              />
              {LANGUAGES.map((option) => {
                const isCurrent = option.value === language;

                return (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isCurrent}
                    lang={option.value}
                    onClick={() => setLanguage(option.value)}
                    className={`relative flex items-center justify-center gap-2 rounded-full px-3 py-1.5 text-[0.8125rem] font-bold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                      isCurrent
                        ? "text-white"
                        : "text-white/55 hover:text-white/85"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`fi ${option.flag} block h-3 w-4 shrink-0 rounded-[2px] transition-opacity duration-200 ${
                        isCurrent ? "opacity-100" : "opacity-60"
                      }`}
                    />
                    {option.name}
                  </button>
                );
              })}
            </div>
            <div aria-hidden="true" className="mx-3 my-1 h-px bg-white/10" />
            <button
              type="button"
              role="menuitem"
              onClick={handleLogout}
              className={ITEM}
            >
              <LogOut size={16} className="shrink-0" />
              {t("nav.logout")}
            </button>
            {/* What this release changed, then which build it is. */}
            {RUNNING_BUILD.note ? (
              <p className="px-3 pt-2 text-xs font-semibold text-white/70">
                {RUNNING_BUILD.note[language]}
              </p>
            ) : null}
            <p
              className={`px-3 pb-1 text-[0.6875rem] font-medium tabular-nums text-white/40 ${
                RUNNING_BUILD.note ? "pt-0.5" : "pt-2"
              }`}
              title={RUNNING_BUILD.commit ?? undefined}
            >
              {t("appUpdate.version")}{" "}
              {formatBuildLabel(RUNNING_BUILD, language)}
            </p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
