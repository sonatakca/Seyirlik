import { useEffect, useRef, useState } from "react";
import { useLanguage } from "../../i18n/LanguageContext";
import {
  generateTrickplay,
  getMissingSearch,
  requestTitleSubtitles,
  searchMissingEpisodes,
  uploadTitleSubtitle,
  type MissingSearchState,
} from "../../lib/libraryAdminApi";
import { setWanted } from "../../lib/wantedApi";
import { describeErrorDetail } from "../../lib/userFacingError";

export type Notice = { tone: "ok" | "error"; text: string } | null;

/** How often a running missing-episode search is asked how it went. */
const MISSING_SEARCH_POLL_MS = 3_000;

const episodeCode = (season: number, episode: number | null) =>
  `S${String(season).padStart(2, "0")}${
    episode === null ? "" : `E${String(episode).padStart(2, "0")}`
  }`;

/**
 * The per-title actions, and what each one said.
 *
 * One hook for the list and the workspace, so "find subtitles" and "generate
 * trickplay" mean the same request and report the same way wherever pressed.
 */
export function useTitleActions(onChanged: () => void | Promise<void>) {
  const { t } = useLanguage();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  /** Titles with a missing-episode search still running. */
  const [searching, setSearching] = useState<ReadonlySet<string>>(new Set());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function report(result: NonNullable<MissingSearchState["result"]>) {
    const started = result.started.map((s) => episodeCode(s.season, s.episode));
    const nothing = result.nothing.map((s) => episodeCode(s.season, s.episode));
    const covered = (result.covered ?? []).map((s) =>
      episodeCode(s.season, s.episode),
    );
    setNotice({
      tone: started.length > 0 ? "ok" : "error",
      text: [
        `${t("library.missingStarted")} ${started.length > 0 ? started.join(", ") : 0}`,
        ...(nothing.length > 0
          ? [`${t("library.missingNothingFor")} ${nothing.join(", ")}`]
          : []),
        ...(covered.length > 0
          ? [`${t("library.missingAlreadyComing")} ${covered.join(", ")}`]
          : []),
      ].join(" · "),
    });
  }

  /**
   * Follows a search the worker runs until it finishes, then says what it
   * started and what it found nothing for. The searches take minutes, so the
   * press itself only queues them and the buttons stay usable meanwhile.
   */
  async function follow(itemId: string, taskId: string) {
    try {
      while (mounted.current) {
        await new Promise((done) =>
          window.setTimeout(done, MISSING_SEARCH_POLL_MS),
        );
        if (!mounted.current) return;
        let state: MissingSearchState;
        try {
          state = await getMissingSearch(taskId);
        } catch (error) {
          if ((error as { status?: number }).status === 404) throw error;
          continue; // A missed answer is asked for again.
        }
        if (state.status === "succeeded" && state.result) {
          report(state.result);
          break;
        }
        if (state.status === "failed" || state.status === "cancelled") {
          throw new Error(state.status);
        }
      }
    } catch {
      if (mounted.current)
        setNotice({ tone: "error", text: t("library.missingSearchFailed") });
    } finally {
      if (mounted.current) {
        setSearching((previous) => {
          const next = new Set(previous);
          next.delete(itemId);
          return next;
        });
        await onChanged();
      }
    }
  }

  async function run(key: string, work: () => Promise<string>) {
    setBusy(key);
    setNotice(null);
    try {
      setNotice({ tone: "ok", text: await work() });
      await onChanged();
    } catch (error) {
      const status = (error as { status?: number }).status;
      setNotice({
        tone: "error",
        text:
          status === 404 && key.startsWith("subtitles:")
            ? t("library.subtitlesUnconfigured")
            : status === 404 && key.startsWith("subtitle-upload:")
              ? t("library.subtitlesUnconfigured")
              : /*
                 * A refused upload carries the only sentence that says what to
                 * do about it — which file is in the way, or what the bytes
                 * turned out to be — so it is shown rather than flattened into
                 * "the action failed".
                 */
                (key.startsWith("subtitle-upload:") &&
                  describeErrorDetail(error, t)) ||
                t("library.actionFailed"),
      });
    } finally {
      setBusy(null);
    }
  }

  return {
    busy,
    notice,
    setNotice,
    /** Whether a missing-episode search for this title is still running. */
    searchingMissing: (itemId: string) => searching.has(itemId),
    searchMissing: (itemId: string, season?: number) =>
      run(`missing:${itemId}`, async () => {
        const queued = await searchMissingEpisodes(itemId, season);
        if (!queued.taskId) return t("library.missingNone");
        setSearching((previous) => new Set(previous).add(itemId));
        void follow(itemId, queued.taskId);
        return `${t("library.missingSearching")} ${queued.episodes}`;
      }),
    findSubtitles: (itemId: string) =>
      run(`subtitles:${itemId}`, async () => {
        const result = await requestTitleSubtitles(itemId, "tur");
        return result.files === 0
          ? t("library.subtitlesNoFiles")
          : `${t("library.subtitlesQueued")} ${result.queued}/${result.files}`;
      }),
    /**
     * A subtitle the operator already has.
     *
     * Reports the name the file was given rather than the one it arrived
     * under: renaming it into the library's convention is the whole point, and
     * seeing the new name is how somebody knows it worked.
     */
    uploadSubtitle: (
      itemId: string,
      file: File,
      policy: { language: "tur" | "eng"; forced?: boolean; replace?: boolean },
    ) =>
      run(`subtitle-upload:${itemId}`, async () => {
        const report = await uploadTitleSubtitle(itemId, file, policy);
        return report.outcome === "duplicate"
          ? `${t("library.subtitleAlreadyThere")} ${report.fileName}`
          : `${t("library.subtitleUploaded")} ${report.fileName}`;
      }),
    trickplay: (itemId: string, force = false) =>
      run(`trickplay:${itemId}`, async () => {
        const result = await generateTrickplay(itemId, force);
        return result.queued === 0
          ? result.alreadyGenerated > 0
            ? t("library.trickplayUpToDate")
            : t("library.trickplayNothing")
          : `${t("library.trickplayQueued")} ${result.queued}`;
      }),
    toggleWanted: (itemId: string, desired: boolean) =>
      run(`wanted:${itemId}`, async () => {
        await setWanted(itemId, !desired);
        return t(desired ? "library.unwanted" : "library.nowWanted");
      }),
  };
}
