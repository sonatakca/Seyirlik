import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Headphones,
  Pause,
  Play,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import { setPageTitle } from "../../lib/pageTitle";
import { getNarrationAudioUrl } from "../../lib/bookNarrationApi";
import {
  getNarratedBooks,
  getNarrationReview,
  removeNarrationPronunciation,
  requestNarrationRetake,
  setNarrationPronunciation,
  type NarratedBook,
  type NarrationPronunciation,
  type NarrationReview,
  type NarrationReviewLine,
  type NarrationReviewSection,
} from "../../lib/narrationReviewApi";
import { formatDuration } from "../reader/readerText";
import {
  awaitingRetake,
  compareLine,
  formatAt,
  lineIssues,
  pronunciationKey,
  type LineComparison,
  type ReviewFilter,
} from "./narrationReviewModel";

/** A line heard this far from the book is worth a listen (Sergievi as Serciyevi is 0.22). */
const LISTEN_SEVERITY = 0.2;
/** While the narrator has changes to read, the page asks how far it got this often. */
const REFRESH_MS = 20_000;

type Filter = ReviewFilter | "different";

interface Row {
  section: NarrationReviewSection;
  line: NarrationReviewLine;
  comparison: LineComparison;
  issues: ReturnType<typeof lineIssues>;
}

/**
 * The narrator's work, line by line, beside the book.
 *
 * The narrator already judges every take (did it say every word, does it end
 * in a cry the book does not have) and reads again what fails. What it cannot
 * judge is whether a word that sounds right to Whisper is right to a reader,
 * or a name it says wrong every time. This page is where a person listens to
 * the lines most likely to be wrong, and puts them right: a word said another
 * way in every book, or one line read again. Either goes to the narrator at
 * once; it reads only what changed.
 */
export function NarrationReviewPage() {
  const { itemId } = useParams();
  const { t } = useLanguage();
  const [books, setBooks] = useState<NarratedBook[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setPageTitle(`${t("admin.narration.title")} · Seyirlik`, {
      canonicalPath: "/admin/narration",
      robots: "noindex, nofollow",
    });
  }, [t]);

  useEffect(() => {
    let current = true;
    getNarratedBooks().then(
      (rows) => current && setBooks(rows),
      () => current && setFailed(true),
    );
    return () => {
      current = false;
    };
  }, [itemId]);

  const book = books?.find((row) => row.itemId === itemId) ?? null;

  return (
    <div className="w-full space-y-6">
      <header>
        {itemId ? (
          <Link
            to="/admin/narration"
            className="mb-3 inline-flex items-center gap-1.5 rounded-lg text-sm font-bold text-white/50 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <ArrowLeft size={15} aria-hidden="true" />
            {t("admin.narration.back")}
          </Link>
        ) : null}
        <h1 className="text-3xl font-black text-white">
          {book?.title ?? t("admin.narration.title")}
        </h1>
        <p className="mt-1 text-sm font-semibold text-white/50">
          {book ? t("admin.narration.title") : t("admin.narration.description")}
        </p>
      </header>

      {failed ? <Alert>{t("admin.narration.loadFailed")}</Alert> : null}

      {itemId ? (
        <BookReview key={itemId} itemId={itemId} />
      ) : (
        <BookList books={books} />
      )}
    </div>
  );
}

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-2xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm font-bold text-red-200"
    >
      {children}
    </p>
  );
}

function stateKey(state: string): TranslationKey {
  return `reader.narration.${state}` as TranslationKey;
}

