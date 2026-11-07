import {
  ChevronDown,
  ImageIcon,
  Loader2,
  Lock,
  RotateCcw,
  Upload,
} from "lucide-react";
import { useLanguage } from "../../../i18n/LanguageContext";
import type {
  ArtworkCandidate,
  ArtworkKind,
  ArtworkOverview,
} from "../../../lib/artworkApi";
import { formatTemplate } from "../../../lib/format";
import {
  ARTWORK_PAGE_SIZE,
  artworkQuality,
  countCandidates,
  formatDimensions,
  getCustomUploadLabelKey,
  getKindDescriptionKey,
  getKindLabelKey,
  getQualityLabelKey,
  hasStoredArtwork,
  isKindLocked,
  languageName,
  languageOptions,
  selectCandidates,
  type ArtworkQualityTone,
  type ImageLanguageFilter,
} from "../tmdbArtworkModel";
import { LanguageChips } from "./LanguageChips";

const QUALITY_CHIP_CLASSES: Record<ArtworkQualityTone, string> = {
  high: "bg-emerald-400/15 text-emerald-200",
  good: "bg-sky-400/15 text-sky-100",
  low: "bg-amber-400/15 text-amber-200",
};

/**
 * One kind of artwork — posters, backdrops or logos — with its own language.
 *
 * The language used to be one drop-down for all three sets, so choosing a
 * Turkish logo also hid the English posters. Each set now filters itself.
 */
