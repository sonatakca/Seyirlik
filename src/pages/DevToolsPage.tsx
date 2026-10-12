import { useEffect } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Loader2 } from "lucide-react";
import { setPageTitle } from "../lib/pageTitle";
import { useLanguage } from "../i18n/LanguageContext";
import { visibleGroups } from "../lib/adminSections";
import { ADMIN_ICONS } from "../components/admin/adminIcons";
import { useDevToolsStatus } from "../components/admin/useDevToolsStatus";
import { formatFileSize } from "./admin/processingModel";

/**
 * The administration index: what is happening, and everything you can open.
 *
 * It is a page an operator opens several times a day, so it leads with state
 * rather than with decoration — the old full-width hero and its confetti cost
 * a third of the screen and told nobody anything. What replaced them is two
 * facts the server can answer cheaply, and the one route through the system
 * that was impossible to guess: wanted, releases, downloads, imports.
 */

/** The errand the grouping alone could not explain: how a film actually arrives. */
const WORKFLOW = [
  { path: "/admin/library", labelKey: "admin.workflow.wanted" },
  { path: "/admin/decisions", labelKey: "admin.workflow.releases" },
  { path: "/admin/acquisitions", labelKey: "admin.workflow.downloads" },
  { path: "/admin/imports", labelKey: "admin.workflow.imports" },
] as const;

const SERVER_TONE: Record<string, string> = {
  ready: "text-emerald-300",
  degraded: "text-amber-300",
  unreachable: "text-rose-300",
};

/** Below a tenth of the volume free, the figure turns amber. */
const LOW_SPACE_RATIO = 0.1;

