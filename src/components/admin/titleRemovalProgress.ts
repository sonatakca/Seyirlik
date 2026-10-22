import type { TranslationKey } from "../../i18n/translations";
import {
  formatBytes,
  getTitleRemoval,
  removeLibraryTitle,
  type LibraryTitle,
  type TitleRemovalReport,
} from "../../lib/libraryAdminApi";
import { notify } from "../../lib/notifications/notificationStore";

/**
 * A title removal, held outside React.
 *
 * Emptying a title folder on the Drive mount can take minutes, so neither the
 * dialog nor the page that opened it may own the work: the dialog can be
 * hidden, the page left, and the outcome still has to be said. One corner card
 * per removal follows it from "removing" to what was actually deleted.
 */

type Translate = (key: TranslationKey) => string;

const POLL_MS = 2_000;
/** Consecutive failed reads before the card stops asking. */
const POLL_GIVE_UP = 15;

const removedListeners = new Set<(itemId: string) => void>();

/** Called once a title is out of the catalogue, whoever is still listening. */
export function onTitleRemoved(listener: (itemId: string) => void) {
  removedListeners.add(listener);
  return () => {
    removedListeners.delete(listener);
  };
}

export function removalFailureKey(error: unknown): TranslationKey {
  const code = (error as { code?: string }).code;
  return code === "REMOVAL_BUSY"
    ? "library.removeBusy"
    : code === "REMOVAL_CONFIRMATION"
      ? "library.removeMismatch"
      : code === "REMOVAL_UNSAFE"
        ? "library.removeUnsafe"
        : "library.removeFailed";
}

const cardKey = (itemId: string) => `title-removal:${itemId}`;

function lateFailureKey(
  failure: TitleRemovalReport["failure"],
): TranslationKey {
  return failure === "busy"
    ? "library.removeBusy"
    : failure === "unsafe"
      ? "library.removeUnsafe"
      : "library.removeFailed";
}

/** Says where one removal stands; true once there is nothing left to follow. */
function say(
  report: TitleRemovalReport,
  title: LibraryTitle,
  t: Translate,
): boolean {
  const key = cardKey(title.id);
  const running = `${t("library.removalRunning")} ${title.title}`;
  const removed = `${t("library.removed")} ${title.title}`;
  const size = title.sizeBytes > 0 ? formatBytes(title.sizeBytes) : null;
  switch (report.state) {
    case "removing":
      notify({
        key,
        tone: "progress",
        title: running,
        description: t("library.removalCommitting"),
      });
      return false;
    case "deleting":
      notify({
        key,
        tone: "progress",
        title: running,
        description: size
          ? `${t("library.removalDeleting")} ${size}`
          : t("library.removalDeletingFiles"),
      });
      return false;
    case "failed":
      notify({
        key,
        tone: "error",
        title: `${t("library.removalFailedTitle")} ${title.title}`,
        description: t(lateFailureKey(report.failure)),
      });
      return true;
    case "done":
      notify(
        report.leftovers.length
          ? {
              key,
              tone: "error",
              title: removed,
              description: `${t("library.removedWithLeftovers")} ${report.leftovers.join(", ")}`,
            }
          : {
              key,
              tone: "success",
              life: "long",
              title: removed,
              ...(size
                ? { description: `${t("library.removalDeleted")} ${size}` }
                : {}),
            },
      );
      return true;
  }
}

/**
 * The server forgot the removal — it restarted. Past the catalogue that only
 * cost the confirmation; before it, the title may still be listed.
 */
function sayForgotten(
  last: TitleRemovalReport["state"],
  title: LibraryTitle,
  t: Translate,
) {
  notify(
    last === "removing"
      ? {
          key: cardKey(title.id),
          tone: "warning",
          title: `${t("library.removalRunning")} ${title.title}`,
          description: t("library.removalInterrupted"),
        }
      : {
          key: cardKey(title.id),
          tone: "success",
          life: "long",
          title: `${t("library.removed")} ${title.title}`,
          description: t("library.removalUnknown"),
        },
  );
}

function follow(first: TitleRemovalReport, title: LibraryTitle, t: Translate) {
  let last = first.state;
  let announced = false;
  const step = (report: TitleRemovalReport) => {
    last = report.state;
    // The catalogue has let go: rows, pages and dialogs about it can go too.
    if (
      !announced &&
      (report.state === "deleting" || report.state === "done")
    ) {
      announced = true;
      for (const listener of removedListeners) listener(title.id);
    }
    return say(report, title, t);
  };
  if (step(first)) return;
  let failures = 0;
  const poll = async () => {
    try {
      const status = await getTitleRemoval(title.id);
      failures = 0;
      if (status === null) return sayForgotten(last, title, t);
      if (step(status)) return;
    } catch {
      // A restart mid-removal reads as failed requests for a while.
      if (++failures >= POLL_GIVE_UP) return sayForgotten(last, title, t);
    }
    window.setTimeout(() => void poll(), POLL_MS);
  };
  window.setTimeout(() => void poll(), POLL_MS);
}

/**
 * Asks the server to remove a title. The returned promise settles once the
 * server has checked the request (or refused it); the removal itself is
 * followed from there by the corner card.
 *
 * `hide` is for a dialog closed while the request is still out: from then on
 * the card says what is happening, including a refusal nobody is left to read
 * inline.
 */
export function startTitleRemoval(
  title: LibraryTitle,
  typed: string,
  t: Translate,
) {
  let hidden = false;
  let answered = false;
  const result = removeLibraryTitle(title.id, typed).then(
    (report) => {
      answered = true;
      follow(report, title, t);
      return report;
    },
    (error: unknown) => {
      answered = true;
      if (hidden)
        notify({
          key: cardKey(title.id),
          tone: "error",
          title: `${t("library.removalFailedTitle")} ${title.title}`,
          description: t(removalFailureKey(error)),
        });
      throw error;
    },
  );
  return {
    result,
    hide() {
      if (hidden || answered) return;
      hidden = true;
      notify({
        key: cardKey(title.id),
        tone: "progress",
        title: `${t("library.removalRunning")} ${title.title}`,
        description: t("library.removalCommitting"),
      });
    },
  };
}
