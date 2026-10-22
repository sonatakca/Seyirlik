/**
 * What in a migration would break the release before it.
 *
 * A text check, deliberately: it catches the statements that take something
 * away — dropping, renaming, retyping, newly requiring a value older code does
 * not write — and nothing subtler. A new CHECK constraint that old code
 * violates is still possible and still on the author. Comments are stripped
 * first so a migration may talk about what it does not do.
 */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bDROP\s+COLUMN\b/i, "drops a column"],
  [/\bDROP\s+TABLE\b/i, "drops a table"],
  [/\bRENAME\b/i, "renames"],
  [/\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i, "changes a type"],
  [/\bSET\s+NOT\s+NULL\b/i, "SET NOT NULL"],
];

const ADD_COLUMN = /\bADD\s+COLUMN\b[^,;]*/gi;

export function additiveViolations(sql: string): string[] {
  if (/^\s*--\s*contract:/im.test(sql)) return [];
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
  const found = RULES.filter(([pattern]) => pattern.test(code)).map(
    ([, reason]) => reason,
  );
  for (const clause of code.match(ADD_COLUMN) ?? []) {
    if (/\bNOT\s+NULL\b/i.test(clause) && !/\bDEFAULT\b/i.test(clause)) {
      found.push("adds a column NOT NULL with no DEFAULT");
    }
  }
  return found;
}