export function DevToolsPage() {
  const { t } = useLanguage();
  const status = useDevToolsStatus();

  useEffect(() => {
    setPageTitle(`${t("admin.title")} · Seyirlik`, {
      canonicalPath: "/admin",
      robots: "noindex, nofollow",
    });
  }, [t]);

  const groups = visibleGroups({ includeDevOnly: import.meta.env.DEV });

  const downloadsLabel = () => {
    if (status.loading) return t("admin.overview.status.checking");
    if (!status.downloads) return t("admin.overview.status.unavailable");
    if (status.downloads.failed > 0) {
      return t("admin.overview.downloads.failed").replace(
        "{count}",
        String(status.downloads.failed),
      );
    }
    if (status.downloads.active > 0) {
      return t("admin.overview.downloads.active").replace(
        "{count}",
        String(status.downloads.active),
      );
    }
    return t("admin.overview.downloads.idle");
  };

  return (
    <div className="space-y-6">
      <section aria-labelledby="admin-status" className="space-y-3">
        <h2
          id="admin-status"
          className="px-1 text-xs font-black uppercase tracking-[0.2em] text-white/35"
        >
          {t("admin.overview.status.heading")}
        </h2>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Link
            to="/admin/health"
            className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-black/30 px-4 py-3 transition hover:border-[var(--accent)]/35 hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <span className="text-sm font-bold text-white/55">
              {t("admin.overview.system.label")}
            </span>
            <span
              className={`flex items-center gap-2 text-sm font-black ${
                status.server
                  ? (SERVER_TONE[status.server] ?? "")
                  : "text-white/45"
              }`}
            >
              {status.loading ? (
                <Loader2 size={14} className="animate-spin" />
              ) : null}
              {status.loading
                ? t("admin.overview.status.checking")
                : t(
                    status.server === "ready"
                      ? "admin.overview.system.ready"
                      : status.server === "degraded"
                        ? "admin.overview.system.degraded"
                        : "admin.overview.system.unreachable",
                  )}
            </span>
          </Link>

          <Link
            to="/admin/acquisitions"
            className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-black/30 px-4 py-3 transition hover:border-[var(--accent)]/35 hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <span className="text-sm font-bold text-white/55">
              {t("admin.overview.downloads.label")}
            </span>
            <span
              className={`text-sm font-black ${
                status.downloads && status.downloads.failed > 0
                  ? "text-rose-300"
                  : "text-white/80"
              }`}
            >
              {downloadsLabel()}
            </span>
          </Link>

          <Link
            to="/dev/media-processing"
            className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-black/30 px-4 py-3 transition hover:border-[var(--accent)]/35 hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] sm:col-span-2 xl:col-span-1"
          >
            <span className="shrink-0 whitespace-nowrap text-sm font-bold text-white/55">
              {t("admin.overview.space.label")}
            </span>
            {status.loading || !status.space || status.space.length === 0 ? (
              <span className="text-sm font-black text-white/45">
                {t(
                  status.loading
                    ? "admin.overview.status.checking"
                    : "admin.overview.status.unavailable",
                )}
              </span>
            ) : (
              <span className="flex flex-wrap justify-end gap-x-4 gap-y-0.5 text-sm font-black">
                {status.space.map((volume) => {
                  const known =
                    volume.freeBytes !== null && volume.totalBytes !== null;
                  const low =
                    known &&
                    volume.totalBytes! > 0 &&
                    volume.freeBytes! / volume.totalBytes! < LOW_SPACE_RATIO;
                  return (
                    <span
                      key={volume.role}
                      title={
                        known
                          ? t("admin.overview.space.of")
                              .replace(
                                "{free}",
                                formatFileSize(volume.freeBytes),
                              )
                              .replace(
                                "{total}",
                                formatFileSize(volume.totalBytes),
                              )
                          : undefined
                      }
                      className="whitespace-nowrap"
                    >
                      <span className="font-bold text-white/45">
                        {t(`admin.overview.space.${volume.role}`)}
                      </span>{" "}
                      <span
                        className={
                          known
                            ? low
                              ? "text-amber-300"
                              : "text-white/80"
                            : "text-white/45"
                        }
                      >
                        {known
                          ? formatFileSize(volume.freeBytes)
                          : t("admin.overview.status.unavailable")}
                      </span>
                    </span>
                  );
                })}
              </span>
            )}
          </Link>
        </div>
      </section>

      <section
        aria-labelledby="admin-workflow"
        className="rounded-2xl border border-white/10 bg-white/[0.04] p-4"
      >
        <h2 id="admin-workflow" className="text-sm font-black text-white">
          {t("admin.overview.workflow.heading")}
        </h2>
        <p className="mt-1 text-sm font-medium leading-6 text-white/45">
          {t("admin.overview.workflow.description")}
        </p>

        <ol className="mt-3 flex flex-wrap items-center gap-1.5">
          {WORKFLOW.map((step, index) => (
            <li key={step.path} className="flex items-center gap-1.5">
              {index > 0 ? (
                <ArrowRight size={14} className="shrink-0 text-white/25" />
              ) : null}
              <Link
                to={step.path}
                className="rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-sm font-bold text-white/70 transition hover:border-[var(--accent)]/35 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                {t(step.labelKey)}
              </Link>
            </li>
          ))}
        </ol>
      </section>

      {groups.map(({ group, sections }) => (
        <section key={group.id} aria-labelledby={`admin-group-${group.id}`}>
          <div className="px-1">
            <h2
              id={`admin-group-${group.id}`}
              className="text-base font-black text-white"
            >
              {t(group.titleKey)}
            </h2>
            <p className="mt-0.5 text-sm font-medium text-white/45">
              {t(group.descriptionKey)}
            </p>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {sections.map((section) => {
              const Icon = ADMIN_ICONS[section.icon];

              return (
                <Link
                  key={section.id}
                  to={section.path}
                  className="group flex gap-3 rounded-2xl border border-white/10 bg-black/30 p-4 transition hover:border-[var(--accent)]/35 hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.07] text-white/75 transition group-hover:text-[var(--accent)]">
                    <Icon size={17} />
                  </span>

                  <span className="min-w-0">
                    <span className="block text-sm font-black text-white transition group-hover:text-[var(--accent)]">
                      {t(section.titleKey)}
                    </span>
                    <span className="mt-1 block text-sm font-medium leading-6 text-white/50">
                      {t(section.descriptionKey)}
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
