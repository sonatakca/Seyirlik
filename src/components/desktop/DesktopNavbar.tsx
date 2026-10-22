import { NotificationHistoryPanel } from "../notifications/NotificationHistoryPanel";
import { useLayoutEffect, useRef } from "react";
import { useReducedMotion } from "framer-motion";
import { useNavbarScrolled } from "../../hooks/useNavbarScrolled";
import { Search } from "lucide-react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";
import { AccountMenu } from "../AccountMenu";
import { AppUpdateButton } from "../AppUpdateButton";
import { AnimatedText } from "../AnimatedText";
import { AnimatedWidth } from "../AnimatedWidth";
import { NavbarSurface } from "../NavbarSurface";
import { NavbarWordmark } from "../NavbarWordmark";
import { openSearchOverlay } from "../../lib/searchModel";
import { SlidingIndicator } from "../ui/SlidingIndicator";
import { Tooltip } from "../ui/Tooltip";

// Only affects which modifier the shortcut hint spells out, so a userAgent
// sniff is enough and never blocks the shortcut itself.
const isMacPlatform =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);

export function DesktopNavbar() {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const hasScrolled = useNavbarScrolled();
  const libraryRoutes = {
    movies: "/movies",
    series: "/shows",
    books: "/books",
  };
  const location = useLocation();
  const navLinksRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const shouldReduceMotion = useReducedMotion();
  const wasScrolledRef = useRef(hasScrolled);

  // The contents' 8px drop. `top` takes its new value at once and a
  // compositor transform carries the bar there from where it was, ending at
  // no transform: a transform at rest would anchor the menus' fixed panels to
  // the bar, and transitioning `top` itself re-laid out the header on every
  // frame of the move.
  useLayoutEffect(() => {
    const nav = navRef.current;
    const was = wasScrolledRef.current;
    wasScrolledRef.current = hasScrolled;
    if (!nav || was === hasScrolled || shouldReduceMotion) return;
    if (typeof nav.animate !== "function") return;
    nav.animate(
      [
        { transform: `translateY(${hasScrolled ? 8 : -8}px)` },
        { transform: "translateY(0px)" },
      ],
      { duration: 300, easing: "ease-out" },
    );
  }, [hasScrolled, shouldReduceMotion]);
  const navLinks = [
    { to: "/home", label: t("nav.home") },
    { to: libraryRoutes.movies, label: t("nav.movies") },
    { to: libraryRoutes.series, label: t("nav.series") },
    { to: libraryRoutes.books, label: t("nav.books") },
    { to: "/my-list", label: t("myList.title") },
    // Collections is off until further notice; /collections redirects home.
  ];
  const devClickCountRef = useRef(0);
  const devClickTimerRef = useRef<number | null>(null);

  const handleBrandEasterEggClick = () => {
    devClickCountRef.current += 1;

    if (devClickTimerRef.current !== null) {
      window.clearTimeout(devClickTimerRef.current);
    }

    devClickTimerRef.current = window.setTimeout(() => {
      devClickCountRef.current = 0;
      devClickTimerRef.current = null;
    }, 1400);

    if (devClickCountRef.current >= 5) {
      devClickCountRef.current = 0;

      if (devClickTimerRef.current !== null) {
        window.clearTimeout(devClickTimerRef.current);
        devClickTimerRef.current = null;
      }

      navigate("/dev");
    }
  };

  return (
    <header className="fixed inset-x-0 top-0 z-40 select-none pt-[env(safe-area-inset-top)] [-webkit-tap-highlight-color:transparent]">
      <NavbarSurface shown={hasScrolled} variant="desktop" />
      {/* Clear, the bar sits over a floating backdrop that starts 8px down,
          so its contents drop by as much to stand as far inside its top edge
          as inside its side. `top`, not a resting transform: a transform
          would anchor the menus' fixed panels to the bar. */}
      <nav
        ref={navRef}
        className={`relative z-[1] mx-auto flex h-16 w-full max-w-[1600px] items-center gap-3 px-4 sm:h-20 sm:gap-8 sm:px-6 lg:px-8 ${
          hasScrolled ? "top-0" : "top-2"
        }`}
      >
        <Link
          to="/home"
          className="flex min-w-0 shrink-0 items-center"
          aria-label={t("nav.brandHome")}
        >
          <span className="flex h-10 shrink-0 items-center sm:h-12">
            <NavbarWordmark
              className="h-8 sm:h-11"
              overArtwork={!hasScrolled}
            />
          </span>
        </Link>

        <div
          ref={navLinksRef}
          className="relative hidden min-w-0 flex-1 items-center gap-7 md:flex"
        >
          {/* The wordmark's shadow: over a hero the links stand on the
              artwork's own colours, which can be as light as they are. A
              filter on the link, not a text-shadow, because the label's
              animation frames clip to their boxes and would cut the blur
              into a dark rectangle; a filter draws after that clip. */}
          {navLinks.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) =>
                `text-sm font-semibold transition-colors duration-200 navbar-ink-shadow ${
                  isActive ? "text-white" : "text-white/72 hover:text-white"
                } ${"className" in link ? link.className : ""}`
              }
            >
              <AnimatedWidth value={link.label}>
                {/* What the underline measures: the text itself. The
                    AnimatedWidth frame around it is a few pixels wider on
                    the right, so centring on the link was centring off it. */}
                <span data-nav-label>
                  <AnimatedText value={link.label} />
                </span>
              </AnimatedWidth>
            </NavLink>
          ))}

          {/* Travels between links so a route change reads as a move along
              the bar, not a highlight that blinks out and back in. White, not
              the accent: "you are here" is never a signal colour. */}
          <SlidingIndicator
            containerRef={navLinksRef}
            activeSelector='a[aria-current="page"] [data-nav-label]'
            measureKey={location.pathname}
          >
            {/* The links' shadow too, so the line keeps its edge where they do. */}
            <span className="absolute -bottom-2 left-1/2 h-[2px] w-[calc(100%+0.25rem)] -translate-x-1/2 rounded-full bg-white/90 navbar-ink-shadow" />
          </SlidingIndicator>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-3">
          <AppUpdateButton />

          <Tooltip
            content={t("search.open")}
            shortcut={isMacPlatform ? "⌘K" : "Ctrl K"}
          >
            <button
              type="button"
              onClick={openSearchOverlay}
              aria-label={t("search.open")}
              className="inline-flex min-h-9 w-9 items-center justify-center rounded-full text-white/72 transition-[background-color,color,box-shadow,transform] duration-200 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2 focus:ring-offset-black sm:min-h-10 sm:w-10"
            >
              <Search size={18} className="navbar-ink-shadow shrink-0" />
            </button>
          </Tooltip>

          {/* The name doubles as the way into /dev: five quick presses. */}
          <AccountMenu onTriggerClick={handleBrandEasterEggClick} />
        </div>
      </nav>
      <NotificationHistoryPanel />
    </header>
  );
}
