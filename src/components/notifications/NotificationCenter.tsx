import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useLocation } from "react-router-dom";
import {
  AlertTriangle,
  Ban,
  Bell,
  CheckCircle2,
  CornerUpRight,
  Info,
  Pause,
  X,
  XCircle,
} from "lucide-react";
import {
  clearNotificationHistory,
  dismissAllNotifications,
  dismissNotification,
  getNotificationHistory,
  getNotifications,
  getNotificationsSeenAt,
  holdNotificationClocks,
  isNotificationUnseen,
  markNotificationsSeen,
  subscribeToNotifications,
  type NotificationTone,
  type SeyirlikNotification,
} from "../../lib/notifications/notificationStore";
import { progressPercent } from "../../lib/notifications/taskNotifications";
import { resolveNotificationAccent } from "../../lib/notifications/notificationAccent";
import { move, REST, settle } from "../../lib/compositorMotion";
import { formatTemplate } from "../../lib/format";
import { useLanguage } from "../../i18n/LanguageContext";
import { TaskDetails } from "./TaskDetails";

/** The least room the panel keeps from the screen's right edge. */
const PANEL_MARGIN_PX = 12;

/**
 * Where notifications live: behind a bell in the navbar, never over the page.
 *
 * They used to stand in a pile in the bottom-right corner, over whatever was
 * there — the hero's controls, a title's Play button — and moved whenever the
 * page or the pile did. Now nothing appears unasked. The bell carries a count
 * while something is going on (a job running, a download, an error to read)
 * and a dot when something has arrived since the centre was last opened; one
 * press opens the centre with what is happening now and what happened before.
 */
