import { useCallback, useEffect, useState, useRef } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { Download, Search } from "lucide-react";
import { setPageTitle } from "../../lib/pageTitle";
import {
  getMissingSearch,
  searchMissingEpisodes,
  type MissingSearchState,
} from "../../lib/libraryAdminApi";
import { useLanguage } from "../../i18n/LanguageContext";
import { WorkflowSteps } from "../../components/admin/WorkflowSteps";
import {
  canAcquire,
  orderCandidates,
  summarise,
  type JudgedRelease,
} from "../../lib/releaseDecisionPresentation";
import {
  acquireRelease,
  evaluateReleases,
  listProfiles,
  setProfileMaxSize,
  type EvaluateResult,
  type QualityProfile,
  type TitleChoice,
} from "../../lib/releaseDecisionsApi";

/** Sizes are said in decimal gigabytes, the unit the limit is set in. */
const GB = 1_000_000_000;

function choiceText(choice: TitleChoice): string {
  return choice.year ? `${choice.title} (${choice.year})` : choice.title;
}

/** How often a running automatic search is asked how it went. */
const AUTO_POLL_MS = 3_000;

const episodeCode = (season: number, episode: number | null) =>
  `S${String(season).padStart(2, "0")}${
    episode === null ? "" : `E${String(episode).padStart(2, "0")}`
  }`;

/** Where the automatic search for a series has got to. */
type AutoState =
  | { readonly stage: "idle" | "starting" | "none" | "failed" | "absent" }
  | { readonly stage: "running"; readonly message: string | null }
  | {
      readonly stage: "done";
      readonly result: NonNullable<MissingSearchState["result"]>;
    };

/** What the automatic search has done, in one line; null before it starts. */
function describeAuto(
  auto: AutoState,
  t: ReturnType<typeof useLanguage>["t"],
): string | null {
  const named = (entry: { season: number | null; episode: number | null }) =>
    entry.season === null
      ? t("library.missingWholeSeries")
      : episodeCode(entry.season, entry.episode);
  switch (auto.stage) {
    case "idle":
    case "starting":
      return null;
    case "none":
      return t("library.missingNone");
    case "failed":
      return t("admin.decisions.autoFailed");
    case "absent":
      return t("admin.decisions.autoNotInLibrary");
    case "running":
      return `${t("library.missingSearching")} ${auto.message ?? ""}`.trim();
    case "done": {
      const { started, nothing, covered = [] } = auto.result;
      return [
        `${t("library.missingStarted")} ${
          started.length > 0 ? started.map(named).join(", ") : 0
        }`,
        ...(nothing.length > 0
          ? [
              `${t("library.missingNothingFor")} ${nothing.map(named).join(", ")}`,
            ]
          : []),
        ...(covered.length > 0
          ? [
              `${t("library.missingAlreadyComing")} ${covered.map(named).join(", ")}`,
            ]
          : []),
      ].join(" · ");
    }
  }
}

function limitText(profile: QualityProfile | undefined): string {
  if (!profile || typeof profile.maxSizeBytes !== "number") return "";
  return String(Math.round((profile.maxSizeBytes / GB) * 10) / 10);
}

/**
 * What Seyirlik would download for a title, and why it would not download the
 * rest.
 *
 * The point of the page is the explanation. A list of releases with coloured
 * scores tells an operator which one won and nothing about why, which is
 * exactly the state of affairs the decision engine was built to replace.
 */
