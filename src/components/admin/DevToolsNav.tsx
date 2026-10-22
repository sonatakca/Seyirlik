import { Link, useLocation } from "react-router-dom";
import { LayoutGrid } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import {
  isAdminIndexPath,
  sectionForPath,
  visibleGroups,
} from "../../lib/adminSections";
import { ADMIN_ICONS } from "./adminIcons";
import { AdminDockSwitch } from "./titleDock/AdminDockSwitch";

/**
 * Every administrative tool, always in reach.
 *
 * The problem this solves is not that the tools were missing. It is that
 * reaching a second one meant going back to the index first, and reaching the
 * index at all meant knowing to click the logo five times. One list, rendered
 * beside every tool, is the whole fix.
 *
 * Rendered once per viewport rather than twice and hidden with CSS: two copies
 * would put two links to the same tool in the accessibility tree, and a test
 * asking "is Subtitles reachable" would not be able to tell which one it found.
 */
export function DevToolsNav({
  onNavigate,
  idPrefix = "devtools-nav",
}: {
  /** Lets the mobile drawer close itself when a destination is chosen. */
  onNavigate?: () => void;
  idPrefix?: string;
}) {
  const { t } = useLanguage();
  const location = useLocation();
  const groups = visibleGroups({ includeDevOnly: import.meta.env.DEV });
  const current = sectionForPath(location.pathname);
  const onIndex = isAdminIndexPath(location.pathname);

  const itemClass = (active: boolean) =>
    `flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-bold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
      active
        ? "bg-[var(--accent)]/12 text-[var(--accent)] shadow-[inset_2px_0_0_var(--accent)]"
        : "text-white/55 hover:bg-white/[0.06] hover:text-white"
    }`;

  return (
    <nav aria-label={t("admin.nav.label")} className="space-y-5">
      <Link
        to="/admin"
        onClick={onNavigate}
        aria-current={onIndex ? "page" : undefined}
        className={itemClass(onIndex)}
      >
        <LayoutGrid size={16} className="shrink-0" />
        {t("admin.nav.overview")}
      </Link>

      {/* A setting, not a destination; kept at the top so it is in view
          from every tool without scrolling the list. */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03]">
        <AdminDockSwitch />
      </div>

      {groups.map(({ group, sections }) => (
        <div key={group.id}>
          <h2
            id={`${idPrefix}-group-${group.id}`}
            className="px-3 text-[0.6875rem] font-black uppercase tracking-[0.16em] text-white/30"
          >
            {t(group.titleKey)}
          </h2>

          <ul
            aria-labelledby={`${idPrefix}-group-${group.id}`}
            className="mt-1.5 space-y-0.5"
          >
            {sections.map((section) => {
              const Icon = ADMIN_ICONS[section.icon];
              const active = current?.id === section.id;

              return (
                <li key={section.id}>
                  <Link
                    to={section.path}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={itemClass(active)}
                  >
                    <Icon size={16} className="shrink-0" />
                    <span className="truncate">{t(section.titleKey)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
