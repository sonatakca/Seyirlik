import type {
  RenditionAudioTrackProbe,
  RenditionMediaProbe,
  RenditionSubtitleTrackProbe,
} from "../probe";
import {
  languageDisplayName,
  normalizeLanguage,
  UNKNOWN_LANGUAGE,
} from "./languages";

/**
 * Which source streams reach the generated outputs, and why.
 *
 * Every stream gets a decision with a reason, kept and dropped alike. A library
 * owner asking "where did the French audio go" deserves an answer from the job
 * record rather than from reading the encoder command.
 */

export interface StreamPolicyOptions {
  /** Languages to keep beyond the source default. Order is preference order. */
  preferredLanguages?: string[];
  /** Keep commentary tracks. Off by default: they are not the feature. */
  includeCommentary?: boolean;
  /** Keep hearing-impaired subtitle tracks. */
  includeHearingImpaired?: boolean;
  /** Keep every audio language rather than applying the retention list. */
  keepAllLanguages?: boolean;
}

export const DEFAULT_PREFERRED_LANGUAGES = ["eng", "tur"] as const;

export type AudioKeepReason =
  | "source-default"
  | "preferred-language"
  | "only-track";

export type AudioDropReason =
  | "commentary-not-requested"
  | "duplicate-language"
  | "language-not-retained"
  | "visual-impaired-not-requested";

export interface AudioDecision {
  streamIndex: number;
  language: string;
  languageName: string;
  codec: string;
  channels?: number;
  channelLayout?: string;
  title?: string;
  isDefault: boolean;
  isCommentary: boolean;
  keep: boolean;
  reason: AudioKeepReason | AudioDropReason;
  /** Human sentence for the job timeline and the UI. */
  explanation: string;
}

export type SubtitleKeepReason =
  | "preferred-language"
  | "forced-preferred-language"
  | "hearing-impaired-requested"
  /**
   * An SDH track kept because it is the only one its language has. Dropping it
   * as "SDH is opt-in" would leave the title with no subtitles in a language
   * the policy was told to retain, which is worse than subtitles that also
   * describe the sound.
   */
  | "hearing-impaired-only-track";

export type SubtitleDropReason =
  | "language-not-retained"
  | "commentary-not-requested"
  | "hearing-impaired-not-requested";

export interface SubtitleDecision {
  streamIndex: number;
  language: string;
  languageName: string;
  codec: string;
  title?: string;
  isDefault: boolean;
  isForced: boolean;
  isHearingImpaired: boolean;
  isTextBased: boolean;
  keep: boolean;
  reason: SubtitleKeepReason | SubtitleDropReason;
  /**
   * True when the track is kept but cannot become WebVTT on its own. Bitmap
   * subtitles are retained and flagged for OCR or opt-in burn-in rather than
   * quietly discarded.
   */
  requiresOcr: boolean;
  explanation: string;
}

export interface StreamPolicyResult {
  audio: AudioDecision[];
  subtitles: SubtitleDecision[];
  /** Source stream indexes the adaptive audio ladder should carry, in order. */
  keptAudioStreamIndexes: number[];
  /** Source stream indexes to convert to WebVTT, in order. */
  keptSubtitleStreamIndexes: number[];
  warnings: string[];
}

/**
 * How good a track is as *the* representative of its language.
 *
 * More channels beats fewer, because the adaptive ladder downmixes to stereo
 * anyway and the better source downmixes better. A lossless or higher-bitrate
 * track beats a lower one at equal channels. Default wins ties, since that is
 * what the author intended a viewer to hear.
 */
function audioQualityScore(track: RenditionAudioTrackProbe): number {
  const channels = track.channels ?? 2;
  const bitrate = track.bitrate ?? 0;
  const lossless = /truehd|flac|mlp|pcm|dts_hd|dtshd/.test(track.codec) ? 1 : 0;
  return (
    channels * 1_000_000 +
    lossless * 500_000 +
    Math.min(bitrate, 400_000) / 1000 +
    (track.isDefault ? 1 : 0)
  );
}

function bestOf(
  tracks: RenditionAudioTrackProbe[],
): RenditionAudioTrackProbe | undefined {
  return [...tracks].sort(
    (left, right) => audioQualityScore(right) - audioQualityScore(left),
  )[0];
}

function describeAudio(track: RenditionAudioTrackProbe): string {
  const parts = [
    languageDisplayName(track.language),
    track.codec.toUpperCase(),
  ];
  if (track.channelLayout) parts.push(track.channelLayout);
  else if (track.channels) parts.push(`${track.channels}ch`);
  return parts.join(" · ");
}

/**
 * Applies the audio retention policy.
 *
 * The source's own default track is always kept, whatever language it is in: a
 * Turkish viewer watching a Japanese film still expects the original audio to
 * exist. One best English and one best Turkish track join it, and a track that
 * is already kept is never kept twice — when the default *is* the English
 * track, the result is one rendition, not two identical ones.
 */