export function ReleaseDecisionsPage() {
  const { t } = useLanguage();
  const [params] = useSearchParams();
  const [profiles, setProfiles] = useState<QualityProfile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [kind, setKind] = useState<"movie" | "tv">(
    params.get("kind") === "series" ? "tv" : "movie",
  );
  const [title, setTitle] = useState(params.get("title") ?? "");
  const [year, setYear] = useState(params.get("year") ?? "");
  // Empty is every season: releases of the whole series are judged.
  const [season, setSeason] = useState("");
  const [auto, setAuto] = useState<AutoState>({ stage: "idle" });
  const autoVersion = useRef(0);
  useEffect(
    () => () => {
      autoVersion.current += 1;
    },
    [],
  );
  // Which title the words mean, once something has said so: the page that
  // linked here, or the operator choosing an alternative. Editing the words
  // forgets it, since they may now mean something else.
  const [tmdbId, setTmdbId] = useState(params.get("tmdbId") ?? "");
  const [searched, setSearched] = useState<Pick<
    EvaluateResult,
    "resolved" | "alternatives" | "searchedFor"
  > | null>(null);
  const [candidates, setCandidates] = useState<JudgedRelease[] | null>(null);
  const [winnerGuid, setWinnerGuid] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [asked, setAsked] = useState<string[]>([]);
  const [resultQuery, setResultQuery] = useState("");
  // An edit in progress, and the profile it belongs to. Absent, the field
  // shows whatever the selected profile's limit is.
  const [limitDraft, setLimitDraft] = useState<{
    profileId: string;
    text: string;
  } | null>(null);
  const [limitState, setLimitState] = useState<
    "idle" | "saving" | "saved" | "invalid" | "failed"
  >("idle");
  const searchVersion = useRef(0);
  // The limit is part of the query: results judged under an old limit are
  // hidden once it changes, as they are when any other input does.
  const queryKey = JSON.stringify([
    kind,
    title.trim(),
    year.trim(),
    profileId,
    season,
    profiles.find((entry) => entry.id === profileId)?.maxSizeBytes ?? null,
  ]);
  const tvKind =
    kind === "movie" ? "movie" : season.trim() === "" ? "series" : "season";

  useEffect(() => {
    setPageTitle(`${t("admin.decisions.title")} · Seyirlik`, {
      canonicalPath: "/admin/decisions",
      robots: "noindex, nofollow",
    });
  }, [t]);

  useEffect(() => {
    let isCancelled = false;

    void (async () => {
      try {
        const rows = await listProfiles();
        if (isCancelled) return;
        setProfiles(rows);
        if (rows[0]) setProfileId(rows[0].id);
      } catch {
        if (!isCancelled) setFailure("admin.decisions.profilesFailed");
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, []);

  const profile = profiles.find((entry) => entry.id === profileId);

  const sizeLimit =
    limitDraft?.profileId === profileId ? limitDraft.text : limitText(profile);

  const saveLimit = useCallback(async () => {
    if (!profileId) return;
    const text = sizeLimit.trim();
    const gigabytes = Number(text);
    if (text !== "" && (!Number.isFinite(gigabytes) || gigabytes <= 0)) {
      setLimitState("invalid");
      return;
    }
    const maxSizeBytes = text === "" ? null : Math.round(gigabytes * GB);
    setLimitState("saving");
    try {
      await setProfileMaxSize(profileId, maxSizeBytes);
      setProfiles((previous) =>
        previous.map((entry) =>
          entry.id === profileId ? { ...entry, maxSizeBytes } : entry,
        ),
      );
      setLimitDraft(null);
      setLimitState("saved");
    } catch {
      setLimitState("failed");
    }
  }, [profileId, sizeLimit]);

  const search = useCallback(
    async (chosen: string = tmdbId) => {
      const version = ++searchVersion.current;
      setIsSearching(true);
      setFailure(null);
      try {
        const result = await evaluateReleases({
          kind: tvKind,
          ...(tvKind === "season" ? { season: Number(season) } : {}),
          title: title.trim(),
          ...(year.trim() ? { year: Number(year) } : {}),
          ...(profileId ? { profileId } : {}),
          ...(chosen ? { tmdbId: chosen } : {}),
        });
        if (version !== searchVersion.current) return;
        setResultQuery(queryKey);
        setAsked([]);
        setSearched({
          resolved: result.resolved ?? null,
          alternatives: result.alternatives ?? [],
          searchedFor: result.searchedFor,
        });
        setCandidates(result.candidates);
        setWinnerGuid(result.winner?.guid ?? null);
      } catch {
        // Never the thrown message: it can carry the indexer request URL.
        setFailure("admin.decisions.searchFailed");
        setCandidates(null);
      } finally {
        setIsSearching(false);
      }
    },
    [tvKind, profileId, title, year, season, tmdbId, queryKey],
  );

  const choose = useCallback(
    (choice: TitleChoice) => {
      setTmdbId(choice.tmdbId);
      void search(choice.tmdbId);
    },
    [search],
  );

  const ask = useCallback(
    async (candidate: JudgedRelease) => {
      /*
       * The release is named by indexer and guid. The server resolves it and
       * fetches the NZB with its own credentials; a URL never crosses this
       * boundary in either direction.
       */
      await acquireRelease({
        kind: tvKind,
        ...(tvKind === "season" ? { season: Number(season) } : {}),
        title: title.trim(),
        ...(year.trim() ? { year: Number(year) } : {}),
        ...(params.get("itemId") &&
        title === params.get("title") &&
        year === (params.get("year") ?? "") &&
        kind === (params.get("kind") === "series" ? "tv" : "movie")
          ? { itemId: params.get("itemId")! }
          : {}),
        indexerId: candidate.indexerId,
        releaseGuid: candidate.guid,
        releaseTitle: candidate.title,
        ...(profileId ? { profileId } : {}),
        score: candidate.score,
        reasons: candidate.reasons,
      });
      setAsked((previous) => [...previous, candidate.guid]);
    },
    [kind, tvKind, profileId, title, year, season, params],
  );

  /** The catalogue item the page was opened for, while the inputs still name it. */
  const linkedItemId =
    params.get("itemId") &&
    title === params.get("title") &&
    year === (params.get("year") ?? "") &&
    kind === (params.get("kind") === "series" ? "tv" : "movie")
      ? params.get("itemId")!
      : null;
  const seriesTmdbId =
    tmdbId ||
    (searched?.resolved && resultQuery === queryKey
      ? searched.resolved.tmdbId
      : "");

  /*
   * Everything missing, without choosing release by release: the whole
   * series in one release, else each season's pack, else each episode. It
   * runs as a job on the server and starts downloads as it finds them; a
   * download that fails is blocklisted and replaced by the acquisition jobs.
   */
  const acquireMissing = useCallback(async () => {
    const version = ++autoVersion.current;
    setAuto({ stage: "starting" });
    try {
      const queued = await searchMissingEpisodes(
        linkedItemId ?? { tmdbId: seriesTmdbId },
        season.trim() ? Number(season) : undefined,
        profileId || undefined,
      );
      if (version !== autoVersion.current) return;
      if (!queued.taskId) {
        setAuto({ stage: "none" });
        return;
      }
      setAuto({ stage: "running", message: null });
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, AUTO_POLL_MS));
        if (version !== autoVersion.current) return;
        let state: MissingSearchState;
        try {
          state = await getMissingSearch(queued.taskId);
        } catch (error) {
          if ((error as { status?: number }).status === 404) throw error;
          continue; // A missed answer is asked for again.
        }
        if (version !== autoVersion.current) return;
        if (state.status === "succeeded" && state.result) {
          setAuto({ stage: "done", result: state.result });
          return;
        }
        if (state.status === "failed" || state.status === "cancelled") {
          setAuto({ stage: "failed" });
          return;
        }
        setAuto({ stage: "running", message: state.message });
      }
    } catch (error) {
      if (version !== autoVersion.current) return;
      setAuto({
        stage:
          (error as { code?: string }).code === "NOT_IN_LIBRARY"
            ? "absent"
            : "failed",
      });
    }
  }, [linkedItemId, seriesTmdbId, season, profileId]);

  const autoText = describeAuto(auto, t);
  const visibleCandidates = resultQuery === queryKey ? candidates : null;
  const ordered = visibleCandidates
    ? orderCandidates(visibleCandidates, winnerGuid)
    : [];
  const counts = visibleCandidates ? summarise(visibleCandidates) : null;

  return (
    <div className="w-full space-y-6">
      <WorkflowSteps current="/admin/decisions" />
      <header>
        <h1 className="text-3xl font-black text-white">
          {t("admin.decisions.title")}
        </h1>

        <p className="mt-1 text-sm font-semibold text-white/50">
          {t("admin.decisions.description")}
        </p>
      </header>

      <Link
        to="/admin/library"
        className="inline-block text-sm text-white/70 underline"
      >
        {t("wanted.chooseTmdb")}
      </Link>
      <form
        className="grid gap-3 rounded-3xl border border-white/10 bg-white/[0.05] p-5 md:grid-cols-2 xl:grid-cols-[minmax(10rem,1fr)_7rem_10rem_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs font-black uppercase tracking-wide text-white/45">
            {t("admin.decisions.titleField")}
          </span>
          <input
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setTmdbId("");
              setAuto({ stage: "idle" });
            }}
            required
            className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-black uppercase tracking-wide text-white/45">
            {t("admin.decisions.yearField")}
          </span>
          <input
            value={year}
            onChange={(event) => {
              setYear(event.target.value);
              setTmdbId("");
            }}
            inputMode="numeric"
            className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-black uppercase tracking-wide text-white/45">
            {t("admin.decisions.profileField")}
          </span>
          <select
            value={profileId}
            onChange={(event) => {
              setProfileId(event.target.value);
              setLimitState("idle");
            }}
            className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-wrap items-end gap-2">
          {kind === "tv" ? (
            <label className="flex w-20 flex-col gap-1 text-xs text-white/70">
              {t("admin.decisions.season")}
              <input
                type="number"
                min="0"
                max="10000"
                value={season}
                placeholder={t("admin.decisions.allSeasons")}
                onChange={(event) => {
                  setSeason(event.target.value);
                  setAuto({ stage: "idle" });
                }}
                className="min-w-0 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
              />
            </label>
          ) : null}
          <select
            aria-label={t("admin.decisions.kindField")}
            value={kind}
            onChange={(event) => {
              setKind(event.target.value === "tv" ? "tv" : "movie");
              setTmdbId("");
            }}
            className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <option value="movie">{t("admin.decisions.kind.movie")}</option>
            <option value="tv">{t("admin.decisions.kind.tv")}</option>
          </select>

          <button
            type="submit"
            disabled={isSearching || title.trim() === ""}
            className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.08] px-4 py-2 text-sm font-black text-white/85 transition hover:text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <Search size={15} />
            {t("admin.decisions.search")}
          </button>
        </div>
      </form>

      {profile ? (
        <form
          className="flex flex-wrap items-end gap-3 rounded-3xl border border-white/10 bg-white/[0.05] p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void saveLimit();
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="text-xs font-black uppercase tracking-wide text-white/45">
              {t("admin.decisions.sizeLimit")} · {profile.name}
            </span>
            <span className="flex items-center gap-2">
              <input
                value={sizeLimit}
                onChange={(event) => {
                  setLimitDraft({ profileId, text: event.target.value });
                  setLimitState("idle");
                }}
                inputMode="decimal"
                placeholder={t("admin.decisions.sizeLimitNone")}
                aria-describedby="size-limit-hint"
                className="w-28 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              />
              <span className="text-sm font-bold text-white/60">GB</span>
            </span>
          </label>

          <button
            type="submit"
            disabled={limitState === "saving"}
            className="rounded-xl border border-white/15 bg-white/[0.08] px-4 py-2 text-sm font-black text-white/85 transition hover:text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            {t("admin.decisions.sizeLimitSave")}
          </button>

          <p
            id="size-limit-hint"
            role={limitState === "idle" ? undefined : "status"}
            className={`basis-full text-xs font-semibold ${
              limitState === "invalid" || limitState === "failed"
                ? "text-amber-200"
                : "text-white/45"
            }`}
          >
            {limitState === "saved"
              ? t("admin.decisions.sizeLimitSaved")
              : limitState === "invalid"
                ? t("admin.decisions.sizeLimitInvalid")
                : limitState === "failed"
                  ? t("admin.decisions.sizeLimitFailed")
                  : t("admin.decisions.sizeLimitHint")}
          </p>
        </form>
      ) : null}

      {kind === "tv" ? (
        <section className="flex flex-wrap items-center gap-3 rounded-3xl border border-white/10 bg-white/[0.05] p-5">
          <button
            type="button"
            disabled={
              auto.stage === "starting" ||
              auto.stage === "running" ||
              (!linkedItemId && !seriesTmdbId)
            }
            onClick={() => void acquireMissing()}
            className="inline-flex items-center gap-2 rounded-xl border border-[var(--accent)]/40 bg-[var(--accent)]/15 px-4 py-2 text-sm font-black text-white transition hover:bg-[var(--accent)]/25 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <Download size={15} />
            {auto.stage === "starting" || auto.stage === "running"
              ? t("library.searchingMissing")
              : t("admin.decisions.auto")}
          </button>
          <p className="min-w-0 flex-1 basis-64 text-xs font-semibold text-white/45">
            {t("admin.decisions.autoHint")}
          </p>
          {autoText ? (
            <p
              role="status"
              className={`basis-full text-sm font-semibold ${
                auto.stage === "failed" || auto.stage === "absent"
                  ? "text-amber-200"
                  : "text-white/70"
              }`}
            >
              {autoText}
            </p>
          ) : null}
        </section>
      ) : null}

      {failure ? (
        <p
          role="alert"
          className="rounded-2xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm font-bold text-red-200"
        >
          {t(failure as "admin.decisions.searchFailed")}
        </p>
      ) : null}

      {visibleCandidates && searched ? (
        <div className="space-y-2 text-sm font-semibold text-white/50">
          {searched.resolved ? (
            <p>
              {t("admin.decisions.matched")}:{" "}
              <span className="text-white/85">
                {choiceText(searched.resolved)}
              </span>
              {searched.resolved.englishTitle !== searched.resolved.title
                ? ` · ${searched.resolved.englishTitle}`
                : ""}
              {" · "}
              {"imdbId" in searched.searchedFor
                ? `${t("admin.decisions.searchedById")} ${searched.searchedFor.imdbId}`
                : `${t("admin.decisions.searchedByTerm")} “${searched.searchedFor.term}”`}
            </p>
          ) : (
            <p>{t("admin.decisions.unmatched")}</p>
          )}

          {searched.alternatives.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span>{t("admin.decisions.alternatives")}</span>
              {searched.alternatives.map((choice) => (
                <button
                  key={choice.tmdbId}
                  type="button"
                  disabled={isSearching}
                  onClick={() => choose(choice)}
                  className="rounded-full border border-white/15 bg-white/[0.06] px-3 py-1 text-xs font-black text-white/75 transition hover:text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                >
                  {choiceText(choice)}
                  {choice.originalTitle ? ` · ${choice.originalTitle}` : ""}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {counts ? (
        <p className="text-sm font-semibold text-white/50">
          {t("admin.decisions.counts")}: {counts.accepted}/{counts.total}
        </p>
      ) : null}

      {visibleCandidates && visibleCandidates.length === 0 ? (
        <p className="rounded-3xl border border-white/10 bg-white/[0.04] px-5 py-8 text-center text-sm font-semibold text-white/45">
          {t("admin.decisions.noResults")}
        </p>
      ) : null}

      <ul className="space-y-2">
        {ordered.map((candidate) => (
          <li
            key={`${candidate.indexerId}:${candidate.guid}`}
            className={`rounded-2xl border p-4 ${
              candidate.isWinner
                ? "border-emerald-400/35 bg-emerald-400/[0.07]"
                : candidate.accepted
                  ? "border-white/10 bg-black/25"
                  : "border-white/[0.06] bg-black/15"
            }`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              {/* Provider text, rendered as text. */}
              <p className="break-all text-sm font-black text-white">
                {candidate.title}
              </p>

              <span
                className={`text-xs font-black uppercase tracking-wide ${
                  candidate.accepted ? "text-emerald-300" : "text-white/40"
                }`}
              >
                {candidate.isWinner
                  ? t("admin.decisions.recommended")
                  : candidate.accepted
                    ? t("admin.decisions.accepted")
                    : t("admin.decisions.rejected")}
              </span>
            </div>

            <p className="mt-1 text-xs font-semibold text-white/50">
              {candidate.sizeBytes !== undefined &&
              Number.isFinite(candidate.sizeBytes) &&
              candidate.sizeBytes > 0
                ? `${(candidate.sizeBytes / GB).toFixed(2)} GB`
                : t("admin.decisions.sizeUnknown")}{" "}
              · {candidate.quality}
              {candidate.score !== 0
                ? ` · ${t("admin.decisions.score")} ${candidate.score > 0 ? "+" : ""}${candidate.score}`
                : ""}
            </p>

            {candidate.rejection ? (
              <p className="mt-2 text-xs font-bold text-amber-200">
                {candidate.rejection}
              </p>
            ) : null}

            {candidate.reasons.length > 0 ? (
              <ul className="mt-2 space-y-0.5">
                {candidate.reasons.map((reason, index) => (
                  <li
                    key={`${reason.code}-${index}`}
                    className="text-xs font-medium text-white/45"
                  >
                    {reason.detail}
                  </li>
                ))}
              </ul>
            ) : null}

            {canAcquire(candidate) ? (
              <button
                type="button"
                disabled={asked.includes(candidate.guid)}
                onClick={() => void ask(candidate)}
                className="mt-3 rounded-full border border-white/15 bg-white/[0.08] px-3 py-1.5 text-xs font-black text-white/80 transition hover:text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                {asked.includes(candidate.guid)
                  ? t("admin.decisions.asked")
                  : t("admin.decisions.acquire")}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
