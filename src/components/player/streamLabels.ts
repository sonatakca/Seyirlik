import type { MediaStream } from "../../lib/types";
import type { TranslationKey } from "../../i18n/translations";
import { normalizeLanguage } from "../../renditions/processing/languages";

type Translate = (key: TranslationKey) => string;

/** Viewer-facing names; codec and container metadata belongs in diagnostics. */
export function streamLabels(
  streams: MediaStream[],
  type: "audio" | "subtitle",
  language: string,
  t: Translate,
): string[] {
  const names = new Intl.DisplayNames([language], {
    type: "language",
    fallback: "none",
  });
  const seen = new Map<string, number>();
  return streams.map((stream, index) => {
    const normalized = normalizeLanguage(stream.Language);
    const base = stream.Language?.trim().split(/[-_]/)[0] ?? "";
    const code =
      normalized === "und" && /^[a-z]{2}$/i.test(base)
        ? base.toLowerCase()
        : normalized;
    let name: string | undefined;
    try {
      if (code !== "und") name = names.of(code);
    } catch {
      // Invalid container tags get a numbered track, never a technical label.
    }
    const fallback = t(
      type === "audio" ? "settings.audioTrack" : "settings.subtitle",
    ).replace("{number}", String(index + 1));
    const parts = [name ?? fallback];
    const title = `${stream.Title ?? ""} ${stream.DisplayTitle ?? ""}`;
    if (/\bcommentary\b|\bcommentaire\b|\byorum\b/i.test(title)) {
      parts.push(t("settings.track.commentary"));
    }
    if (type === "audio") {
      if (
        /audio[ -]description|\bdescriptive\b|\bAD\b|sesli betimleme/i.test(
          title,
        )
      ) {
        parts.push(t("settings.track.description"));
      }
      if (stream.Channels === 1) parts.push(t("settings.track.mono"));
      else if (stream.Channels === 2) parts.push(t("settings.track.stereo"));
      else if (stream.Channels && stream.Channels > 2) {
        const layout =
          stream.Channels === 6 ? "5.1" : stream.Channels === 8 ? "7.1" : "";
        parts.push(
          `${t("settings.track.surround")}${layout ? ` ${layout}` : ""}`,
        );
      }
    } else {
      if (
        /\b(sdh|cc)\b|hearing[ -]impaired|\bdeaf\b|işitme engelli/i.test(title)
      ) {
        parts.push(t("settings.track.hearing"));
      }
      if (stream.IsForced || /\bforced\b|\bforeign[ -]only\b/i.test(title)) {
        parts.push(t("settings.track.foreign"));
      }
    }
    const label = parts.join(" · ");
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    return count === 1 ? label : `${label} (${count})`;
  });
}