export function decideAudioStreams(
  tracks: readonly RenditionAudioTrackProbe[],
  options: StreamPolicyOptions = {},
): AudioDecision[] {
  const preferred = (
    options.preferredLanguages ?? [...DEFAULT_PREFERRED_LANGUAGES]
  ).map((language) => normalizeLanguage(language));
  /**
   * Commentary is a separate programme, not another mix of the same one, so it
   * is held apart from the language de-duplication entirely. Folding it in
   * would let a commentary track win "best English" from the feature audio, or
   * be dropped as a duplicate of it — both wrong.
   */
  const commentary = tracks.filter((track) => track.isCommentary);
  const programme = tracks.filter((track) => !track.isCommentary);
  const keptIndexes = new Set<number>();
  const keepReasons = new Map<number, AudioKeepReason>();

  if (options.includeCommentary) {
    for (const track of commentary) {
      keptIndexes.add(track.streamIndex);
      keepReasons.set(track.streamIndex, "preferred-language");
    }
  }

  if (programme.length > 0) {
    const sourceDefault =
      programme.find((track) => track.isDefault) ??
      programme.find((track) => track.isOriginal) ??
      programme[0]!;
    keptIndexes.add(sourceDefault.streamIndex);
    keepReasons.set(
      sourceDefault.streamIndex,
      programme.length === 1 ? "only-track" : "source-default",
    );

    if (!options.keepAllLanguages) {
      for (const language of preferred) {
        const alreadyKept = [...keptIndexes].some(
          (index) =>
            normalizeLanguage(
              programme.find((track) => track.streamIndex === index)?.language,
            ) === language,
        );
        if (alreadyKept) continue;
        const candidate = bestOf(
          programme.filter(
            (track) => normalizeLanguage(track.language) === language,
          ),
        );
        if (candidate) {
          keptIndexes.add(candidate.streamIndex);
          keepReasons.set(candidate.streamIndex, "preferred-language");
        }
      }
    } else {
      for (const track of programme) {
        if (keptIndexes.has(track.streamIndex)) continue;
        const alreadyKept = [...keptIndexes].some(
          (index) =>
            normalizeLanguage(
              programme.find((entry) => entry.streamIndex === index)?.language,
            ) === normalizeLanguage(track.language),
        );
        if (alreadyKept) continue;
        keptIndexes.add(track.streamIndex);
        keepReasons.set(track.streamIndex, "preferred-language");
      }
    }
  }

  return tracks.map((track) => {
    const language = normalizeLanguage(track.language);
    const languageName = languageDisplayName(track.language);
    const keep = keptIndexes.has(track.streamIndex);
    const base = {
      streamIndex: track.streamIndex,
      language,
      languageName,
      codec: track.codec,
      ...(track.channels === undefined ? {} : { channels: track.channels }),
      ...(track.channelLayout ? { channelLayout: track.channelLayout } : {}),
      ...(track.title ? { title: track.title } : {}),
      isDefault: track.isDefault,
      isCommentary: track.isCommentary,
    };

    if (keep) {
      const reason = keepReasons.get(track.streamIndex) ?? "preferred-language";
      return {
        ...base,
        keep: true,
        reason,
        explanation: track.isCommentary
          ? `Keeping ${describeAudio(track)} — commentary, which was asked for`
          : reason === "source-default"
            ? `Keeping ${describeAudio(track)} — the source's own default track`
            : reason === "only-track"
              ? `Keeping ${describeAudio(track)} — the only programme track`
              : `Keeping ${describeAudio(track)} — a retained language`,
      };
    }

    const reason: AudioDropReason = track.isCommentary
      ? "commentary-not-requested"
      : track.isVisualImpaired
        ? "visual-impaired-not-requested"
        : [...keptIndexes].some(
              (index) =>
                normalizeLanguage(
                  tracks.find((entry) => entry.streamIndex === index)?.language,
                ) === language,
            )
          ? "duplicate-language"
          : "language-not-retained";

    return {
      ...base,
      keep: false,
      reason,
      explanation:
        reason === "commentary-not-requested"
          ? `Dropping ${describeAudio(track)} from generated outputs — commentary is opt-in`
          : reason === "visual-impaired-not-requested"
            ? `Dropping ${describeAudio(track)} from generated outputs — audio description is opt-in`
            : reason === "duplicate-language"
              ? `Dropping ${describeAudio(track)} from generated outputs — a better ${languageName} track is already kept`
              : `Dropping ${languageName} from generated outputs — not a retained language`,
    };
  });
}

/**
 * Applies the subtitle retention policy.
 *
 * Forced tracks in a retained language are always kept: they carry the
 * translated signage and foreign dialogue a viewer cannot follow without them,
 * and they are almost empty the rest of the time, so they cost nothing.
 */