function BookList({ books }: { books: NarratedBook[] | null }) {
  const { t } = useLanguage();
  if (books === null) return null;
  return (
    <section className="rounded-3xl border border-white/10 bg-white/[0.05] p-5">
      <h2 className="text-lg font-black text-white">
        {t("admin.narration.books")}
      </h2>
      {books.length === 0 ? (
        <p className="mt-2 text-sm font-semibold text-white/50">
          {t("admin.narration.noBooks")}
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {books.map((book) => (
            <li key={book.itemId}>
              <Link
                to={`/admin/narration/${book.itemId}`}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl border border-white/10 bg-black/25 px-4 py-3 transition hover:border-white/25 hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <Headphones
                  size={16}
                  className="shrink-0 text-white/40"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate text-sm font-bold text-white/85">
                  {book.title}
                </span>
                <span className="text-xs font-bold text-white/45">
                  {t(stateKey(book.state))} ·{" "}
                  {formatDuration(
                    Math.max(1, Math.round(book.duration / 60)),
                    t,
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BookReview({ itemId }: { itemId: string }) {
  const { t } = useLanguage();
  const [review, setReview] = useState<NarrationReview | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>("issues");
  const [editing, setEditing] = useState<{
    chunk: string;
    word: string;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [asking, setAsking] = useState<Set<string>>(() => new Set());
  const [askFailed, setAskFailed] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await getNarrationReview(itemId, { signal });
        setReview(next);
        setFailed(false);
      } catch {
        if (!signal?.aborted) setFailed(true);
      }
    },
    [itemId],
  );

  useEffect(() => {
    const controller = new AbortController();
    getNarrationReview(itemId, { signal: controller.signal }).then(
      (next) => setReview(next),
      () => {
        if (!controller.signal.aborted) setFailed(true);
      },
    );
    return () => controller.abort();
  }, [itemId]);

  const rows = useMemo<Row[]>(() => {
    if (!review) return [];
    return review.sections.flatMap((section) =>
      (section.lines ?? []).map((line) => {
        const comparison = compareLine(line, review.pronunciations);
        return {
          section,
          line,
          comparison,
          issues: lineIssues(line, comparison),
        };
      }),
    );
  }, [review]);

  // While changes are on their way, follow them in.
  const moving =
    review !== null &&
    (review.narration.state === "queued" ||
      review.narration.state === "narrating" ||
      rows.some((row) => awaitingRetake(row.line)));
  useEffect(() => {
    if (!moving) return undefined;
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [moving, load]);

  const toListen = (row: Row) =>
    row.line.reasons.length > 0 || row.comparison.severity >= LISTEN_SEVERITY;
  const shown = useMemo(() => {
    if (filter === "all") return rows;
    const kept = rows.filter((row) =>
      filter === "issues" ? toListen(row) : row.comparison.differs,
    );
    // The narrator's own doubts first, then what was heard furthest from the book.
    return [...kept].sort(
      (a, b) =>
        Number(b.line.reasons.length > 0) - Number(a.line.reasons.length > 0) ||
        b.comparison.severity - a.comparison.severity ||
        a.section.section - b.section.section ||
        a.line.at - b.line.at,
    );
  }, [rows, filter]);

  const { ref: audioRef, playing, toggle } = useLinePlayer(itemId);

  const askAgain = async (line: NarrationReviewLine) => {
    setAsking((current) => new Set(current).add(line.chunk));
    setAskFailed(null);
    try {
      await requestNarrationRetake(itemId, line.chunk);
      await load();
    } catch {
      setAskFailed(line.chunk);
    } finally {
      setAsking((current) => {
        const next = new Set(current);
        next.delete(line.chunk);
        return next;
      });
    }
  };

  const savePronunciation = async (word: string, spoken: string) => {
    const saved = await setNarrationPronunciation(word, spoken);
    setNotice(
      saved.books === 0
        ? t("admin.narration.savedNone")
        : saved.books === 1
          ? t("admin.narration.savedOne")
          : t("admin.narration.saved").replace("{books}", String(saved.books)),
    );
    setEditing(null);
    await load();
  };

  const removePronunciation = async (word: string) => {
    await removeNarrationPronunciation(word);
    setNotice(t("admin.narration.removed"));
    await load();
  };

  if (failed && !review)
    return <Alert>{t("admin.narration.loadFailed")}</Alert>;
  if (!review) return null;

  const state = review.narration.state;
  const listen = rows.filter(toListen).length;
  const different = rows.filter((row) => row.comparison.differs).length;
  const missing = review.sections.filter((section) => section.lines === null);

  return (
    <div className="space-y-5">
      {state === "queued" || state === "narrating" ? (
        <p
          role="status"
          className="flex items-center gap-2 rounded-2xl border border-[var(--accent)]/25 bg-[var(--accent)]/10 px-4 py-3 text-sm font-bold text-white/80"
        >
          <RotateCcw
            size={15}
            className="shrink-0 text-[var(--accent)]"
            aria-hidden="true"
          />
          {state === "narrating"
            ? t("admin.narration.working")
            : t("admin.narration.waiting")}
        </p>
      ) : null}

      <PronunciationList
        pronunciations={review.pronunciations}
        notice={notice}
        onSave={savePronunciation}
        onRemove={removePronunciation}
      />

      <section aria-labelledby="narration-lines" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="narration-lines" className="text-sm font-bold text-white/60">
            {t("admin.narration.summary")
              .replace("{lines}", rows.length.toLocaleString())
              .replace("{listen}", listen.toLocaleString())
              .replace("{different}", different.toLocaleString())}
          </h2>
          <div
            role="radiogroup"
            aria-label={t("admin.narration.filterLabel")}
            className="inline-flex rounded-xl border border-white/10 bg-black/30 p-0.5"
          >
            {(["issues", "different", "all"] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={filter === option}
                onClick={() => setFilter(option)}
                className={`rounded-[0.625rem] px-3 py-1.5 text-xs font-black transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                  filter === option
                    ? "bg-white/[0.12] text-white"
                    : "text-white/50 hover:text-white"
                }`}
              >
                {t(`admin.narration.filter.${option}` as TranslationKey)}
              </button>
            ))}
          </div>
        </div>

        <p className="text-xs font-semibold text-white/35">
          {t("admin.narration.wordHint")}
        </p>

        {missing.map((section) => (
          <p
            key={section.section}
            className="rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm font-semibold text-white/50"
          >
            {t("admin.narration.section").replace(
              "{n}",
              String(section.section + 1),
            )}
            {" · "}
            {t("admin.narration.noLines")}
          </p>
        ))}

        {shown.length === 0 && missing.length < review.sections.length ? (
          <p className="rounded-2xl border border-white/10 bg-black/25 px-4 py-6 text-center text-sm font-semibold text-white/45">
            {t("admin.narration.nothing")}
          </p>
        ) : null}

        <ol className="space-y-2">
          {shown.map((row) => (
            <LineRow
              key={row.line.chunk}
              row={row}
              playing={playing === row.line.chunk}
              onPlay={() => toggle(row.section, row.line)}
              asking={asking.has(row.line.chunk)}
              askFailed={askFailed === row.line.chunk}
              onAskAgain={() => void askAgain(row.line)}
              editingWord={
                editing?.chunk === row.line.chunk ? editing.word : null
              }
              onEditWord={(word) =>
                setEditing(word ? { chunk: row.line.chunk, word } : null)
              }
              onSavePronunciation={savePronunciation}
              pronunciations={review.pronunciations}
            />
          ))}
        </ol>
      </section>
      <audio ref={audioRef} preload="none" className="hidden" />
    </div>
  );
}

/** Plays one line of a section's audio, from where it starts to where it ends. */
function useLinePlayer(itemId: string) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const end = useRef(0);
  const frame = useRef(0);

  const stop = useCallback(() => {
    window.cancelAnimationFrame(frame.current);
    ref.current?.pause();
    setPlaying(null);
  }, []);

  useEffect(() => stop, [stop]);

  const toggle = useCallback(
    (section: NarrationReviewSection, line: NarrationReviewLine) => {
      const audio = ref.current;
      if (!audio) return;
      if (playing === line.chunk) {
        stop();
        return;
      }
      window.cancelAnimationFrame(frame.current);
      const url = getNarrationAudioUrl(itemId, section);
      if (audio.dataset.src !== url) {
        audio.src = url;
        audio.dataset.src = url;
      }
      end.current = (line.at + line.duration) / 1000;
      audio.currentTime = line.at / 1000;
      setPlaying(line.chunk);
      // Checked every frame: timeupdate comes four times a second, and the
      // next line would be heard for a quarter of one.
      const watch = () => {
        if (audio.currentTime >= end.current || audio.ended) {
          stop();
          return;
        }
        frame.current = window.requestAnimationFrame(watch);
      };
      audio.play().then(
        () => {
          frame.current = window.requestAnimationFrame(watch);
        },
        () => setPlaying(null),
      );
    },
    [itemId, playing, stop],
  );

  return { ref, playing, toggle };
}

const REASON_STYLE: Record<string, string> = {
  tone: "border-amber-300/30 bg-amber-300/10 text-amber-200",
  "skipped-words": "border-red-300/30 bg-red-300/10 text-red-200",
  pronunciation: "border-sky-300/30 bg-sky-300/10 text-sky-200",
  length: "border-red-300/30 bg-red-300/10 text-red-200",
  "heard-otherwise": "border-white/15 bg-white/[0.06] text-white/70",
};

const LineRow = memo(function LineRow({
  row,
  playing,
  onPlay,
  asking,
  askFailed,
  onAskAgain,
  editingWord,
  onEditWord,
  onSavePronunciation,
  pronunciations,
}: {
  row: Row;
  playing: boolean;
  onPlay: () => void;
  asking: boolean;
  askFailed: boolean;
  onAskAgain: () => void;
  editingWord: string | null;
  onEditWord: (word: string | null) => void;
  onSavePronunciation: (word: string, spoken: string) => Promise<void>;
  pronunciations: NarrationPronunciation[];
}) {
  const { t } = useLanguage();
  const { section, line, comparison, issues } = row;
  const waiting = awaitingRetake(line);
  const at = formatAt(line.at);

  // The line's text with its marked words, in order.
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  comparison.words.forEach((word, index) => {
    if (word.status === "same" && !word.unsure) return;
    if (word.start > cursor) parts.push(line.text.slice(cursor, word.start));
    const written = line.text.slice(word.start, word.end);
    const label =
      word.status === "changed"
        ? t("admin.narration.heardAs").replace("{heard}", word.heard ?? "")
        : word.status === "missing"
          ? t("admin.narration.notHeard")
          : t("admin.narration.unsure");
    parts.push(
      <button
        key={index}
        type="button"
        title={label}
        aria-label={`${written}: ${label}`}
        onClick={() => onEditWord(written)}
        className={`rounded-sm underline decoration-2 underline-offset-4 transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
          word.status === "changed"
            ? "text-amber-100 decoration-amber-300/70"
            : word.status === "missing"
              ? "text-white/40 line-through decoration-red-300/70"
              : "decoration-white/35 decoration-dotted"
        }`}
      >
        {written}
      </button>,
    );
    cursor = word.end;
  });
  if (cursor < line.text.length) parts.push(line.text.slice(cursor));

  const action = waiting ? (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl border border-[var(--accent)]/30 px-3 py-1.5 text-xs font-black text-[var(--accent)]">
      <RotateCcw size={13} aria-hidden="true" />
      {t("admin.narration.retakeWaiting")}
    </span>
  ) : (
    <button
      type="button"
      disabled={asking}
      onClick={onAskAgain}
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl border border-white/15 px-3 py-1.5 text-xs font-black text-white/75 transition hover:border-white/30 hover:text-white disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    >
      <RotateCcw size={13} aria-hidden="true" />
      {t("admin.narration.retake")}
    </button>
  );

  return (
    <li className="rounded-2xl border border-white/10 bg-black/25 px-4 py-3">
      {/* One action, beside the line where there is room and under it on a phone. */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
        <button
          type="button"
          onClick={onPlay}
          aria-label={
            playing
              ? t("admin.narration.stop")
              : t("admin.narration.play").replace("{at}", at)
          }
          aria-pressed={playing}
          className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
            playing
              ? "bg-[var(--accent)] text-black"
              : "bg-white/[0.08] text-white/80 hover:bg-white/[0.14]"
          }`}
        >
          {playing ? (
            <Pause size={15} aria-hidden="true" />
          ) : (
            <Play size={15} className="translate-x-px" aria-hidden="true" />
          )}
        </button>

        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.6875rem] font-bold text-white/40">
            <span className="tabular-nums">
              {t("admin.narration.section").replace(
                "{n}",
                String(section.section + 1),
              )}{" "}
              · {at}
            </span>
            {issues.map((issue) => (
              <span
                key={issue}
                className={`whitespace-nowrap rounded-full border px-2 py-px font-black uppercase tracking-[0.08em] ${REASON_STYLE[issue] ?? ""}`}
              >
                {t(`admin.narration.reason.${issue}` as TranslationKey)}
              </span>
            ))}
          </div>

          <p className="text-[0.9375rem] leading-7 text-white/85">{parts}</p>

          <p className="text-sm leading-6 text-white/45">
            <span className="font-bold text-white/30">
              {t("admin.narration.heard")}:{" "}
            </span>
            {line.heard || "—"}
          </p>
          {comparison.extra.length > 0 ? (
            <p className="text-xs font-semibold text-amber-200/70">
              {t("admin.narration.extra").replace(
                "{words}",
                comparison.extra.join(" "),
              )}
            </p>
          ) : null}

          {editingWord ? (
            <PronunciationForm
              word={editingWord}
              current={
                pronunciations.find(
                  (row) => row.word === pronunciationKey(editingWord),
                )?.spoken ?? ""
              }
              onSave={onSavePronunciation}
              onCancel={() => onEditWord(null)}
            />
          ) : null}
          {askFailed ? (
            <p role="alert" className="text-xs font-bold text-red-200">
              {t("admin.narration.retakeFailed")}
            </p>
          ) : null}
        </div>

        <div className="col-start-2 sm:col-start-3 sm:row-start-1">
          {action}
        </div>
      </div>
    </li>
  );
});

function PronunciationForm({
  word,
  current,
  onSave,
  onCancel,
}: {
  /** The word as the book writes it, perhaps with a suffix. */
  word: string;
  current: string;
  onSave: (word: string, spoken: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const { t } = useLanguage();
  const stem = word.split(/['’]/)[0] ?? word;
  const [spoken, setSpoken] = useState(current || stem);
  const [written, setWritten] = useState(stem);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<TranslationKey | null>(null);
  const free = !word;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const target = free ? written.trim() : stem;
    if (!target || /\s/.test(target)) {
      setFailed("admin.narration.notOneWord");
      return;
    }
    setSaving(true);
    setFailed(null);
    try {
      await onSave(target, spoken.trim());
      if (free) {
        setWritten("");
        setSpoken("");
      }
    } catch {
      setFailed("admin.narration.saveFailed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="flex flex-wrap items-end gap-2 rounded-xl border border-white/10 bg-white/[0.04] p-3"
    >
      {free ? (
        <label className="flex min-w-[9rem] flex-1 flex-col gap-1 text-xs font-bold text-white/50">
          {t("admin.narration.word")}
          <input
            value={written}
            onChange={(event) => setWritten(event.target.value)}
            className="rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm font-semibold text-white outline-none focus:border-[var(--accent)]"
          />
        </label>
      ) : null}
      <label className="flex min-w-[12rem] flex-[2] flex-col gap-1 text-xs font-bold text-white/50">
        {free
          ? t("admin.narration.spoken")
          : t("admin.narration.howSaid").replace("{word}", stem)}
        <input
          value={spoken}
          autoFocus={!free}
          placeholder={t("admin.narration.spokenPlaceholder")}
          onChange={(event) => setSpoken(event.target.value)}
          className="rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm font-semibold text-white outline-none focus:border-[var(--accent)]"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving || !spoken.trim()}
          className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-black text-black transition disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          {t("admin.narration.save")}
        </button>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-2 text-xs font-black text-white/60 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            {t("admin.narration.cancel")}
          </button>
        ) : null}
      </div>
      {failed ? (
        <p role="alert" className="w-full text-xs font-bold text-red-200">
          {t(failed)}
        </p>
      ) : null}
    </form>
  );
}

function PronunciationList({
  pronunciations,
  notice,
  onSave,
  onRemove,
}: {
  pronunciations: NarrationPronunciation[];
  notice: string | null;
  onSave: (word: string, spoken: string) => Promise<void>;
  onRemove: (word: string) => Promise<void>;
}) {
  const { t } = useLanguage();
  return (
    <section className="rounded-3xl border border-white/10 bg-white/[0.05] p-5">
      <h2 className="text-lg font-black text-white">
        {t("admin.narration.pronunciations")}
      </h2>
      <p className="mt-1 text-sm font-semibold text-white/50">
        {t("admin.narration.pronunciationsHint")}
      </p>
      {notice ? (
        <p role="status" className="mt-3 text-sm font-bold text-emerald-300">
          {notice}
        </p>
      ) : null}
      {pronunciations.length === 0 ? (
        <p className="mt-3 text-sm font-semibold text-white/40">
          {t("admin.narration.noPronunciations")}
        </p>
      ) : (
        <ul className="mt-3 flex flex-wrap gap-2">
          {pronunciations.map((row) => (
            <li
              key={row.word}
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-black/30 py-1 pl-3 pr-1 text-sm"
            >
              <span className="font-bold text-white/85">{row.word}</span>
              <span className="text-white/30" aria-hidden="true">
                →
              </span>
              <span className="font-semibold text-[var(--accent)]">
                {row.spoken}
              </span>
              <button
                type="button"
                aria-label={t("admin.narration.remove").replace(
                  "{word}",
                  row.word,
                )}
                onClick={() => void onRemove(row.word)}
                className="rounded-lg p-1.5 text-white/40 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3">
        <PronunciationForm word="" current="" onSave={onSave} />
      </div>
    </section>
  );
}
