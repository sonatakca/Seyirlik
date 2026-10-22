import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Whether this module is the one Node was asked to run.
 *
 * The obvious form of this check — resolve `argv[1]`, resolve the module's own
 * URL, compare — is wrong as soon as the application is reached through a link,
 * because the two sides are canonicalised differently. Node resolves module
 * specifiers through symlinks and junctions, so `import.meta.url` is already
 * the real path on disk; `argv[1]` is whatever the command line said, resolved
 * against the working directory and nothing more.
 *
 * Run from `C:\ProgramData\Seyirlik\app\current\` — a junction to the active
 * release — those two disagree, the guard says no, and the process exits zero
 * having started nothing. Silently, and with a success code, which is the worst
 * available way to fail: a supervisor sees a clean exit and simply restarts it.
 * (Releases hard-link their unchanged files from the release before them; a
 * hard link is a real path inside its own release, so that changes nothing
 * here. Only the junction does.)
 *
 * So both sides are canonicalised. Resolution failures fall back to the plain
 * resolve rather than throwing: a missing `argv[1]` means this is not the
 * entrypoint anyway, and answering that question must never be what stops a
 * process from starting.
 */
function canonicalise(target: string): string {
  const resolved = path.resolve(target);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function isMainEntrypoint(
  moduleUrl: string,
  entryArgument: string | undefined = process.argv[1],
): boolean {
  if (!entryArgument) return false;
  return canonicalise(entryArgument) === canonicalise(fileURLToPath(moduleUrl));
}
