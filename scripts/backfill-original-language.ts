import {
  createDatabasePool,
  type DatabasePool,
} from "../src/server/ownApi/database/databasePool";
import { parseDatabaseConfig } from "../src/server/ownApi/database/databaseConfig";
import {
  createTmdbClient,
  TmdbError,
  type TmdbClient,
  type TmdbTitleDetails,
} from "../src/server/ownApi/metadata/tmdbClient";

/**
 * Records each film's and series' original language from TMDB.
 *
 * A metadata refresh stores it from now on, but titles matched before the
 * column existed have none, and the audio policy then keeps a release's
 * default track even when that track is a dub. A library-wide refresh would
 * fill the column too, but it also rewrites every title's metadata and artwork.
 * This asks TMDB for the language alone and touches nothing else.
 *
 * Run it without `--apply` first — it prints what it found and writes nothing.
 * `--title <text>` limits it to titles whose name contains the text.
 */

interface Options {
  apply: boolean;
  title?: string;
}

interface TitleRow {
  id: string;
  kind: "movie" | "series";
  title: string;
  tmdb_id: string;
}

/** Enough parallel lookups to finish quickly, few enough to be polite. */
const CONCURRENCY = 6;

function parseArguments(argv: string[]): Options {
  const options: Options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--title") options.title = argv[++index];
    else if (argument !== undefined) {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

/** One lookup, waiting out TMDB's rate limit rather than counting it a miss. */
async function lookUp(
  tmdb: TmdbClient,
  row: TitleRow,
): Promise<TmdbTitleDetails> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return row.kind === "movie"
        ? await tmdb.getMovie(row.tmdb_id)
        : await tmdb.getSeries(row.tmdb_id);
    } catch (error) {
      const retryable =
        error instanceof TmdbError &&
        (error.kind === "rate-limited" || error.kind === "unavailable");
      if (!retryable || attempt >= 3) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, 1_000 * (attempt + 1)),
      );
    }
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const apiKey = requireEnvironment("SEYIRLIK_TMDB_API_KEY");
  const config = parseDatabaseConfig({ ...process.env });
  if (!config) throw new Error("Native database configuration is unavailable.");

  const pool: DatabasePool = createDatabasePool(config);
  const tmdb = createTmdbClient({ apiKey });

  try {
    const titles = (
      await pool.query<TitleRow>(
        `SELECT id, kind, title, provider_ids->>'tmdb' AS tmdb_id
         FROM items
         WHERE kind IN ('movie', 'series')
           AND provider_ids ? 'tmdb'
           AND original_language IS NULL
           AND ($1::text IS NULL OR title ILIKE '%' || $1 || '%')
         ORDER BY title`,
        [options.title ?? null],
      )
    ).rows;

    console.info(`${titles.length} title(s) have no original language yet.`);
    const summary = { found: 0, none: 0, failed: 0 };

    for (let start = 0; start < titles.length; start += CONCURRENCY) {
      await Promise.all(
        titles.slice(start, start + CONCURRENCY).map(async (row) => {
          try {
            const language = (await lookUp(tmdb, row)).originalLanguage;
            if (!language) {
              summary.none += 1;
              return;
            }
            console.info(`  ${row.title}: ${language}`);
            if (options.apply) {
              await pool.query(
                `UPDATE items SET original_language = $2
                 WHERE id = $1 AND original_language IS NULL`,
                [row.id, language],
              );
            }
            summary.found += 1;
          } catch (error) {
            console.info(
              `  FAILED ${row.title} (${row.tmdb_id}): ${error instanceof Error ? error.message : "lookup failed"}`,
            );
            summary.failed += 1;
          }
        }),
      );
    }

    console.info(
      options.apply
        ? `Languages stored ${summary.found}, none on TMDB ${summary.none}, failed ${summary.failed}.`
        : `${summary.found} language(s) would be stored, ${summary.none} have none on TMDB, ${summary.failed} failed. Re-run with --apply to write them.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    "Original language backfill failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
});
