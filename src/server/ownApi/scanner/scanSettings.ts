/**
 * The two scan settings a host with a partial library needs.
 *
 * Both default to the behaviour every other host has: titles missing past the
 * grace period are deleted, and nothing scans on a timer.
 */

/** `SEYIRLIK_CATALOGUE_DELETE_MISSING`: whether a scan may delete titles. */
export function parseDeleteMissing(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error("SEYIRLIK_CATALOGUE_DELETE_MISSING must be true or false.");
}

/**
 * `SEYIRLIK_LIBRARY_RESCAN_MINUTES`: how often every library is scanned, in
 * milliseconds, or null when unset.
 *
 * On a cloud mount the scan is what notices a title finishing its upload (and
 * one disappearing), so it has to run without anybody pressing a button.
 */
export function parseRescanMinutes(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const minutes = Number(trimmed);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
    throw new Error(
      "SEYIRLIK_LIBRARY_RESCAN_MINUTES must be a whole number of minutes between 1 and 1440.",
    );
  }
  return minutes * 60_000;
}