export function decideSubtitleStreams(
  tracks: readonly RenditionSubtitleTrackProbe[],
  options: StreamPolicyOptions = {},
): SubtitleDecision[] {
  const preferred = new Set(
    (options.preferredLanguages ?? [...DEFAULT_PREFERRED_LANGUAGES]).map(
      (language) => normalizeLanguage(language),
    ),
  );

  /*
   * Languages whose only retained candidate describes the sound as well as the
   * dialogue. Sidecar subtitles are routinely the SDH cut and nothing else —
   * a library can hold one `.tr.hi.srt` per film and no plain Turkish at all —
   * so treating SDH as strictly opt-in silently removes the only translation
   * the title has.
   */
  const languagesWithPlainTrack = new Set(
    tracks
      .filter(
        (track) =>
          !track.isHearingImpaired &&
          !track.isCommentary &&
          !track.isForced &&
          (options.keepAllLanguages ||
            preferred.has(normalizeLanguage(track.language))),
      )
      .map((track) => normalizeLanguage(track.language)),
  );

  return tracks.map((track) => {
    const language = normalizeLanguage(track.language);
    const languageName = languageDisplayName(track.language);
    const inPreferred = options.keepAllLanguages || preferred.has(language);
    const isOnlyTrackForLanguage = !languagesWithPlainTrack.has(language);
    const base = {
      streamIndex: track.streamIndex,
      language,
      languageName,
      codec: track.codec,
      ...(track.title ? { title: track.title } : {}),
      isDefault: track.isDefault,
      isForced: track.isForced,
      isHearingImpaired: track.isHearingImpaired,
      isTextBased: track.isTextBased,
      requiresOcr: !track.isTextBased,
    };

    if (track.isCommentary && !options.includeCommentary) {
      return {
        ...base,
        keep: false,
        reason: "commentary-not-requested" as const,
        explanation: `Dropping the ${languageName} commentary subtitles — commentary is opt-in`,
      };
    }
    if (!inPreferred) {
      return {
        ...base,
        keep: false,
        reason: "language-not-retained" as const,
        explanation: `Dropping ${languageName} subtitles — not a retained language`,
      };
    }
    if (
      track.isHearingImpaired &&
      !options.includeHearingImpaired &&
      !isOnlyTrackForLanguage
    ) {
      return {
        ...base,
        keep: false,
        reason: "hearing-impaired-not-requested" as const,
        explanation: `Dropping the ${languageName} SDH subtitles — SDH is opt-in`,
      };
    }

    const reason: SubtitleKeepReason = track.isForced
      ? "forced-preferred-language"
      : track.isHearingImpaired
        ? options.includeHearingImpaired
          ? "hearing-impaired-requested"
          : "hearing-impaired-only-track"
        : "preferred-language";
    return {
      ...base,
      keep: true,
      reason,
      explanation: track.isForced
        ? `Keeping ${languageName} forced subtitles`
        : reason === "hearing-impaired-only-track"
          ? `Keeping the ${languageName} SDH subtitles — the only ${languageName} subtitles this title has`
          : track.isHearingImpaired
            ? `Keeping ${languageName} SDH subtitles`
            : `Keeping ${languageName} subtitles`,
    };
  });
}

export function applyStreamPolicy(
  probe: Pick<RenditionMediaProbe, "audioTracks" | "subtitleTracks">,
  options: StreamPolicyOptions = {},
): StreamPolicyResult {
  const audio = decideAudioStreams(probe.audioTracks, options);
  const subtitles = decideSubtitleStreams(probe.subtitleTracks, options);
  const warnings: string[] = [];

  if (audio.length === 0) {
    warnings.push("The source has no audio stream.");
  } else if (!audio.some((decision) => decision.keep)) {
    warnings.push(
      "The audio policy retained no track; the source default will be used.",
    );
  }
  for (const decision of subtitles.filter(
    (entry) => entry.keep && entry.requiresOcr,
  )) {
    warnings.push(
      `${decision.languageName} subtitles are image based (${decision.codec}); they need OCR or burn-in before a browser can show them.`,
    );
  }
  const unknownKept = audio.filter(
    (decision) => decision.keep && decision.language === UNKNOWN_LANGUAGE,
  );
  if (unknownKept.length > 0) {
    warnings.push(
      "An audio track declares no language; it is retained as the source default.",
    );
  }

  return {
    audio,
    subtitles,
    keptAudioStreamIndexes: audio
      .filter((d) => d.keep)
      .map((d) => d.streamIndex),
    keptSubtitleStreamIndexes: subtitles
      .filter((d) => d.keep && d.isTextBased)
      .map((d) => d.streamIndex),
    warnings,
  };
}