export function NotificationCenter({
  variant = "desktop",
}: {
  variant?: "desktop" | "mobile";
}) {
  const { t, language } = useLanguage();
  const location = useLocation();
  const reduceMotion = useReducedMotion();
  const live = useSyncExternalStore(
    subscribeToNotifications,
    getNotifications,
    getNotifications,
  );
  const history = useSyncExternalStore(
    subscribeToNotifications,
    getNotificationHistory,
    getNotificationHistory,
  );
  const seenAt = useSyncExternalStore(
    subscribeToNotifications,
    getNotificationsSeenAt,
    getNotificationsSeenAt,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [openOn, setOpenOn] = useState<string | null>(null);
  // Navigating anywhere closes it, as the account menu does.
  if (openOn !== null && openOn !== location.pathname) setOpenOn(null);
  const isOpen = openOn === location.pathname;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // The panel hangs from the bell's right edge, which on a phone is not the
  // screen's: the account button stands beyond it. Shifted so it always ends
  // a margin inside the screen, however far in from the edge the bell sits.
  const [reach, setReach] = useState(0);
  useLayoutEffect(() => {
    if (!isOpen || !rootRef.current) return;
    const right = rootRef.current.getBoundingClientRect().right;
    setReach(Math.min(0, right - (window.innerWidth - PANEL_MARGIN_PX)));
  }, [isOpen]);

  // Open is reading: nothing expires under the eye, and everything shown
  // counts as seen, again on closing for whatever arrived while it was open.
  useEffect(() => {
    if (!isOpen) return;
    markNotificationsSeen();
    holdNotificationClocks(true);
    return () => {
      holdNotificationClocks(false);
      markNotificationsSeen();
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      )
        setOpenOn(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenOn(null);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen]);

  const liveIds = new Set(live.map((entry) => entry.id));
  const earlier = history.filter((entry) => !liveIds.has(entry.id));
  const hasNew = history.some((entry) => isNotificationUnseen(entry, seenAt));
  const waiting = live.reduce(
    (total, entry) => total + (entry.task?.queuedCount ?? 0),
    0,
  );
  const count = new Intl.NumberFormat(language).format(live.length);
  const label =
    live.length > 0
      ? `${t("nav.notifications")}: ${count}`
      : t("nav.notifications");

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={label}
        onClick={() => setOpenOn(isOpen ? null : location.pathname)}
        className={`relative inline-flex items-center justify-center rounded-full text-white/72 transition-[background-color,color] duration-200 hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
          variant === "desktop" ? "h-9 w-9 sm:h-10 sm:w-10" : "h-9 w-9"
        } ${isOpen ? "bg-white/10 text-white" : ""}`}
      >
        <Bell size={18} className="navbar-ink-shadow shrink-0" />
        {live.length > 0 ? (
          <span
            aria-hidden="true"
            data-notification-count
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-white px-1 text-[0.625rem] font-black tabular-nums leading-none text-black"
          >
            {count}
          </span>
        ) : hasNew ? (
          <span
            aria-hidden="true"
            data-notification-new
            className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[var(--accent-hover)] ring-2 ring-black/60"
          />
        ) : null}
      </button>

      <AnimatePresence>
        {isOpen ? (
          <motion.section
            key="notification-center"
            role="dialog"
            aria-label={t("nav.notifications")}
            initial={
              reduceMotion
                ? { opacity: 0 }
                : { opacity: 0, transform: move({ y: -6, scale: 0.97 }) }
            }
            animate={{
              opacity: 1,
              ...(reduceMotion ? {} : settle),
              transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
            }}
            exit={{
              opacity: 0,
              ...(reduceMotion
                ? {}
                : { transform: [REST, move({ y: -4, scale: 0.98 })] }),
              transition: { duration: 0.12, ease: [0.4, 0, 1, 1] },
            }}
            style={{ transformOrigin: "100% 0%", right: reach }}
            className="absolute top-full z-[70] mt-2 flex max-h-[min(70dvh,38rem)] w-[min(26rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#171719]/95 shadow-[inset_0_1px_0_rgba(255,255,255,0.055),0_18px_50px_rgba(0,0,0,0.5)] backdrop-blur-2xl"
          >
            <header className="flex items-center justify-between gap-3 px-4 pb-2 pt-3.5">
              <h2 className="text-sm font-black text-white">
                {t("nav.notifications")}
              </h2>
              {live.length > 0 ? (
                <button
                  type="button"
                  onClick={dismissAllNotifications}
                  className="rounded-full px-2.5 py-1 text-xs font-bold text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                >
                  {t("notifications.dismissAll")}
                </button>
              ) : null}
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-1.5">
              {live.length === 0 && earlier.length === 0 ? (
                <p className="px-3 pb-4 pt-2 text-sm text-white/55">
                  {t("notifications.historyEmpty")}
                </p>
              ) : null}

              {live.length > 0 ? (
                <Section
                  title={t("notifications.now")}
                  aside={
                    waiting > 0
                      ? formatTemplate(t("notifications.waiting"), {
                          count: new Intl.NumberFormat(language).format(
                            waiting,
                          ),
                        })
                      : undefined
                  }
                >
                  {live.map((entry) => (
                    <NotificationRow
                      key={entry.id}
                      notification={entry}
                      isLive
                      isExpanded={expandedId === entry.id}
                      onToggle={() =>
                        setExpandedId((id) =>
                          id === entry.id ? null : entry.id,
                        )
                      }
                    />
                  ))}
                </Section>
              ) : null}

              {earlier.length > 0 ? (
                <Section
                  title={t("notifications.earlier")}
                  aside={
                    <button
                      type="button"
                      onClick={clearNotificationHistory}
                      className="rounded-full px-2 py-0.5 text-[0.6875rem] font-bold text-white/45 transition-colors hover:bg-white/10 hover:text-white/80"
                    >
                      {t("notifications.clearHistory")}
                    </button>
                  }
                >
                  {earlier.map((entry) => (
                    <NotificationRow
                      key={entry.id}
                      notification={entry}
                      isLive={false}
                      isExpanded={expandedId === entry.id}
                      onToggle={() =>
                        setExpandedId((id) =>
                          id === entry.id ? null : entry.id,
                        )
                      }
                    />
                  ))}
                </Section>
              ) : null}
            </div>
          </motion.section>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="pt-1">
      <div className="flex min-h-7 items-center justify-between gap-2 px-2.5">
        <h3 className="text-[0.6875rem] font-black uppercase tracking-[0.08em] text-white/40">
          {title}
        </h3>
        {typeof aside === "string" ? (
          <span className="text-[0.6875rem] font-bold tabular-nums text-white/45">
            {aside}
          </span>
        ) : (
          aside
        )}
      </div>
      <ul className="space-y-0.5">{children}</ul>
    </section>
  );
}

/**
 * A spinner whose painted weight stays centred as it turns: two opposed arcs
 * carry the same ink either side of the centre, so the glyph reads as
 * stationary. Its dashes advance round a fixed circle (index.css) rather than
 * the glyph rotating, which Safari draws on a fractional-pixel orbit at
 * non-default page zoom.
 */
function BalancedSpinner({ className }: { className?: string }) {
  return (
    <span className={className} aria-hidden="true" data-notification-spinner>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        className="block h-full w-full"
      >
        <circle
          cx="12"
          cy="12"
          r="9"
          pathLength="360"
          strokeDasharray="140 40 140 40"
          className="notification-spinner-ring"
        />
      </svg>
    </span>
  );
}

const TONE_ICONS: Record<
  NotificationTone,
  typeof Info | typeof BalancedSpinner
> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
  progress: BalancedSpinner,
};

function NotificationRow({
  notification,
  isLive,
  isExpanded,
  onToggle,
}: {
  notification: SeyirlikNotification;
  isLive: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const { t, language } = useLanguage();
  const task = notification.task;
  const kind = task?.titleKey ? t(task.titleKey) : notification.title;
  const Icon =
    task?.status === "cancelled"
      ? Ban
      : task?.status === "paused"
        ? Pause
        : task?.status === "queued"
          ? CornerUpRight
          : TONE_ICONS[notification.tone];
  const accent = resolveNotificationAccent(notification.tone, task?.type);
  const hasProgress =
    isLive &&
    typeof notification.progress === "number" &&
    Number.isFinite(notification.progress) &&
    (!task ||
      ((task.status === "running" || task.status === "paused") &&
        task.determinate));
  const decimals = task?.encoding ? 1 : 0;
  const percent = hasProgress
    ? progressPercent(notification.progress as number, decimals)
    : undefined;
  const percentText =
    percent === undefined
      ? undefined
      : new Intl.NumberFormat(language, {
          style: "percent",
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        }).format(percent / 100);
  const subject = task?.subject;
  const heading =
    (subject?.deleted
      ? t("tasks.deleted")
      : subject?.unnamed
        ? t("tasks.unnamed")
        : (subject?.label ?? subject?.code)) ?? kind;
  const place = subject?.label ? subject.code : undefined;
  const status =
    task && task.status !== "running" ? t(`tasks.${task.status}`) : undefined;
  const when = new Date(
    notification.updatedAt ?? notification.createdAt,
  ).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" });
  const trailing = percentText ?? (isLive ? status : when);
  const line =
    heading !== kind ? kind : (notification.description ?? status ?? null);
  const canExpand = Boolean(
    task || (notification.description && line !== notification.description),
  );
  const bodyId = `notification-detail-${notification.id}`;

  return (
    <li
      data-notification-row
      data-notification-id={notification.id}
      className={`rounded-xl ${isLive ? "bg-white/[0.04]" : ""}`}
      style={{ "--notification-accent": accent } as React.CSSProperties}
    >
      <div className="flex items-start gap-1">
        <button
          type="button"
          onClick={canExpand ? onToggle : undefined}
          aria-expanded={canExpand ? isExpanded : undefined}
          {...(canExpand && isExpanded ? { "aria-controls": bodyId } : {})}
          className={`flex min-w-0 flex-1 items-start gap-2.5 rounded-xl px-2.5 py-2.5 text-left ${
            canExpand
              ? "transition-colors hover:bg-white/[0.05]"
              : "cursor-default"
          }`}
        >
          <Icon
            className={`mt-0.5 h-4 w-4 shrink-0 ${
              isLive
                ? "text-[color:var(--notification-accent)]"
                : "text-white/45"
            }`}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5 text-sm leading-5">
              <span
                className={`truncate font-bold ${isLive ? "text-white/90" : "text-white/70"}`}
              >
                {heading}
              </span>
              {place ? (
                <span className="shrink-0 font-semibold tabular-nums text-white/50">
                  {place}
                </span>
              ) : null}
            </span>
            {line ? (
              <span className="mt-0.5 block truncate text-xs font-semibold text-white/50">
                {line}
              </span>
            ) : null}
          </span>
          {trailing ? (
            <span
              className={`shrink-0 pt-0.5 text-xs font-bold tabular-nums ${
                percentText
                  ? "text-[color:var(--notification-accent)]"
                  : "text-white/40"
              }`}
            >
              {trailing}
            </span>
          ) : null}
        </button>
        {isLive ? (
          <button
            type="button"
            onClick={() => dismissNotification(notification.id)}
            aria-label={t("notifications.dismiss")}
            className="mr-1 mt-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/45 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {percent !== undefined ? (
        <div
          role="progressbar"
          aria-label={heading}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="mx-2.5 mb-2.5 h-1 overflow-hidden rounded-full bg-white/[0.1]"
        >
          <div
            className="h-full origin-left bg-[color:var(--notification-accent)] transition-transform duration-500 ease-out motion-reduce:transition-none"
            style={{ transform: `scaleX(${percent / 100})` }}
          />
        </div>
      ) : null}

      {canExpand && isExpanded ? (
        <div id={bodyId} className="px-2.5 pb-3 pl-9">
          {notification.description && line !== notification.description ? (
            <p className="text-xs font-semibold leading-5 text-white/70">
              {notification.description}
            </p>
          ) : null}
          {task ? <TaskDetails notification={notification} /> : null}
        </div>
      ) : null}
    </li>
  );
}
