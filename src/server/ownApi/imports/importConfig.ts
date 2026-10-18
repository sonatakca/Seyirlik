/**
 * Where downloads come from, and what an import is allowed to do with them.
 *
 * Deliberately a separate declaration from the download client's. SABnzbd's
 * category directory is where *it* puts finished downloads; this is where
 * Seyirlik is willing to read them from. They are normally the same path, and
 * the day they are not, the importer must follow the one it was authorised
 * against rather than the one another program happens to be writing to.
 */
export interface ImportConfig {
  /** The only directory an import will read a download out of. */
  readonly downloadRoot: string;
  /**
   * Whether the download must survive the import.
   *
   * True while a release is still being seeded. It rules out `move`, and it
   * stops cleanup removing anything.
   */
  readonly retainSource: boolean;
  /** Real copies rather than hardlinks, when an operator wants them. */
  readonly forceCopy: boolean;
  /**
   * Whether an imported media file is queued for processing by itself, once
   * the library has registered it. On unless declared `false`: a download is
   * asked for in order to be watched, and an unprocessed one is not yet
   * something the site can serve well.
   */
  readonly autoProcess: boolean;
}

function fail(message: string): never {
  throw new Error(`SEYIRLIK_IMPORT is invalid: ${message}`);
}

/**
 * Parses the declaration.
 *
 * Absent configuration is not an error: a server that is not importing
 * anything is a perfectly good media server, and this phase is additive. A
 * *declared* import root that is not absolute is an error, because a relative
 * one would resolve against whatever directory the service happened to start
 * in — which is not a root anybody authorised.
 */
export function parseImportConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ImportConfig | undefined {
  const raw = environment.SEYIRLIK_IMPORT?.trim();
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("it is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("it must be an object.");
  }
  const entry = parsed as Record<string, unknown>;

  const downloadRoot =
    typeof entry.downloadRoot === "string" ? entry.downloadRoot.trim() : "";
  if (!downloadRoot) fail("it needs a downloadRoot.");
  // Absolute on either platform: a drive letter, a UNC path, or a POSIX root.
  if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(downloadRoot)) {
    fail("downloadRoot must be an absolute path.");
  }

  for (const flag of ["retainSource", "forceCopy", "autoProcess"]) {
    if (entry[flag] !== undefined && typeof entry[flag] !== "boolean") {
      fail(`${flag} must be true or false.`);
    }
  }

  return {
    downloadRoot: downloadRoot.replace(/[\\/]+$/, ""),
    retainSource: entry.retainSource === true,
    forceCopy: entry.forceCopy === true,
    autoProcess: entry.autoProcess !== false,
  };
}
