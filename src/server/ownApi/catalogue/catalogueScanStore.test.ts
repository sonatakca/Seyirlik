import { describe, expect, it } from "vitest";
import type { DatabasePool } from "../database/databasePool";
import { createCatalogueScanStore } from "./catalogueScanStore";

describe("catalogue scan subtitle association", () => {
  it("moves sidecars off missing cuts and onto the active primary file", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    let released = false;
    // One transaction on one client, so a scan and an upload cannot interleave.
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
    expect(calls[3]?.sql).toContain(
      "media_file_id IN (SELECT id FROM media_files WHERE item_id=$1)",
    );
    expect(calls[3]?.values?.slice(0, 2)).toEqual(["item-1", "active-file"]);
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
    expect(released).toBe(true);
  });
});
