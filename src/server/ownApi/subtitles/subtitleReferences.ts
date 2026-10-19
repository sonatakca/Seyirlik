import type { AudioReference } from "./subtitleFit";

/**
 * What a title can be timed against, wherever it now lives.
 *
 * Processing turns a source into a package — a ladder of video renditions, one
 * audio rendition per kept audio track, and WebVTT copies of its text subtitles
 * — and the source is then removed. Everything a subtitle is aligned against
 * survives in that package: the audio is the same print, and a subtitle that
 * was inside the video is timed for it. So these answer from the package first
 * and from the source only for a title not packaged yet. Nothing here ever
 * needs the source to exist.
 */
export interface TitleReferences {
  /**
   * The audio of one source stream (the default when absent or not packaged):
   * the package's rendition through its playlist, else the source's own track.
   */
  audio(target: {
    mediaFileId: string;
    relativePath: string;
    sourceStreamIndex?: number;
  }): Promise<AudioReference | null>;
  /**
   * The package's WebVTT copies of text subtitles that were inside the video,
   * absolute. A sidecar is left out: it was not authored against this video,
   * which is the one property a reference needs.
   */
  embeddedSubtitles(target: {
    mediaFileId: string;
    relativePath: string;
  }): Promise<{ streamIndex: number; language: string | null; path: string }[]>;
}
