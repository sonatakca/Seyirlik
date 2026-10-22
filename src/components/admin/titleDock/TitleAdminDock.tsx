import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Bookmark,
  Captions,
  EyeOff,
  FileVideo,
  Images,
  RefreshCcw,
  SquareArrowOutUpRight,
  X,
  type LucideIcon,
} from "lucide-react";
import { useLanguage } from "../../../i18n/LanguageContext";
import type { TranslationKey } from "../../../i18n/translations";
import { setAdminDockHidden } from "../../../lib/adminDockPreference";
import {
  getLibraryTitle,
  type LibraryTitleDetail,
} from "../../../lib/libraryAdminApi";
import { refreshItemMetadata } from "../../../lib/mediaApi";
import { notify } from "../../../lib/notifications/notificationStore";
import {
  enqueueProcessing,
  getProcessingOverview,
  processSeason,
  processSeries,
} from "../../../lib/processingApi";
import { formatTemplate } from "../../../lib/format";
import { releaseSearchUrl } from "../../../lib/wantedApi";
import { describeErrorForUser } from "../../../lib/userFacingError";
import { describeBulkOutcome } from "../../../pages/admin/processingSeriesModel";
import { NoticeLine } from "../libraryPresentation";
import { languages } from "../libraryStyle";
import { SubtitleSyncPanel } from "../SubtitleSyncPanel";
import {
  SubtitleUploadButton,
  SubtitleUploadPolicyFields,
  type SubtitleUploadPolicy,
} from "../SubtitleUploadControl";
import { useTitleActions } from "../useTitleActions";
import "../../home/heroDock.css";
import type { HeroCentreDockPlace } from "../../home/heroCentreDock";
import {
  DOCK_SECTIONS,
  hasActiveWork,
  jobPercent,
  pickProcessing,
  scopeTitleId,
  sectionStatus,
  seriesCounts,
  type DockProcessing,
  type DockScope,
  type DockSection,
  type DockStatus,
  type DockTone,
} from "./titleDockModel";

const SECTION_ICON: Record<DockSection, LucideIcon> = {
  processing: FileVideo,
  subtitles: Captions,
  trickplay: Images,
  metadata: RefreshCcw,
  monitoring: Bookmark,
};

const SECTION_LABEL: Record<DockSection, TranslationKey> = {
  processing: "titleDock.section.processing",
  subtitles: "titleDock.section.subtitles",
  trickplay: "titleDock.section.trickplay",
  metadata: "titleDock.section.metadata",
  monitoring: "titleDock.section.monitoring",
};

const TONE_DOT: Record<DockTone, string> = {
  ok: "bg-emerald-400",
  busy: "bg-sky-400",
  attention: "bg-amber-400",
  idle: "bg-white/30",
  unknown: "border border-white/35 bg-transparent",
};

const TONE_TEXT: Record<DockTone, string> = {
  ok: "text-emerald-200/90",
  busy: "text-sky-200",
  attention: "text-amber-200",
  idle: "text-white/45",
  unknown: "text-white/40",
};

/** Between the dock and its panel. */
const PANEL_GAP_PX = 10;
/** Between a phone's admin dock and the Play dock fixed below it. */
const INLINE_GAP_PX = 12;
/** A phone's navbar, which the panel must not slide under. */
const INLINE_NAVBAR_PX = 72;
const INLINE_PANEL_MIN_PX = 200;
/** Where the Play dock's top would be, should it not be on the page. */
const INLINE_FLOOR_FALLBACK_PX = 96;

/** How often to look again while this title has work queued or running. */
const ACTIVE_POLL_MS = 4_000;
/** And when it has none, so a job started elsewhere still shows up. */
const IDLE_POLL_MS = 30_000;

const panelButton =
  "inline-flex min-h-9 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.07] px-3.5 py-1.5 text-xs font-bold text-white/85 transition hover:bg-white/[0.13] hover:text-white disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const primaryButton =
  "inline-flex min-h-9 items-center gap-1.5 rounded-full bg-[var(--accent)] px-3.5 py-1.5 text-xs font-black text-black transition hover:brightness-110 disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60";

function useStatusText() {
  const { t } = useLanguage();
  return (status: DockStatus) =>
    status.values
      ? formatTemplate(t(status.key), status.values)
      : t(status.key);
}