export function ArtworkKindSection({
  kind,
  artwork,
  language,
  onLanguage,
  visible,
  onMore,
  busyKind,
  onApply,
  onRevert,
  onUpload,
}: {
  kind: ArtworkKind;
  artwork: ArtworkOverview;
  language: ImageLanguageFilter;
  onLanguage: (value: ImageLanguageFilter) => void;
  visible: number;
  onMore: () => void;
  busyKind: ArtworkKind | null;
  onApply: (candidate: ArtworkCandidate) => void;
  onRevert: () => void;
  onUpload: (file: File) => void;
}) {
  const { t, language: uiLanguage } = useLanguage();
  const options = languageOptions(artwork.candidates, kind);
  const candidates = selectCandidates(
    artwork.candidates,
    kind,
    language,
    visible,
  );
  const available = countCandidates(artwork.candidates, kind, language);
  const locked = isKindLocked(artwork.lockedTypes, kind);
  const stored = hasStoredArtwork(artwork.current, kind);
  const busy = busyKind !== null;

  return (
    <section
      id={`artwork-${kind}`}
      aria-labelledby={`artwork-${kind}-title`}
      className="scroll-mt-28 rounded-3xl border border-white/10 bg-white/[0.03] p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id={`artwork-${kind}-title`}
            className="flex items-center gap-2 text-base font-black text-white"
          >
            <ImageIcon className="h-4 w-4 text-white/35" aria-hidden="true" />
            {t(getKindLabelKey(kind))}
            {locked ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/15 px-2 py-0.5 text-[0.62rem] font-black uppercase tracking-[0.1em] text-amber-200">
                <Lock className="h-3 w-3" aria-hidden="true" />
                {t("tmdbArtwork.lockedBadge")}
              </span>
            ) : null}
          </h2>
          <p className="mt-1 text-xs font-semibold text-white/40">
            {t(getKindDescriptionKey(kind))}
            {locked ? ` ${t("tmdbArtwork.lockedExplanation")}` : ""}
            {!stored ? ` ${t("tmdbArtwork.noCurrentArtwork")}` : ""}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <label
            className={`inline-flex cursor-pointer items-center gap-2 rounded-2xl bg-sky-400/15 px-3 py-1.5 text-xs font-black text-sky-100 transition hover:bg-sky-400/25 focus-within:ring-2 focus-within:ring-[var(--accent)] ${
              busy ? "pointer-events-none opacity-40" : ""
            }`}
          >
            {busyKind === kind ? (
              <Loader2
                className="h-3.5 w-3.5 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {t(getCustomUploadLabelKey(kind))}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={busy}
              className="sr-only"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) onUpload(file);
              }}
            />
          </label>
          {locked ? (
            <button
              type="button"
              disabled={busy}
              onClick={onRevert}
              className="inline-flex items-center gap-2 rounded-2xl border border-white/15 px-3 py-1.5 text-xs font-black text-white/70 transition hover:border-white/30 hover:text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              {t("tmdbArtwork.revertToAutomatic")}
            </button>
          ) : null}
        </div>
      </div>

      {options.length > 1 ? (
        <div className="mt-4">
          <LanguageChips
            options={options}
            value={language}
            onChange={onLanguage}
            label={`${t(getKindLabelKey(kind))} · ${t("tmdbArtwork.sectionLanguage")}`}
          />
        </div>
      ) : null}

      {candidates.length === 0 ? (
        <p className="mt-4 text-sm font-bold text-white/35">
          {t(
            artwork.item.providerId
              ? "tmdbArtwork.noImages"
              : "tmdbArtwork.noProviderImages",
          )}
        </p>
      ) : (
        <ul
          className={`mt-4 grid gap-3 ${
            kind === "poster"
              ? "grid-cols-3 sm:grid-cols-4 lg:grid-cols-6"
              : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"
          }`}
        >
          {candidates.map((candidate) => {
            const dimensions = formatDimensions(
              candidate.width,
              candidate.height,
            );
            const quality = artworkQuality(
              kind,
              candidate.width,
              candidate.height,
            );
            const qualityText = quality
              ? (quality.resolution ?? t(getQualityLabelKey(quality.tone)))
              : null;
            return (
              <li key={candidate.filePath}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onApply(candidate)}
                  aria-label={`${t("tmdbArtwork.replaceFile")} · ${
                    candidate.language
                      ? languageName(candidate.language, uiLanguage)
                      : t("tmdbArtwork.language.none")
                  } · ${dimensions}${
                    qualityText
                      ? ` · ${t("tmdbArtwork.qualityLabel")}: ${qualityText}`
                      : ""
                  }`}
                  className="group w-full overflow-hidden rounded-2xl border border-white/10 bg-black/40 text-left transition hover:border-sky-300/50 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                >
                  <img
                    src={candidate.previewUrl}
                    alt=""
                    loading="lazy"
                    className={`w-full object-contain ${
                      kind === "poster" ? "aspect-[2/3]" : "aspect-video"
                    } ${kind === "logo" ? "bg-[repeating-conic-gradient(#ffffff0d_0_25%,transparent_0_50%)] bg-[length:16px_16px] p-2" : ""}`}
                  />
                  <span className="flex items-center justify-between gap-2 px-2 py-1.5 text-[0.68rem] font-semibold text-white/40">
                    <span className="truncate font-black uppercase tracking-[0.08em] text-white/55">
                      {candidate.language
                        ? languageName(candidate.language, uiLanguage)
                        : t("tmdbArtwork.language.none")}
                    </span>
                    <span className="tabular-nums">
                      {candidate.voteAverage.toFixed(1)}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-2 pb-1.5 text-[0.68rem] font-semibold text-white/45">
                    <span className="whitespace-nowrap tabular-nums">
                      {dimensions}
                    </span>
                    {quality && qualityText ? (
                      <span
                        className={`shrink-0 rounded-full px-1.5 py-px text-[0.6rem] font-black uppercase tracking-[0.06em] ${QUALITY_CHIP_CLASSES[quality.tone]}`}
                      >
                        {qualityText}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {available > candidates.length ? (
        <button
          type="button"
          onClick={onMore}
          className="mt-3 inline-flex items-center gap-2 rounded-2xl border border-white/15 px-4 py-2 text-xs font-black text-white/70 transition hover:border-sky-300/40 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          {formatTemplate(t("tmdbArtwork.loadMoreChoices"), {
            count: Math.min(ARTWORK_PAGE_SIZE, available - candidates.length),
          })}
        </button>
      ) : null}
    </section>
  );
}
