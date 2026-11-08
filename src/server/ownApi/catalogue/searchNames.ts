/**
 * The names a title is found by besides the one it is shown under: its
 * original title, the provider's names in other languages, and the names an
 * administrator added. Admin lists send these next to the title so every
 * search box on the site finds a title by the same names the main search does.
 * Each name appears once, and the shown title is left out.
 */
export function otherSearchNames(
  shown: string | null | undefined,
  originalTitle: string | null | undefined,
  localizedTitles: Record<string, string> | null | undefined,
  searchAliases: readonly string[] | null | undefined,
): string[] {
  const key = (value: string) => value.trim().toLocaleLowerCase("tr");
  const seen = new Set(shown ? [key(shown)] : []);
  const names: string[] = [];
  for (const value of [
    originalTitle,
    ...Object.values(localizedTitles ?? {}),
    ...(searchAliases ?? []),
  ]) {
    if (typeof value !== "string" || !value.trim()) continue;
    if (seen.has(key(value))) continue;
    seen.add(key(value));
    names.push(value);
  }
  return names;
}
