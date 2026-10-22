import type { NotificationTone } from "./notificationStore";
import type { TaskType } from "./taskPresentation";

/**
 * What colour a notification card wears.
 *
 * Seyirlik's six accents are the six bars of the logo, and they run warm to
 * cool. The pile borrows that ramp whole and reads it as one scale: the warm
 * end is trouble, and the cool run is healthy work, ordered by how far through
 * the pipeline the job has travelled. A column of cards ends up looking like
 * the mark it belongs to, and the colour answers "which job is that?" before
 * the text is read.
 *
 * Status still outranks the job. A failure is red whatever produced it, and a
 * job that needs a person is amber whatever produced it: no family hue is ever
 * allowed to mute the two states somebody has to act on.
 *
 * Colour is never the only code here. The glyph carries the state, the card
 * names its own work, and the ramp itself steps down in lightness as it goes —
 * 11.4:1 at discovery to 4.5:1 at export — so the order survives being read
 * without colour at all.
 */

/** The four kinds of background work, in the order the pipeline performs them. */
export type TaskFamily = "discovery" | "description" | "encoding" | "export";

/**
 * Which family each task belongs to.
 *
 * Keyed by the shared task vocabulary rather than by a loose string, so a new
 * task type cannot quietly appear with no colour: the map stops compiling
 * until it is placed.
 */
export const TASK_FAMILIES: Record<TaskType, TaskFamily> = {
  "acquisition.submit": "discovery",
  "acquisition.reconcile": "discovery",
  "import.run": "export",
  "import.reconcile": "export",
  "import.handoff": "export",
  "import.process": "export",
  "storage.collect": "discovery",
  "subtitle.run": "description",
  "subtitle.reconcile": "description",
  "subtitle.auth-resume": "description",
  "subtitle.sync": "description",
  // Finding out what is on the disk at all.
  "library.scan": "discovery",
  "library.maintenance": "discovery",
  "media.probe": "discovery",
  // Describing and illustrating what was found.
  "metadata.scan": "description",
  "metadata.refresh": "description",
  "trickplay.generate": "description",
  "trickplay.scan": "description",
  "segments.scan": "description",
  "segments.detect": "description",
  "catalogue.enrich": "description",
  // Turning it into something this browser can actually play.
  "media.process": "encoding",
  // Writing the catalogue back out to the disk it came from.
  "library.rename": "export",
  "library.organize": "export",
  "nfo.export.item": "export",
  "nfo.export.library": "export",
};

/**
 * The card colours, measured against the card's own background (`#0b0b10`).
 *
 * Every value clears 4.5:1 there, which is stricter than the 3:1 an icon or a
 * progress bar owes, because these same values also tint small text inside an
 * opened card. Where the brand hex fell short it was lifted in OKLCH — hue and
 * chroma kept, lightness raised — rather than swapped for a different colour.
 */
export const NOTIFICATION_ACCENTS = {
  /** Warm Red, lifted from #bd3f28 (3.65:1) to clear text contrast. */
  error: "#d7573f",
  /** Amber, the brand value unchanged. */
  warning: "#fa9b1d",
  /** Gold, the brand value unchanged. */
  discovery: "#d3ca22",
  /** Olive, darkened from #bacb7d so it does not read as a second gold. */
  description: "#a7b76a",
  /** Green, the brand value unchanged. */
  encoding: "#67a478",
  /** Teal, lifted from #337b6c (3.92:1) to clear text contrast. */
  export: "#3e8575",
  /**
   * Not a job.
   *
   * A toast that reports on nothing in the queue stays uncoloured, so that
   * colour on a card keeps one meaning: there is work behind this. Trouble is
   * the exception — an error is red whether or not a task raised it.
   */
  neutral: "rgba(255, 255, 255, 0.82)",
} as const satisfies Record<
  TaskFamily | "error" | "warning" | "neutral",
  string
>;

/**
 * The colour for one card.
 *
 * Order matters: trouble first, then the family, then nothing. A failed encode
 * is red rather than green, and an encode that is merely running is green
 * rather than the sky blue that used to stand in for every state the palette
 * had no answer for.
 */
export function resolveNotificationAccent(
  tone: NotificationTone,
  taskType?: string,
): string {
  if (tone === "error") {
    return NOTIFICATION_ACCENTS.error;
  }

  if (tone === "warning") {
    return NOTIFICATION_ACCENTS.warning;
  }

  const family = taskType
    ? TASK_FAMILIES[taskType as TaskType]
    : /*
       * A task type this build has never heard of — an older client against a
       * newer server — is still work, and still better off in the ramp than
       * outside it. It takes the colour of the stage most background work is
       * in when a person is watching the pile.
       */
      undefined;

  if (family) {
    return NOTIFICATION_ACCENTS[family];
  }

  return taskType
    ? NOTIFICATION_ACCENTS.encoding
    : NOTIFICATION_ACCENTS.neutral;
}
