import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import { OwnApiError } from "../ownApiHandler";

/**
 * Serving bytes off disk.
 *
 * Ranges, HEAD, 416, and destroying the read stream when the client walks away
 * are all easy to get subtly wrong, and a second copy diverges from the first —
 * one did, and leaked a file handle on every aborted request. There is one
 * implementation, and everything that hands out a file uses it.
 */

export function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "unsatisfiable";

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "unsatisfiable";

  if (!rawStart) {
    // Suffix range: the last N bytes.
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return "unsatisfiable";
    }
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isFinite(start) || start >= size || end < start) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(end, size - 1) };
}

const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  m3u8: "application/vnd.apple.mpegurl",
  ts: "video/mp2t",
  m4s: "video/iso.segment",
  vtt: "text/vtt; charset=utf-8",
  // A book read aloud (narrationStore.ts): AAC in MP4.
  m4a: "audio/mp4",
  // Books. epub.js refuses an archive it is not told the type of, so these
  // matter as much as the video types do.
  epub: "application/epub+zip",
  pdf: "application/pdf",
  cbz: "application/vnd.comicbook+zip",
  cbr: "application/vnd.comicbook-rar",
  txt: "text/plain; charset=utf-8",
};

export function contentTypeFor(fileName: string): string {
  const extension = path.extname(fileName).replace(".", "").toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

export async function serveFile(
  response: ServerResponse,
  absolutePath: string,
  rangeHeader: string | undefined,
  isHeadRequest: boolean,
  cacheControl: string,
): Promise<void> {
  const stats = await stat(absolutePath).catch(() => null);
  if (!stats?.isFile()) {
    throw new OwnApiError(
      "MEDIA_NOT_FOUND",
      "The requested media could not be found.",
      404,
    );
  }

  const range = parseByteRange(rangeHeader, stats.size);
  if (range === "unsatisfiable") {
    response.setHeader("Content-Range", `bytes */${stats.size}`);
    throw new OwnApiError(
      "RANGE_NOT_SATISFIABLE",
      "The requested range cannot be satisfied.",
      416,
    );
  }

  response.setHeader("Content-Type", contentTypeFor(absolutePath));
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Cache-Control", cacheControl);
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (range) {
    response.statusCode = 206;
    response.setHeader(
      "Content-Range",
      `bytes ${range.start}-${range.end}/${stats.size}`,
    );
    response.setHeader("Content-Length", String(range.end - range.start + 1));
  } else {
    response.statusCode = 200;
    response.setHeader("Content-Length", String(stats.size));
  }

  if (isHeadRequest) {
    response.end();
    return;
  }

  await streamToResponse(
    createReadStream(
      absolutePath,
      range ? { start: range.start, end: range.end } : undefined,
    ),
    response,
  );
}

/**
 * Errors that mean "the client is gone", not "the server failed".
 *
 * A player that seeks, a tab that closes, a phone that leaves the network: all
 * of them tear down the socket mid-body, and the tear-down surfaces as one of
 * these. None is a fault of ours and none should be reported as one.
 */
function isClientDisconnect(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    code === "ERR_STREAM_DESTROYED" ||
    code === "ERR_STREAM_WRITE_AFTER_END" ||
    code === "ECANCELED"
  );
}

/**
 * Sends a stream to a response and settles exactly once.
 *
 * This used to be `stream.pipe(response)` with `reject` wired to both ends, and
 * that is how a routine aborted seek killed the whole server: the rejection
 * travelled out of an async request handler nothing was awaiting, which Node
 * treats as an unhandled rejection and ends the process for. An abort is the
 * normal end of a byte range, so it resolves; only a real read failure rejects,
 * and the read stream is destroyed either way so no descriptor is left behind.
 */
export function streamToResponse(
  stream: Readable,
  response: ServerResponse,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      stream.destroy();
      if (error && !isClientDisconnect(error)) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      resolve();
    };

    stream.on("error", settle);
    response.on("error", settle);
    // Fires both when the body has been delivered and when the client walked
    // away part-way through; either way there is nothing left to send.
    response.on("close", () => settle());
    response.on("finish", () => settle());
    stream.pipe(response);
  });
}
