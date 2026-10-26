import { describe, expect, it } from "vitest";
import type { DatabasePool } from "../database/databasePool";
import { createCatalogueScanStore } from "./catalogueScanStore";

describe("catalogue scan subtitle association", () => {
  it("moves sidecars off missing cuts and onto the active primary file", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    let released = false;
    // The rewrite runs in one transaction on a checked-out client, so the
    // double hands out a client and records every statement sent to it.
    const pool = {
      connect: async () => ({
        query: async (sql: string, values?: unknown[]) => {
          calls.push({ sql, values });
          return sql.includes("SELECT id FROM media_files")
            ? { rows: [{ id: "active-file" }] }
            : { rows: [] };
        },
        release: () => {
          released = true;
        },
      }),
    } as unknown as DatabasePool;

    await createCatalogueScanStore(pool).replaceExternalSubtitles("item-1", [
      {
        relativePath: "Movies/Movie/Movie.tr.srt",
        codec: "subrip",
        isText: true,
        language: "tr",
        isDefault: false,
        isForced: false,
      },
    ]);

    expect(calls[0]?.sql).toBe("BEGIN");
    expect(calls[1]?.sql).toContain("missing_since IS NULL");
    expect(calls[1]?.values).toEqual(["item-1"]);
    expect(calls[2]?.values).toEqual(["active-file"]);
    // Every cut of the title loses its sidecars except the ones the active
    // file keeps; with nothing recorded yet, it keeps none.
    expect(calls[3]?.sql).toContain(
      "media_file_id IN (SELECT id FROM media_files WHERE item_id=$1)",
    );
    expect(calls[3]?.sql).toContain("media_file_id<>$2");
    expect(calls[3]?.values).toEqual(["item-1", "active-file", []]);
    expect(calls[4]?.values).toEqual([
      "active-file",
      10_000,
      "subrip",
      "tr",
      false,
      false,
      true,
      "Movies/Movie/Movie.tr.srt",
    ]);
    expect(calls[5]?.sql).toBe("COMMIT");
    expect(calls).toHaveLength(6);
    expect(released).toBe(true);
  });
});
