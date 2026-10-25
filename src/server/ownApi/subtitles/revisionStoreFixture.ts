import { randomUUID } from "node:crypto";
import {
  RevisionBusyError,
  type RevisionOrigin,
  type SubtitleRevisionStore,
  type SubtitleRevisionWithContent,
} from "./subtitleRevisions";
import { subtitleDigest } from "./subtitleStorage";

/**
 * The revision store's contract in memory, for tests of what sits above it.
 * The store itself — numbering under a lock, one pending row per path — is
 * tested against PostgreSQL in `subtitleRevisions.integration.test.ts`.
 */
export function memoryRevisionStore(): SubtitleRevisionStore & {
  readonly rows: SubtitleRevisionWithContent[];
} {
  const rows: SubtitleRevisionWithContent[] = [];
  const ofPath = (mediaFileId: string, relativePath: string) =>
    rows
      .filter(
        (row) =>
          row.mediaFileId === mediaFileId && row.relativePath === relativePath,
      )
      .sort((left, right) => right.revision - left.revision);
  const strip = ({ content: _content, ...row }: SubtitleRevisionWithContent) =>
    row;
  const insert = (input: {
    mediaFileId: string;
    relativePath: string;
    origin: RevisionOrigin;
    state: "pending" | "committed";
    bytes: Uint8Array;
    parentId: string | null;
    provenance?: Record<string, unknown>;
  }) => {
    const row: SubtitleRevisionWithContent = {
      id: randomUUID(),
      mediaFileId: input.mediaFileId,
      relativePath: input.relativePath,
      revision:
        (ofPath(input.mediaFileId, input.relativePath)[0]?.revision ?? 0) + 1,
      origin: input.origin,
      state: input.state,
      sha256: subtitleDigest(input.bytes),
      sizeBytes: input.bytes.length,
      parentId: input.parentId,
      provenance: input.provenance ?? {},
      failure: null,
      createdAt: new Date(),
      settledAt: input.state === "pending" ? null : new Date(),
      content: new Uint8Array(input.bytes),
    };
    rows.push(row);
    return strip(row);
  };
  return {
    rows,
    async list(mediaFileId, relativePath) {
      return ofPath(mediaFileId, relativePath).map(strip);
    },
    async get(id) {
      return rows.find((row) => row.id === id) ?? null;
    },
    async head(mediaFileId, relativePath) {
      const head = ofPath(mediaFileId, relativePath).find(
        (row) => row.state === "committed",
      );
      return head ? strip(head) : null;
    },
    async pending(mediaFileId, relativePath) {
      return (
        ofPath(mediaFileId, relativePath).find(
          (row) => row.state === "pending",
        ) ?? null
      );
    },
    async pendingPaths() {
      return rows
        .filter((row) => row.state === "pending" && row.mediaFileId !== null)
        .map((row) => ({
          mediaFileId: row.mediaFileId as string,
          relativePath: row.relativePath,
        }));
    },
    async observe({ mediaFileId, relativePath, bytes, provenance }) {
      const head = await this.head(mediaFileId, relativePath);
      if (head && head.sha256 === subtitleDigest(bytes)) return head;
      return insert({
        mediaFileId,
        relativePath,
        origin: head ? "external" : "original",
        state: "committed",
        bytes,
        parentId: null,
        ...(provenance ? { provenance } : {}),
      });
    },
    async record(input) {
      return insert({
        ...input,
        state: "committed",
        parentId: input.parentId ?? null,
      });
    },
    async begin(input) {
      if (await this.pending(input.mediaFileId, input.relativePath))
        throw new RevisionBusyError();
      return insert({ ...input, state: "pending" });
    },
    async settle(id, state, failure) {
      const index = rows.findIndex(
        (row) => row.id === id && row.state === "pending",
      );
      if (index < 0) return;
      rows[index] = {
        ...(rows[index] as SubtitleRevisionWithContent),
        state,
        failure: failure ?? null,
        settledAt: new Date(),
      };
    },
  };
}
