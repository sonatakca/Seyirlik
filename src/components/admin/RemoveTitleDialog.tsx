import { useCallback, useEffect, useRef, useState } from "react";
import { useLanguage } from "../../i18n/LanguageContext";
import { formatBytes, type LibraryTitle } from "../../lib/libraryAdminApi";
import { removalFailureKey, startTitleRemoval } from "./titleRemovalProgress";

/**
 * The one irreversible action on the Wanted page.
 *
 * The title has to be typed, not clicked: a mis-aimed click can land on any
 * button, but it cannot spell a film's name. The server checks the same thing,
 * so this dialog is a courtesy and not the control.
 *
 * It waits only for the server to take the title out of the catalogue, which
 * is where a refusal comes from. Deleting the files follows in the corner card
 * (`titleRemovalProgress`), and even the wait can be handed over to it: while
 * the request is out, Cancel becomes "continue in background".
 */
export function RemoveTitleDialog({
  title,
  onClose,
}: {
  title: LibraryTitle;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const [typed, setTyped] = useState("");
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const running = useRef<ReturnType<typeof startTitleRemoval> | null>(null);
  const matches = typed.trim() === title.title.trim();

  // Closing while the request is out hands it to the corner card; it does not
  // cancel anything, since the server may already be past the point of no return.
  const close = useCallback(() => {
    running.current?.hide();
    onClose();
  }, [onClose]);

  useEffect(() => {
    input.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  async function remove() {
    setWorking(true);
    setFailure(null);
    const removal = startTitleRemoval(title, typed, t);
    running.current = removal;
    try {
      await removal.result;
      running.current = null;
      onClose();
    } catch (error) {
      running.current = null;
      setFailure(t(removalFailureKey(error)));
      setWorking(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="remove-title-heading"
        aria-describedby="remove-title-description"
        className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0a0b0e] p-6 shadow-2xl"
      >
        <h2 id="remove-title-heading" className="text-lg font-black text-white">
          {t("library.removeHeading")} {title.title}
        </h2>
        <div
          id="remove-title-description"
          className="mt-3 space-y-2 text-sm text-white/70"
        >
          <p>{t("library.removeExplanation")}</p>
          {title.sizeBytes > 0 ? (
            <p className="font-bold text-rose-200">
              {t("library.removeSize")} {formatBytes(title.sizeBytes)}
            </p>
          ) : null}
          <p className="font-bold text-white/85">
            {t("library.removeIrreversible")}
          </p>
        </div>
        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (matches && !working) void remove();
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-bold text-white/60">
            {t("library.removeType")}{" "}
            <span className="select-all font-black text-white">
              {title.title}
            </span>
            <input
              ref={input}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="mt-1 min-h-10 rounded-lg border border-white/15 bg-black/40 px-3 text-sm text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
            />
          </label>
          {failure ? (
            <p role="alert" className="text-sm text-red-200">
              {failure}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={close}
              className="min-h-10 rounded-lg px-4 text-sm font-bold text-white/75 hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              {working ? t("library.removeHide") : t("library.cancel")}
            </button>
            <button
              type="submit"
              disabled={!matches || working}
              className="min-h-10 rounded-lg bg-rose-500/90 px-4 text-sm font-black text-white hover:bg-rose-500 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-200"
            >
              {working ? t("library.removing") : t("library.removeConfirm")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
