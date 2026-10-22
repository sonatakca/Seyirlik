import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  getNotifications,
  subscribeToNotifications,
} from "../../lib/notifications/notificationStore";
import { progressPercent } from "../../lib/notifications/taskNotifications";
import { useLanguage } from "../../i18n/LanguageContext";

/**
 * Reads notifications out to assistive technology as they arrive.
 *
 * Nothing is drawn: notifications live behind the bell (NotificationCenter),
 * and a screen reader should still hear about a job finishing without having
 * to go and open it. Mounted once at the root, so it speaks on every page,
 * the player included.
 */
export function NotificationAnnouncer() {
  const { t, language } = useLanguage();
  const notifications = useSyncExternalStore(
    subscribeToNotifications,
    getNotifications,
    getNotifications,
  );
  const announced = useRef(new Map<string, string>());
  const liveRegion = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const updates: string[] = [];
    for (const entry of notifications) {
      const detail = entry.task;
      const title = detail?.titleKey ? t(detail.titleKey) : entry.title;
      const bucket =
        detail?.determinate && entry.progress !== undefined
          ? Math.floor(entry.progress / 25)
          : "";
      const signature = detail
        ? `${detail.status}:${detail.stage ?? ""}:${detail.attempts}:${bucket}`
        : `${entry.title}:${entry.description ?? ""}`;
      if (announced.current.get(entry.id) === signature) continue;
      announced.current.set(entry.id, signature);
      /*
       * Read out the way a row is read: which title, which episode, then what
       * is being done to it. A screen reader hearing "Media processing.
       * Queued." twelve times over is the same failure as seeing it.
       */
      const named = [
        detail?.subject?.label,
        detail?.subject?.code,
        detail?.subject?.detail,
      ]
        .filter(Boolean)
        .join(", ");
      const name = named ? `${named}. ${title}` : title;
      updates.push(
        detail
          ? `${name}. ${t(`tasks.${detail.status}`)}${detail.stage ? `. ${t(`tasks.${detail.stage}`)}` : ""}${bucket !== "" ? `. ${new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 0 }).format(progressPercent(entry.progress ?? 0) / 100)}` : ""}`
          : `${entry.title}. ${entry.description ?? ""}`,
      );
    }
    // Notices that are gone can never be announced again; keeping their
    // signatures would only grow a map for the life of the tab.
    if (announced.current.size > notifications.length)
      for (const id of announced.current.keys())
        if (!notifications.some((entry) => entry.id === id))
          announced.current.delete(id);
    if (updates.length && liveRegion.current)
      liveRegion.current.textContent = updates.join(". ");
  }, [notifications, t, language]);

  return (
    <div
      ref={liveRegion}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
    />
  );
}