/**
 * The title's admin dock: every errand an administrator runs on the film or
 * show they are looking at, each with its state, without leaving the page.
 *
 * Before this, re-encoding a film or finding its subtitles meant opening
 * DevTools, opening the tool, and finding the title again in that tool's own
 * list. The dock reads the same two sources those tools do — the library's
 * record of the title and the processing catalogue — and runs the same
 * requests, so a press here is the same press as there.
 */
export default function TitleAdminDock({
  scope,
  place,
}: {
  scope: DockScope;
  place: HeroCentreDockPlace;
}) {
  const { t } = useLanguage();
  const reduceMotion = useReducedMotion();
  const statusText = useStatusText();
  const titleId = scopeTitleId(scope);
  const seasonId = scope.kind === "series" ? scope.seasonId : undefined;
  const [detail, setDetail] = useState<LibraryTitleDetail | null>(null);
  const [absent, setAbsent] = useState(false);
  const [processing, setProcessing] = useState<DockProcessing | null>(null);
  const [open, setOpen] = useState<DockSection | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef(new Map<DockSection, HTMLButtonElement>());
  const panelId = useId();

  const loadDetail = useCallback(async () => {
    try {
      setDetail(await getLibraryTitle(titleId));
    } catch (error) {
      /*
       * Not every page with a title on it is a library title — and an
       * administrator whose rights were taken away mid-session gets a 403.
       * Either way there is nothing this dock could act on.
       */
      const status = (error as { status?: number }).status;
      if (status === 404 || status === 403) setAbsent(true);
    }
  }, [titleId]);

  const loadProcessing = useCallback(async () => {
    try {
      const overview = await getProcessingOverview({ background: true });
      setProcessing(
        pickProcessing(
          overview,
          scope.kind === "movie"
            ? { kind: "movie", itemId: titleId }
            : { kind: "series", seriesId: titleId, seasonId },
        ),
      );
    } catch {
      // The other sections still work; processing reads as unknown.
    }
  }, [scope.kind, titleId, seasonId]);

  const reload = useCallback(
    () => Promise.all([loadDetail(), loadProcessing()]).then(() => undefined),
    [loadDetail, loadProcessing],
  );

  // The gate keys the dock by title, so a new title is a new dock.
  useEffect(() => {
    void reload();
  }, [reload]);

  /*
   * Processing is the one section whose state moves on its own. Polled while
   * the page is visible, quickly while something is running.
   */
  const active = hasActiveWork(processing);
  useEffect(() => {
    if (absent) return undefined;
    const delay = active ? ACTIVE_POLL_MS : IDLE_POLL_MS;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void loadProcessing();
      // A finished encode changes nothing the detail reports, but a finished
      // subtitle search or download does, and those only move while active.
      if (active) void loadDetail();
    }, delay);
    return () => window.clearInterval(timer);
  }, [absent, active, loadDetail, loadProcessing]);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen((current) => {
      if (current && restoreFocus) buttonRefs.current.get(current)?.focus();
      return null;
    });
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close]);

  /*
    Under a phone's hero, the page's Play dock is fixed over the foot of the
    screen. Opening a panel there would put it behind that dock, so the page
    is brought to rest with this dock just above the Play dock, and the panel
    opens upward into the room above it.
  */
  const inline = place === null;
  const [inlinePanelMax, setInlinePanelMax] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!open || !inline) return;
    const root = rootRef.current;
    if (!root) return;
    const floor =
      document.querySelector(".phone-title-dock")?.getBoundingClientRect()
        .top ?? window.innerHeight - INLINE_FLOOR_FALLBACK_PX;
    const rect = root.getBoundingClientRect();
    const shift = rect.bottom - (floor - INLINE_GAP_PX);
    if (Math.abs(shift) > 1)
      window.scrollBy({
        top: shift,
        behavior: reduceMotion ? "auto" : "smooth",
      });
    setInlinePanelMax(
      Math.max(
        INLINE_PANEL_MIN_PX,
        floor - INLINE_GAP_PX - rect.height - PANEL_GAP_PX - INLINE_NAVBAR_PX,
      ),
    );
  }, [open, inline, reduceMotion]);

  if (absent) return null;

  const hide = () => {
    setAdminDockHidden(true);
    notify({
      tone: "info",
      title: t("titleDock.hiddenTitle"),
      description: t("titleDock.hiddenDescription"),
      key: "title-dock-hidden",
    });
  };

  const workspacePath = `/admin/library/${encodeURIComponent(titleId)}`;
  const sections = DOCK_SECTIONS;
  const statuses = Object.fromEntries(
    sections.map((section) => [
      section,
      sectionStatus(section, detail, processing, scope),
    ]),
  ) as Record<DockSection, DockStatus>;

  const runningJob =
    processing?.activeJob?.state === "running" ? processing.activeJob : null;

  const sectionButton = (section: DockSection, primary = false) => {
    const Icon = SECTION_ICON[section];
    const status = statuses[section];
    const selected = open === section;
    const label = t(SECTION_LABEL[section]);
    const text = statusText(status);
    return (
      <button
        key={section}
        ref={(node) => {
          if (node) buttonRefs.current.set(section, node);
          else buttonRefs.current.delete(section);
        }}
        type="button"
        aria-expanded={selected}
        aria-controls={selected ? panelId : undefined}
        aria-label={`${label}: ${text}`}
        title={`${label}: ${text}`}
        onClick={() => setOpen(selected ? null : section)}
        className={`${
          primary
            ? "hero-dock-play !justify-between !px-3.5 text-[0.9375rem]"
            : "hero-dock-action !min-w-0 !flex-[1_1_0%] !justify-start !gap-2 !px-3 text-left"
        } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
          selected
            ? "!bg-white/[0.16] text-white"
            : primary
              ? "bg-white/[0.07] text-white hover:bg-white/[0.11]"
              : ""
        }`}
      >
        {primary && runningJob ? (
          /* Encoding fills the row the way watching fills the play button. */
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 bg-sky-400/20 transition-[width] duration-700 ease-out"
            style={{ width: `${jobPercent(runningJob)}%` }}
          />
        ) : null}
        <span
          className={`relative flex items-center gap-2 ${primary ? "shrink-0" : "min-w-0"}`}
        >
          <span className="relative shrink-0">
            <Icon size={primary ? 18 : 15} aria-hidden="true" />
            <span
              aria-hidden="true"
              className={`absolute -right-1 -top-1 h-2 w-2 rounded-full ring-2 ring-[#0b0c0e] ${TONE_DOT[status.tone]}`}
            />
          </span>
          {primary ? (
            <span className="shrink-0 font-extrabold">{label}</span>
          ) : (
            <span className="flex min-w-0 flex-col leading-[1.15]">
              <span className="truncate text-[0.6875rem] font-extrabold text-white/90">
                {label}
              </span>
              <span
                className={`truncate text-[0.625rem] font-bold ${TONE_TEXT[status.tone]}`}
              >
                {text}
              </span>
            </span>
          )}
        </span>
        {primary ? (
          <span
            className={`relative ml-2 truncate text-[0.6875rem] font-bold ${TONE_TEXT[status.tone]}`}
          >
            {text}
          </span>
        ) : null}
      </button>
    );
  };

  const iconAction =
    "hero-dock-action !w-[var(--dock-row)] shrink-0 !p-0 text-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

  return (
    <div
      ref={rootRef}
      data-testid="title-admin-dock"
      className={
        inline
          ? "relative mx-auto mt-4 w-[min(22rem,calc(100%-2rem))]"
          : "relative"
      }
    >
      {/*
        Built as the watch dock is: its glass, its rows and its buttons, with
        processing in the play button's place — the one errand whose state
        moves while you look, filling the row as an encode runs.
      */}
      <div
        role="toolbar"
        aria-label={t("titleDock.label")}
        className={`hero-dock text-white ${place?.compact ? "hero-dock-compact" : ""}`}
      >
        <div className="flex min-w-0 items-center gap-1">
          {sectionButton("processing", true)}
          <Link
            to={workspacePath}
            aria-label={t("titleDock.workspace")}
            title={t("titleDock.workspace")}
            className={iconAction}
          >
            <SquareArrowOutUpRight size={15} aria-hidden="true" />
          </Link>
          <button
            type="button"
            onClick={hide}
            aria-label={t("titleDock.hide")}
            title={t("titleDock.hide")}
            className={iconAction}
          >
            <EyeOff size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="hero-dock-row !flex-nowrap">
          {sectionButton("subtitles")}
          {sectionButton("trickplay")}
        </div>
        <div className="hero-dock-row !flex-nowrap">
          {sectionButton("metadata")}
          {sectionButton("monitoring")}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.section
            key="panel"
            id={panelId}
            role="dialog"
            aria-label={t(SECTION_LABEL[open])}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            /* Above the dock: inside the stage, or above a phone's Play dock. */
            style={
              inline
                ? { maxHeight: inlinePanelMax ?? undefined }
                : {
                    x: "-50%",
                    maxHeight: Math.max(
                      240,
                      Math.min(480, place.stageHeight - 300),
                    ),
                  }
            }
            className={`hero-dock-bar absolute bottom-[calc(100%+10px)] !block overflow-y-auto !rounded-[26px] !p-4 text-white sm:!p-5 ${
              inline
                ? "left-0 w-full"
                : "left-1/2 w-[min(34rem,calc(100vw-4rem))]"
            }`}
          >
            <PanelHeader
              section={open}
              status={statuses[open]}
              onClose={() => close(true)}
            />
            <div className="mt-3">
              <SectionBody
                section={open}
                scope={scope}
                detail={detail}
                processing={processing}
                workspacePath={workspacePath}
                reload={reload}
              />
            </div>
          </motion.section>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function PanelHeader({
  section,
  status,
  onClose,
}: {
  section: DockSection;
  status: DockStatus;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const statusText = useStatusText();
  const Icon = SECTION_ICON[section];
  return (
    <header className="flex items-start gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.07] text-white/80">
        <Icon size={17} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-black leading-tight">
          {t(SECTION_LABEL[section])}
        </h2>
        <p
          className={`mt-0.5 flex items-center gap-1.5 text-xs font-bold ${TONE_TEXT[status.tone]}`}
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[status.tone]}`}
          />
          {statusText(status)}
        </p>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label={t("titleDock.close")}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/55 transition hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <X size={16} aria-hidden="true" />
      </button>
    </header>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.6875rem] font-black uppercase tracking-[0.12em] text-white/35">
        {label}
      </dt>
      <dd className="mt-0.5 break-words text-sm font-semibold text-white/80">
        {children}
      </dd>
    </div>
  );
}

function SectionBody({
  section,
  scope,
  detail,
  processing,
  workspacePath,
  reload,
}: {
  section: DockSection;
  scope: DockScope;
  detail: LibraryTitleDetail | null;
  processing: DockProcessing | null;
  workspacePath: string;
  reload: () => Promise<void>;
}) {
  const { t } = useLanguage();
  const actions = useTitleActions(reload);
  const [uploadPolicy, setUploadPolicy] = useState<SubtitleUploadPolicy>({
    language: "tur",
    forced: false,
    replace: false,
  });

  if (section === "processing")
    return (
      <ProcessingBody scope={scope} processing={processing} reload={reload} />
    );

  if (!detail)
    return (
      <p role="status" className="text-sm text-white/55">
        {t("library.loading")}
      </p>
    );

  const busy = actions.busy !== null;
  const seasonId = scope.kind === "series" ? scope.seasonId : undefined;
  /** Subtitles and trickplay can be asked for one season at a time. */
  const target = seasonId ?? detail.id;

  if (section === "subtitles")
    return (
      <div className="space-y-3">
        <dl className="grid grid-cols-2 gap-3">
          <Fact label={t("titleDock.subtitles.have")}>
            {languages(detail.subtitleLanguages, 8) || "—"}
          </Fact>
          <Fact label={t("library.lookingFor")}>
            {languages(detail.pendingSubtitles, 8) || "—"}
          </Fact>
        </dl>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={primaryButton}
            disabled={busy || detail.files === 0}
            onClick={() => void actions.findSubtitles(target)}
          >
            {t(seasonId ? "library.findTurkishSeason" : "library.findTurkish")}
          </button>
          <Link className={panelButton} to="/admin/subtitles">
            {t("admin.subtitles.title")}
          </Link>
        </div>
        {detail.kind === "series" ? (
          <p className="text-xs font-semibold text-white/40">
            {t("library.uploadPerEpisode")}{" "}
            <Link
              className="underline decoration-white/30 underline-offset-2 hover:text-white"
              to={`${workspacePath}?tab=episodes`}
            >
              {t("library.tab.episodes")}
            </Link>
          </p>
        ) : detail.files > 0 ? (
          <>
            <div className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
              <SubtitleUploadPolicyFields
                policy={uploadPolicy}
                onChange={setUploadPolicy}
                disabled={busy}
              />
              <SubtitleUploadButton
                disabled={busy}
                label={t("library.uploadSubtitle")}
                onPick={(file) =>
                  actions.uploadSubtitle(detail.id, file, uploadPolicy)
                }
              />
            </div>
            <SubtitleSyncPanel itemId={detail.id} onSynced={reload} />
          </>
        ) : null}
        <NoticeLine notice={actions.notice} />
      </div>
    );

  if (section === "trickplay")
    return (
      <div className="space-y-3">
        <p className="text-sm font-semibold tabular-nums text-white/70">
          {detail.trickplayFiles}/{detail.files}{" "}
          {t("library.trickplayCoverage")}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={primaryButton}
            disabled={
              busy ||
              detail.files === 0 ||
              (!seasonId && detail.trickplayFiles >= detail.files)
            }
            onClick={() => void actions.trickplay(target)}
          >
            {t(
              seasonId
                ? "library.generateTrickplaySeason"
                : "library.generateMissing",
            )}
          </button>
          <button
            type="button"
            className={panelButton}
            disabled={busy || detail.files === 0}
            onClick={() => void actions.trickplay(target, true)}
          >
            {t("library.rebuildAll")}
          </button>
        </div>
        <NoticeLine notice={actions.notice} />
      </div>
    );

  if (section === "metadata")
    return (
      <div className="space-y-3">
        <dl className="grid grid-cols-2 gap-3">
          <Fact label={t("titleDock.metadata.cover")}>
            {t(
              detail.artwork.missing
                ? "titleDock.metadata.missing"
                : "titleDock.metadata.present",
            )}
          </Fact>
          <Fact label={t("titleDock.metadata.logo")}>
            {t(
              detail.artwork.logoTag
                ? "titleDock.metadata.present"
                : "titleDock.metadata.missing",
            )}
          </Fact>
        </dl>
        <p className="text-xs font-semibold text-white/40">
          {t("library.metadataHint")}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={primaryButton}
            disabled={busy}
            onClick={() =>
              void refreshItemMetadata(detail.id).then(
                () =>
                  actions.setNotice({
                    tone: "ok",
                    text: t("library.metadataQueued"),
                  }),
                () =>
                  actions.setNotice({
                    tone: "error",
                    text: t("library.actionFailed"),
                  }),
              )
            }
          >
            {t("library.refreshMetadata")}
          </button>
          <Link className={panelButton} to={`${workspacePath}?tab=artwork`}>
            {t("library.tab.artwork")}
          </Link>
        </div>
        <NoticeLine notice={actions.notice} />
      </div>
    );

  // Monitoring.
  return (
    <div className="space-y-3">
      {detail.kind === "series" && detail.episodeCount > 0 ? (
        <p className="text-sm font-semibold tabular-nums text-white/70">
          {detail.availableEpisodeCount}/{detail.episodeCount}{" "}
          {t("library.episodes")}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={detail.desired ? panelButton : primaryButton}
          disabled={busy}
          onClick={() => void actions.toggleWanted(detail.id, detail.desired)}
        >
          {t(detail.desired ? "wanted.unmonitor" : "wanted.add")}
        </button>
        <Link
          className={panelButton}
          to={releaseSearchUrl({
            ...detail,
            kind: detail.kind as "movie" | "series",
            year: detail.year ?? undefined,
          })}
        >
          {t("wanted.releases")}
        </Link>
        {detail.kind === "series" ? (
          <Link className={panelButton} to={`${workspacePath}?tab=monitoring`}>
            {t("library.tab.monitoring")}
          </Link>
        ) : null}
      </div>
      <NoticeLine notice={actions.notice} />
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

function ProcessingBody({
  scope,
  processing,
  reload,
}: {
  scope: DockScope;
  processing: DockProcessing | null;
  reload: () => Promise<void>;
}) {
  const { t } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "ok" | "error";
    text: string;
  } | null>(null);

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setNotice(null);
    try {
      setNotice({ tone: "ok", text: await work() });
      await reload();
    } catch (error) {
      setNotice({ tone: "error", text: describeErrorForUser(error, t) });
    } finally {
      setBusy(false);
    }
  };

  const openTool = (
    <Link className={panelButton} to="/dev/media-processing">
      {t("devtools.card.mediaProcessing.title")}
    </Link>
  );

  if (!processing)
    return (
      <div className="space-y-3">
        <p role="status" className="text-sm text-white/55">
          {t("library.loading")}
        </p>
        <div className="flex flex-wrap gap-2">{openTool}</div>
      </div>
    );

  if (scope.kind === "series") {
    const counts = seriesCounts(processing);
    const seasonId = scope.seasonId;
    return (
      <div className="space-y-3">
        {counts ? (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Fact label={t("titleDock.processing.countDone")}>
              <span className="tabular-nums">
                {counts.complete}/{counts.total - counts.unavailable}
              </span>
            </Fact>
            <Fact label={t("titleDock.processing.countActive")}>
              <span className="tabular-nums">{counts.active}</span>
            </Fact>
            <Fact label={t("titleDock.processing.countWaiting")}>
              <span className="tabular-nums">{counts.eligible}</span>
            </Fact>
            <Fact label={t("titleDock.processing.countNoFile")}>
              <span className="tabular-nums">{counts.unavailable}</span>
            </Fact>
          </dl>
        ) : (
          <p className="text-sm text-white/55">
            {t("titleDock.processing.notInCatalogue")}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {counts && counts.eligible > 0 ? (
            <button
              type="button"
              className={primaryButton}
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  describeBulkOutcome(
                    await (seasonId
                      ? processSeason(seasonId)
                      : processSeries(scope.seriesId)),
                    (key) => t(key as TranslationKey),
                    formatTemplate,
                  ),
                )
              }
            >
              {formatTemplate(
                t(
                  seasonId
                    ? "titleDock.processing.processSeason"
                    : "titleDock.processing.processSeries",
                ),
                { count: counts.eligible },
              )}
            </button>
          ) : null}
          {openTool}
        </div>
        <NoticeLine notice={notice} />
      </div>
    );
  }

  const { movie, activeJob } = processing;
  if (!movie)
    return (
      <div className="space-y-3">
        <p className="text-sm text-white/55">
          {t("titleDock.processing.notInCatalogue")}
        </p>
        <div className="flex flex-wrap gap-2">{openTool}</div>
      </div>
    );

  const source = movie.source;
  const rungs = movie.package?.rungs ?? [];
  const missing = movie.plan?.missingRungs ?? [];
  const percent = activeJob ? jobPercent(activeJob) : null;
  const canStart =
    !movie.activeJobId &&
    movie.sourceAvailable &&
    movie.processable &&
    movie.packageState !== "complete";

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-3">
        <Fact label={t("titleDock.processing.source")}>
          {source
            ? [
                `${source.qualityHeight}p`,
                source.videoCodec.toUpperCase(),
                source.dynamicRange,
                formatSize(source.sizeBytes),
              ].join(" · ")
            : movie.sourceAvailable
              ? "—"
              : t("titleDock.processing.noSource")}
        </Fact>
        <Fact label={t("titleDock.processing.renditions")}>
          {rungs.length
            ? [...rungs]
                .sort((a, b) => b - a)
                .map((rung) => `${rung}p`)
                .join(" · ")
            : t("titleDock.processing.noRenditions")}
        </Fact>
        {missing.length && !movie.activeJobId ? (
          <Fact label={t("titleDock.processing.missing")}>
            {[...missing]
              .sort((a, b) => b - a)
              .map((rung) => `${rung}p`)
              .join(" · ")}
          </Fact>
        ) : null}
      </dl>

      {movie.activeJobId ? (
        <div>
          <div className="flex items-center justify-between text-xs font-bold text-white/60">
            <span>
              {activeJob
                ? t(`processing.stage.${activeJob.stage}` as TranslationKey)
                : t("titleDock.processing.queued")}
            </span>
            {percent !== null ? (
              <span className="tabular-nums">{percent}%</span>
            ) : null}
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? 0}
            aria-label={t("titleDock.section.processing")}
            className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10"
          >
            <div
              className="h-full origin-left rounded-full bg-sky-400 transition-transform duration-700 ease-out"
              style={{ transform: `scaleX(${(percent ?? 0) / 100})` }}
            />
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {canStart ? (
          <button
            type="button"
            className={primaryButton}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await enqueueProcessing(
                  movie.itemId,
                  movie.mediaFileId ?? undefined,
                );
                return t("titleDock.processing.queuedNotice");
              })
            }
          >
            {t(
              movie.packageState === "partial" || movie.packageState === "stale"
                ? "titleDock.processing.completeLadder"
                : "titleDock.processing.start",
            )}
          </button>
        ) : null}
        {openTool}
      </div>
      <NoticeLine notice={notice} />
    </div>
  );
}
