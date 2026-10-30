import type { Person, PersonChanges } from "../../lib/peopleApi";

/** The limits offered, as the ages the rating boards themselves use. */
export const CONTENT_AGE_LIMITS = [7, 10, 13, 16, 18] as const;

export interface PersonDraft {
  displayName: string;
  isAdministrator: boolean;
  isDisabled: boolean;
  allowPlayback: boolean;
  allowDownloads: boolean;
  allowAllLibraries: boolean;
  libraryIds: string[];
  maxContentAge: number | null;
  allowUnratedContent: boolean;
}

/** What a person made from the page starts with: the server's own defaults. */
export function emptyDraft(): PersonDraft {
  return {
    displayName: "",
    isAdministrator: false,
    isDisabled: false,
    allowPlayback: true,
    allowDownloads: false,
    allowAllLibraries: true,
    libraryIds: [],
    maxContentAge: null,
    allowUnratedContent: false,
  };
}

export function draftOf(person: Person): PersonDraft {
  return {
    displayName: person.displayName,
    isAdministrator: person.isAdministrator,
    isDisabled: person.isDisabled,
    allowPlayback: person.allowPlayback,
    allowDownloads: person.allowDownloads,
    allowAllLibraries: person.allowAllLibraries,
    libraryIds: [...person.libraryIds].sort(),
    maxContentAge: person.maxContentAge,
    allowUnratedContent: person.allowUnratedContent,
  };
}

/**
 * Only what differs from `base`, so a save never rewrites a field somebody
 * else changed meanwhile and an untouched form sends nothing at all.
 */
export function changesBetween(
  base: PersonDraft,
  draft: PersonDraft,
): PersonChanges {
  const changes: PersonChanges = {};
  if (draft.displayName.trim() !== base.displayName)
    changes.displayName = draft.displayName.trim();
  if (draft.isAdministrator !== base.isAdministrator)
    changes.isAdministrator = draft.isAdministrator;
  if (draft.isDisabled !== base.isDisabled)
    changes.isDisabled = draft.isDisabled;
  if (draft.allowPlayback !== base.allowPlayback)
    changes.allowPlayback = draft.allowPlayback;
  if (draft.allowDownloads !== base.allowDownloads)
    changes.allowDownloads = draft.allowDownloads;
  if (draft.allowAllLibraries !== base.allowAllLibraries)
    changes.allowAllLibraries = draft.allowAllLibraries;
  const libraries = [...draft.libraryIds].sort();
  if (libraries.join() !== [...base.libraryIds].sort().join())
    changes.libraryIds = libraries;
  if (draft.maxContentAge !== base.maxContentAge)
    changes.maxContentAge = draft.maxContentAge;
  if (draft.allowUnratedContent !== base.allowUnratedContent)
    changes.allowUnratedContent = draft.allowUnratedContent;
  return changes;
}

/** Two letters for a monogram: first and last word, or the first two. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = Array.from(words[0] ?? "");
  if (words.length > 1) {
    const last = Array.from(words.at(-1) ?? "");
    return `${first[0] ?? ""}${last[0] ?? ""}`.toLocaleUpperCase();
  }
  return first.slice(0, 2).join("").toLocaleUpperCase();
}

/** Administrators first, then by the name people know them by. */
export function orderPeople(people: Person[], language: string): Person[] {
  return [...people].sort(
    (left, right) =>
      Number(right.isAdministrator) - Number(left.isAdministrator) ||
      Number(left.isDisabled) - Number(right.isDisabled) ||
      left.displayName.localeCompare(right.displayName, language, {
        sensitivity: "base",
      }),
  );
}

export function formatDate(value: string | null, language: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(language, {
    day: "numeric",
    month: "short",
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  }).format(date);
}

export function fillTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.split(`{${key}}`).join(String(value)),
    template,
  );
}
