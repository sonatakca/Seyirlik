/**
 * The library folder an import's title already owns.
 *
 * A catalogue item is identified by its `source_key`, which the scanner derives
 * from the title's folder. An import that names its folder from its own rules
 * — `Title (Year)` for a film, `Title` for a series — lands somewhere the item
 * was never keyed to whenever the two disagree, and the next scan makes a
 * second title for the same show. They disagree routinely: a wanted series is
 * keyed `Lilyhammer (2012)` while the importer files series without a year, a
 * series already in the library may have a folder named any way at all, and a
 * film's title can change between the want and the download.
 *
 * So when the import knows its item, the folder comes from the item: the key's
 * last segment, with its letter case recovered from a file the item already has
 * or from the name the want created it under. A key that cannot be turned back
 * into a folder under this import's library root names nothing, and the import
 * falls back to its own naming rather than guessing.
 */
import type { DatabasePool } from "../database/databasePool";
import { desiredFolderName } from "../catalogue/desiredItems";
import { safeSegment } from "./importDestination";

export interface OwnedFolderInput {
  readonly kind: string;
  readonly sourceKey: string;
  readonly title: string;
  readonly year?: number;
  /** Any file the title already has, relative to the media root. */
  readonly existingPath?: string;
  /** The import's library root, absolute. */
  readonly libraryRoot: string;
}

function normalised(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function ownedFolder(input: OwnedFolderInput): string | undefined {
  if (input.kind !== "movie" && input.kind !== "series") return undefined;
  const prefix = `${input.kind}:`;
  if (!input.sourceKey.startsWith(prefix)) return undefined;

  const keyPath = input.sourceKey.slice(prefix.length);
  const separator = keyPath.lastIndexOf("/");
  const parent = separator < 0 ? "" : keyPath.slice(0, separator);
  const folder = keyPath.slice(separator + 1);
  if (!folder) return undefined;

  // The folder must sit directly under this import's library root, or it is
  // not a folder this import can write.
  const root = normalised(input.libraryRoot);
  if (parent && root !== parent && !root.endsWith(`/${parent}`)) {
    return undefined;
  }

  const candidates = [
    ...(input.existingPath?.split(/[\\/]/) ?? []),
    desiredFolderName(input.title, input.year),
    desiredFolderName(input.title),
  ];
  return candidates.find(
    (name) =>
      name.toLowerCase() === folder &&
      safeSegment(name) === name &&
      name !== "",
  );
}

/** Reads what `ownedFolder` needs for the title an item belongs to. */
export async function ownedFolderForItem(
  pool: Pick<DatabasePool, "query">,
  itemId: string,
  libraryRoot: string,
): Promise<string | undefined> {
  // An episode or a season is filed under its series.
  const result = await pool.query<{
    kind: string;
    source_key: string;
    title: string;
    production_year: number | null;
    existing_path: string | null;
  }>(
    `SELECT title.kind, title.source_key, title.title, title.production_year,
            (SELECT file.relative_path
               FROM media_files file
               JOIN items owner ON owner.id = file.item_id
              WHERE owner.id = title.id OR owner.series_id = title.id
              ORDER BY file.missing_since IS NOT NULL, file.relative_path
              LIMIT 1) AS existing_path
       FROM items item
       JOIN items title ON title.id = COALESCE(item.series_id, item.id)
      WHERE item.id = $1`,
    [itemId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return ownedFolder({
    kind: row.kind,
    sourceKey: row.source_key,
    title: row.title,
    ...(row.production_year === null ? {} : { year: row.production_year }),
    ...(row.existing_path ? { existingPath: row.existing_path } : {}),
    libraryRoot,
  });
}
