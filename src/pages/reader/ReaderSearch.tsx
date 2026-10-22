import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";

import { useLanguage } from "../../i18n/LanguageContext";
import {
  searchBook,
  type BookSearchFound,
  type BookSearchHit,
  type BookSearchOutcome,
} from "../../lib/bookSearchApi";
import { searchExcerpt } from "../../lib/bookSearchText";
import { formatPercent } from "./readerText";

/** How often a book being prepared is asked about again. */
const PREPARING_POLL_MS = 2500;

/**
 * How long a search may take before the wait is explained. A warm search
 * answers well inside this; a slower one is the server loading its model.
 */
const SLOW_SEARCH_MS = 1500;

/**
 * The contents drawer's search: a name, a word or a line of the book, or a
 * moment described in the reader's own words, answered with the passages
 * that hold those words or mean that moment, whatever words the book used.
 *
 * Opening the tab asks the server to prepare the book (a few minutes, once per
 * book); until then it shows how far along that is and asks again.
 */
export function ReaderSearch({
  itemId,
  active,
  hidden = false,
  chapterOf,
  bookPlaceOf,
  onShow,
}: {
  itemId: string;
  /** The tab is on screen: prepare the book, and keep asking while it prepares. */
  active: boolean;
  /** Another tab is shown; the search and its results wait for it. */
  hidden?: boolean;
  /** The chapter a section belongs to, as the contents list names it. */
  chapterOf: (section: number) => string | null;
  /**
   * A place in a section as a share of the whole book, as the reader counts
   * it; null until the reader has measured the book.
   */
  bookPlaceOf?: (section: number, place: number) => number | null;
  onShow: (hit: BookSearchHit, found: BookSearchFound) => void;
}) {
  const { t, language } = useLanguage();
  const [query, setQuery] = useState("");
  /** The question last sent; empty until one is. */
  const [asked, setAsked] = useState("");
  /** Bumped to ask again: a repeat search, or a poll while preparing. */
  const [round, setRound] = useState(0);
  const [outcome, setOutcome] = useState<BookSearchOutcome | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  /** The question whose answer is on screen. */
  const answered = useRef("");

  useEffect(() => {
    if (!busy) {
      return;
    }

    const timer = window.setTimeout(() => setSlow(true), SLOW_SEARCH_MS);
    return () => window.clearTimeout(timer);
  }, [busy]);

  useEffect(() => {
    // Coming back to a question already answered asks nothing again.
    const question = JSON.stringify([itemId, asked, round]);
    if (!active || answered.current === question) {
      return;
    }

    const controller = new AbortController();
    let pollTimer = 0;

    searchBook(itemId, asked, { signal: controller.signal })
      .then((next) => {
        setOutcome(next);
        setFailed(false);
        setBusy(false);
        if (next.state === "ready") {
          answered.current = question;
        }

        if (next.state === "preparing") {
          pollTimer = window.setTimeout(
            () => setRound((value) => value + 1),
            PREPARING_POLL_MS,
          );
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setFailed(true);
          setBusy(false);
        }
      });

    return () => {
      controller.abort();
      window.clearTimeout(pollTimer);
    };
  }, [active, asked, itemId, round]);

  const hits = outcome?.state === "ready" && asked ? outcome.hits : null;
  const found: BookSearchFound =
    outcome?.state === "ready"
      ? {
          terms: outcome.terms ?? [],
          phrase: outcome.phrase ?? [],
          exact: outcome.exact ?? false,
        }
      : { terms: [], phrase: [] };

  const status = (() => {
    // Until the answer comes, whatever is on screen answered something else:
    // saying "nothing matches" now would send the reader away too early.
    if (busy) {
      return (
        <div className="rd-search-preparing" role="status">
          <p className="rd-search-preparing-title">
            {t("reader.search.searching")}
          </p>
          <div className="rd-search-meter" data-searching aria-hidden="true">
            <span />
          </div>
          {slow ? (
            <p className="rd-search-slow">
              {t("reader.search.searchingDetail")}
            </p>
          ) : null}
        </div>
      );
    }

    if (failed) {
      return <p className="rd-empty">{t("reader.search.failed")}</p>;
    }

    if (outcome?.state === "unavailable") {
      return <p className="rd-empty">{t("reader.search.unavailable")}</p>;
    }

    if (outcome?.state === "preparing") {
      const progress = outcome.progress;

      return (
        <div className="rd-search-preparing" role="status">
          <p className="rd-search-preparing-title">
            {t("reader.search.preparing")}
          </p>
          <p>{t("reader.search.preparingDetail")}</p>
          <div
            className="rd-search-meter"
            data-pending={progress === null || undefined}
            role="progressbar"
            aria-label={t("reader.search.preparing")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={
              progress === null ? undefined : Math.round(progress * 100)
            }
          >
            <span
              style={{
                transform:
                  progress === null
                    ? undefined
                    : `translateX(${(progress - 1) * 100}%)`,
              }}
            />
          </div>
        </div>
      );
    }

    if (hits?.length === 0) {
      return <p className="rd-empty">{t("reader.search.noResults")}</p>;
    }

    if (!asked && outcome?.state === "ready") {
      return <p className="rd-empty">{t("reader.search.hint")}</p>;
    }

    return null;
  })();

  return (
    <div className="rd-search" role="tabpanel" hidden={hidden}>
      <form
        className="rd-search-field"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          const next = query.trim();

          if (next) {
            // Results already on screen stay, dimmed, until the new ones come.
            setBusy(true);
            setSlow(false);
            setAsked(next);
            setRound((value) => value + 1);
          }
        }}
      >
        <Search size={16} aria-hidden="true" />
        <input
          type="search"
          data-autofocus
          value={query}
          maxLength={300}
          enterKeyHint="search"
          placeholder={t("reader.search.placeholder")}
          aria-label={t("reader.search.label")}
          onChange={(event) => setQuery(event.target.value)}
        />
      </form>

      {status}

      {hits && hits.length > 0 ? (
        <ol className="rd-list" aria-busy={busy || undefined}>
          {hits.map((hit) => {
            const excerpt = searchExcerpt(hit.text, found);
            const inBook = bookPlaceOf?.(hit.section, hit.place ?? 0) ?? null;
            return (
              <li
                key={`${hit.section}:${hit.block}:${hit.anchor}`}
                className="rd-bookmark rd-search-hit"
              >
                <button
                  type="button"
                  className="rd-bookmark-go"
                  onClick={() => onShow(hit, found)}
                >
                  <span className="rd-bookmark-excerpt">
                    {excerpt.cut ? "…" : null}
                    {excerpt.parts.map((part, at) =>
                      part.marked ? (
                        <mark key={at}>{part.text}</mark>
                      ) : (
                        part.text
                      ),
                    )}
                  </span>
                  <span className="rd-bookmark-label">
                    <span>
                      {chapterOf(hit.section) ?? t("reader.search.inBook")}
                    </span>
                    {inBook !== null ? (
                      <b>{formatPercent(inBook, language)}</b>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
