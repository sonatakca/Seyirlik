import { useId, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import type {
  SubtitleSyncAlignment,
  SubtitleSyncCue,
  SubtitleSyncSegment,
} from "../../lib/libraryAdminApi";
import { actionButton } from "./libraryStyle";
import { formatClock } from "./subtitleSyncFormat";

/**
 * A shift as a person says it: "1.4 s earlier", never a signed number. Null
 * when the region does not move at all — lines carried along with neighbours
 * that are already in time.
 */
function describeShift(
  segment: Pick<
    SubtitleSyncSegment,
    "offsetSeconds" | "rate" | "sourceStartSeconds"
  >,
  t: (key: TranslationKey) => string,
): string | null {
  // Where the region starts is moved by this much; a rate adds to it over time.
  const at = segment.sourceStartSeconds;
  const moved = at * segment.rate + segment.offsetSeconds - at;
  if (Math.abs(moved) < 0.05 && Math.abs(segment.rate - 1) <= 0.0005)
    return null;
  const amount = `${Math.abs(moved).toFixed(Math.abs(moved) < 10 ? 2 : 1)} s`;
  const direction =
    moved < 0 ? t("library.syncEarlierShort") : t("library.syncLaterShort");
  const speed =
    Math.abs(segment.rate - 1) > 0.0005
      ? ` · ${t("library.syncSpeed")}${segment.rate.toFixed(4)}`
      : "";
  return `${amount} ${direction}${speed}`;
}

const STATUS_STYLE: Record<
  SubtitleSyncSegment["status"] | "unmatched",
  string
> = {
  aligned: "bg-white/20",
  corrected: "bg-sky-400/70",
  inferred: "bg-sky-300/35",
  unresolved: "bg-amber-400/60",
  unmatched: "bg-rose-400/80",
};

const STATUS_LABEL: Record<
  SubtitleSyncSegment["status"] | "unmatched",
  TranslationKey
> = {
  aligned: "library.syncStatusAligned",
  corrected: "library.syncStatusCorrected",
  inferred: "library.syncStatusInferred",
  unresolved: "library.syncStatusUnresolved",
  unmatched: "library.syncStatusUnmatched",
};

const VERDICT_LABEL: Record<SubtitleSyncAlignment["verdict"], TranslationKey> =
  {
    "in-sync": "library.syncVerdictInSync",
    correctable: "library.syncVerdictCorrectable",
    partial: "library.syncVerdictPartial",
    reordered: "library.syncVerdictReordered",
    "insufficient-evidence": "library.syncVerdictInsufficient",
  };

/**
 * What a sync proposes, region by region, and the choice to apply it.
 *
 * Every number shown is a count or a time the server measured — lines moved,
 * lines matched, where an edit is — never a percentage presented as a
 * probability: the aligner's strength figure says how far a region stands
 * above chance, which is not how likely it is to be right, and nothing here
 * pretends otherwise.
 */
export function SubtitleSyncProposal({
  alignment,
  canApply,
  applying,
  onApply,
}: {
  alignment: SubtitleSyncAlignment;
  /** False once the proposal was applied, or when there is nothing to move. */
  canApply: boolean;
  applying: boolean;
  onApply: (unmatched: "keep" | "exclude") => void;
}) {
  const { t } = useLanguage();
  const ids = { unmatched: useId(), evidence: useId() };
  const [unmatched, setUnmatched] = useState<"keep" | "exclude">("keep");
  const [selected, setSelected] = useState<number | null>(null);

  const span = useMemo(() => {
    const ends = alignment.cues.map((cue) => cue.sourceEndSeconds);
    return Math.max(1, ...ends);
  }, [alignment.cues]);
  const moving = alignment.cues.filter(
    (cue) =>
      (cue.disposition === "corrected" || cue.disposition === "inferred") &&
      Math.abs(cue.startSeconds - cue.sourceStartSeconds) >= 0.05,
  ).length;
  const unmatchedCues = alignment.cues.filter(
    (cue) => cue.disposition === "unmatched",
  );
  const unresolvedCues = alignment.cues.filter(
    (cue) => cue.disposition === "unresolved",
  );
  const reasons = reviewReasons(alignment, t);
  const region =
    selected === null ? null : (alignment.segments[selected] ?? null);
  const inRegion = (cue: { index: number }) =>
    region !== null &&
    cue.index >= region.firstCue &&
    cue.index <= region.lastCue;

  return (
    <div className="space-y-3 rounded-lg border border-white/10 bg-black/30 p-3">
      <p className="text-xs font-black text-white/80">
        {t(VERDICT_LABEL[alignment.verdict])}
      </p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold text-white/55">
        <li>
          {moving} {t("library.syncLinesMove")}
        </li>
        {alignment.counts.unresolved > 0 ? (
          <li>
            {alignment.counts.unresolved} {t("library.syncLinesUnverified")}
          </li>
        ) : null}
        {alignment.counts.unmatched > 0 ? (
          <li>
            {alignment.counts.unmatched} {t("library.syncLinesMissingScene")}
          </li>
        ) : null}
        {alignment.anchorCount > 0 ? (
          <li>
            {alignment.anchorCount} {t("library.syncLinesMatchedByMeaning")}
          </li>
        ) : null}
      </ul>

      {/* The subtitle's own timeline, region by region. */}
      <div
        role="img"
        aria-label={t("library.syncTimelineLabel")}
        className="relative h-3 w-full overflow-hidden rounded-full bg-white/5"
      >
        {alignment.segments.map((segment, index) => (
          <span
            key={`${segment.firstCue}-${segment.status}`}
            className={`absolute top-0 h-full ${STATUS_STYLE[segment.status]} ${
              selected === index ? "ring-2 ring-white/80" : ""
            }`}
            style={{
              left: `${(segment.sourceStartSeconds / span) * 100}%`,
              width: `${Math.max(0.4, ((segment.sourceEndSeconds - segment.sourceStartSeconds) / span) * 100)}%`,
            }}
          />
        ))}
        {unmatchedCues.map((cue) => (
          <span
            key={`unmatched-${cue.index}`}
            className={`absolute top-0 h-full w-0.5 ${STATUS_STYLE.unmatched}`}
            style={{ left: `${(cue.sourceStartSeconds / span) * 100}%` }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-semibold text-white/45">
        {(
          [
            "aligned",
            "corrected",
            "inferred",
            "unresolved",
            "unmatched",
          ] as const
        ).map((status) => (
          <li key={status} className="inline-flex items-center gap-1">
            <span
              aria-hidden="true"
              className={`inline-block h-2 w-2 rounded-full ${STATUS_STYLE[status]}`}
            />
            {t(STATUS_LABEL[status])}
          </li>
        ))}
      </ul>

      <table className="w-full text-left text-xs">
        <thead className="text-[11px] font-black uppercase tracking-wide text-white/40">
          <tr>
            <th className="py-1 pr-2 font-black">
              {t("library.syncRegionTime")}
            </th>
            <th className="py-1 pr-2 font-black">
              {t("library.syncRegionChange")}
            </th>
            <th className="py-1 font-black">{t("library.syncRegionLines")}</th>
          </tr>
        </thead>
        <tbody className="font-semibold text-white/70">
          {alignment.segments.map((segment, index) => (
            <tr
              key={`${segment.firstCue}-${segment.status}`}
              className={selected === index ? "bg-white/5" : ""}
            >
              <td className="py-1 pr-2 tabular-nums">
                <button
                  type="button"
                  className="underline decoration-white/20 underline-offset-2 hover:decoration-white/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  aria-pressed={selected === index}
                  aria-controls={ids.evidence}
                  onClick={() => setSelected(selected === index ? null : index)}
                >
                  {formatClock(segment.sourceStartSeconds)}–
                  {formatClock(segment.sourceEndSeconds)}
                </button>
              </td>
              <td className="py-1 pr-2">
                {t(STATUS_LABEL[segment.status])}
                {(segment.status === "corrected" ||
                  segment.status === "inferred") &&
                describeShift(segment, t)
                  ? ` · ${describeShift(segment, t)}`
                  : segment.status === "inferred"
                    ? ` · ${t("library.syncNoChange")}`
                    : ""}
              </td>
              <td className="py-1 tabular-nums">
                {segment.status === "aligned" || segment.status === "corrected"
                  ? `${segment.matchedCues}/${segment.cueCount}`
                  : segment.cueCount}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {alignment.breakpoints.length > 0 ? (
        <ul className="space-y-0.5 text-xs font-semibold text-white/60">
          {alignment.breakpoints.map((breakpoint) => (
            <li key={breakpoint.afterSourceSeconds}>
              {formatClock(breakpoint.afterSourceSeconds)}:{" "}
              {t(
                breakpoint.kind === "removed"
                  ? "library.syncEditRemoved"
                  : "library.syncEditInserted",
              )}{" "}
              ({breakpoint.seconds.toFixed(1)} s)
            </li>
          ))}
        </ul>
      ) : null}

      {reasons.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-4 text-xs font-semibold text-amber-200/80">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}

      <div id={ids.evidence} className="space-y-2">
        {region ? (
          <RegionEvidence alignment={alignment} inRegion={inRegion} t={t} />
        ) : (
          <p className="text-[11px] font-semibold text-white/35">
            {t("library.syncPickRegion")}
          </p>
        )}
        {unmatchedCues.length > 0 || unresolvedCues.length > 0 ? (
          <details className="text-xs text-white/60">
            <summary className="cursor-pointer font-bold text-white/55">
              {t("library.syncReviewLines")}
            </summary>
            <CueList
              cues={[...unmatchedCues, ...unresolvedCues].sort(
                (left, right) =>
                  left.sourceStartSeconds - right.sourceStartSeconds,
              )}
              t={t}
            />
          </details>
        ) : null}
      </div>

      {canApply ? (
        <div className="space-y-2 border-t border-white/10 pt-3">
          {unmatchedCues.length > 0 ? (
            <fieldset className="space-y-1" disabled={applying}>
              <legend className="text-[11px] font-black uppercase tracking-wide text-white/45">
                {t("library.syncUnmatchedChoice")}
              </legend>
              {(["keep", "exclude"] as const).map((option) => (
                <label
                  key={option}
                  className="flex items-center gap-1.5 text-xs font-bold text-white/70"
                >
                  <input
                    type="radio"
                    name={ids.unmatched}
                    value={option}
                    checked={unmatched === option}
                    onChange={() => setUnmatched(option)}
                    className="accent-sky-300"
                  />
                  {t(
                    option === "keep"
                      ? "library.syncUnmatchedKeep"
                      : "library.syncUnmatchedExclude",
                  )}
                </label>
              ))}
            </fieldset>
          ) : null}
          <button
            type="button"
            className={actionButton}
            disabled={applying}
            onClick={() => onApply(unmatched)}
          >
            <Check size={13} aria-hidden="true" />
            {t("library.syncApplyProposal")}
          </button>
          <p className="text-[11px] font-semibold text-white/35">
            {t("library.syncApplyHint")}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** The lines of one region, and what each was matched to. */
function RegionEvidence({
  alignment,
  inRegion,
  t,
}: {
  alignment: SubtitleSyncAlignment;
  inRegion: (cue: { index: number }) => boolean;
  t: (key: TranslationKey) => string;
}) {
  const anchors = alignment.anchors
    .filter((anchor) => inRegion({ index: anchor.cueIndex }))
    .sort((left, right) => left.mediaSeconds - right.mediaSeconds)
    .slice(0, 12);
  const moved = alignment.cues
    .filter(
      (cue) =>
        inRegion(cue) &&
        Math.abs(cue.startSeconds - cue.sourceStartSeconds) >= 0.05,
    )
    .slice(0, 8);
  return (
    <div className="space-y-2 text-xs">
      {anchors.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[11px] font-black uppercase tracking-wide text-white/40">
            {t("library.syncEvidenceMeaning")}
          </p>
          <ul className="space-y-1">
            {anchors.map((anchor) => (
              <li key={anchor.cueIndex} className="text-white/65">
                <span className="tabular-nums text-white/40">
                  {formatClock(anchor.mediaSeconds)}
                </span>{" "}
                <span className="font-semibold">{anchor.cueText}</span>
                <span className="text-white/35"> ↔ </span>
                <span className="italic text-white/55">
                  {anchor.spokenText}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {moved.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[11px] font-black uppercase tracking-wide text-white/40">
            {t("library.syncEvidenceMoves")}
          </p>
          <CueList cues={moved} t={t} showTarget />
        </div>
      ) : null}
      {anchors.length === 0 && moved.length === 0 ? (
        <p className="text-[11px] font-semibold text-white/35">
          {t("library.syncEvidenceNone")}
        </p>
      ) : null}
    </div>
  );
}

function CueList({
  cues,
  t,
  showTarget = false,
}: {
  cues: readonly SubtitleSyncCue[];
  t: (key: TranslationKey) => string;
  showTarget?: boolean;
}) {
  return (
    <ul className="mt-1 space-y-1">
      {cues.slice(0, 40).map((cue) => (
        <li key={cue.index} className="text-white/60">
          <span className="tabular-nums text-white/40">
            {formatClock(cue.sourceStartSeconds)}
            {showTarget ? ` → ${formatClock(cue.startSeconds)}` : ""}
          </span>{" "}
          {showTarget ? null : (
            <span className="text-white/40">
              {t(
                cue.disposition === "unmatched"
                  ? STATUS_LABEL.unmatched
                  : STATUS_LABEL.unresolved,
              )}
              {" · "}
            </span>
          )}
          {cue.text.replace(/<[^>]*>/g, "").replace(/\n/g, " ")}
        </li>
      ))}
    </ul>
  );
}

/** Why a proposal was not applied on its own, from its own counts. */
function reviewReasons(
  alignment: SubtitleSyncAlignment,
  t: (key: TranslationKey) => string,
): string[] {
  const reasons: string[] = [];
  if (alignment.counts.unresolved > 0)
    reasons.push(
      `${alignment.counts.unresolved} ${t("library.syncReasonUnresolved")}`,
    );
  if (alignment.counts.unmatched > 0)
    reasons.push(
      `${alignment.counts.unmatched} ${t("library.syncReasonUnmatched")}`,
    );
  if (alignment.placedAtEdits > 0)
    reasons.push(
      `${alignment.placedAtEdits} ${t("library.syncReasonPlacedAtEdit")}`,
    );
  if (alignment.verdict === "reordered")
    reasons.push(t("library.syncReasonReordered"));
  if (
    reasons.length === 0 &&
    alignment.verdict === "correctable" &&
    !alignment.autoApplicable
  )
    reasons.push(t("library.syncReasonWeak"));
  return reasons;
}
