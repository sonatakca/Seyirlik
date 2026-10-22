import { NotificationCenter } from "../notifications/NotificationCenter";
import { useNavbarScrolled } from "../../hooks/useNavbarScrolled";
import { Search } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";
import { AccountMenu } from "../AccountMenu";
import { AppUpdateButton } from "../AppUpdateButton";
import { NavbarSurface } from "../NavbarSurface";
import { NavbarWordmark } from "../NavbarWordmark";
import { openSearchOverlay } from "../../lib/searchModel";
import { Tooltip } from "../ui/Tooltip";
import { MobileTabBar } from "./tabBar/MobileTabBar";

export function MobileNavbar() {
  const location = useLocation();
  const { t } = useLanguage();
  const hasScrolled = useNavbarScrolled();

  const headerOverArtwork =
    location.pathname === "/home" ||
    /^\/(?:movies|shows)\/[^/]+(?:\/season\/[^/]+)?$/.test(location.pathname);
  const showHeaderSurface = hasScrolled || !headerOverArtwork;

  return (
    <>
      <header
        // On a tablet the clear bar sits over the floating backdrop, which
        // starts 8px down: its contents drop to the bar's foot to clear it.
        className={`fixed inset-x-0 top-0 z-40 flex h-[calc(3.5rem+env(safe-area-inset-top))] items-end justify-between  px-4 pb-2 pt-[env(safe-area-inset-top)] transition-[padding] duration-300 motion-reduce:transition-none ${
          showHeaderSurface ? "" : "md:pb-0"
        }`}
      >
        <NavbarSurface shown={showHeaderSurface} variant="mobile" />
        <Link
          to="/home"
          aria-label={t("nav.brandHome")}
          className="relative z-[1] flex h-10 min-w-0 flex-1 items-center pr-2"
        >
          <NavbarWordmark className="h-9" overArtwork={!showHeaderSurface} />
        </Link>

        {/* Over artwork the icons carry the wordmark's soft shadow, so a
            bright picture never swallows them. Each glyph takes it, not the
            group: a filter there would anchor the menus' fixed panels. */}
        <div
          className={`relative z-[1] flex shrink-0 items-center gap-1 ${
            showHeaderSurface ? "" : "[&_svg]:[filter:var(--filter-navbar-ink)]"
          }`}
        >
          <AppUpdateButton variant="mobile" />
          <Tooltip content={t("search.open")}>
            <button
              type="button"
              onClick={openSearchOverlay}
              aria-label={t("search.open")}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full text-white/72 transition hover:bg-white/10 hover:text-white"
            >
              <Search size={18} />
            </button>
          </Tooltip>
          <NotificationCenter variant="mobile" />
          <AccountMenu variant="mobile" />
        </div>
      </header>

      <MobileTabBar />
    </>
  );
}
