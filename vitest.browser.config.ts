/// <reference types="vitest" />
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";

import { defineBrowserCommand, playwright } from "@vitest/browser-playwright";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import {
  RENDITION_FIXTURES,
  ensureRenditionFixtures,
  getFixtureDirectory,
} from "./src/test/renditionFixtures";
import { ensureEpochPackageFixture } from "./src/test/epochPackageFixture";
import { ensureLadderFixture } from "./src/test/ladderFixture";

/**
 * Serves the generated renditions the way the media server does: complete
 * files, with byte ranges.
 *
 * Range support is not incidental here — the whole seamless path is only
 * offered for seekable complete-file sources, so a fixture server that ignored
 * `Range` would be testing something the production path never sees.
 */
function serveRenditionFixtures(): Plugin {
  const allowed = new Set([
    ...RENDITION_FIXTURES.map((fixture) => fixture.fileName),
    // Container benchmark pair: identical codecs, bitrate, resolution, duration
    // and GOP, differing only in progressive versus fragmented layout.
    "bench-progressive.mp4",
    "bench-fragmented.mp4",
    "bench-fragmented-sidx.mp4",
  ]);

  return {
    name: "seyirlik-serve-rendition-fixtures",
    async configureServer(server) {
      await ensureRenditionFixtures();

      server.middlewares.use("/test-media", (request, response, next) => {
        const fileName = path.basename(
          (request.url ?? "").split("?")[0].replace(/^\//, ""),
        );

        if (!allowed.has(fileName)) {
          next();
          return;
        }

        const filePath = path.join(getFixtureDirectory(), fileName);

        void stat(filePath)
          .then((stats) => {
            const range = /^bytes=(\d*)-(\d*)$/.exec(
              request.headers.range ?? "",
            );

            response.setHeader("Content-Type", "video/mp4");
            response.setHeader("Accept-Ranges", "bytes");
            response.setHeader("Cache-Control", "no-store");

            if (!range) {
              response.setHeader("Content-Length", stats.size);
              response.statusCode = 200;
              createReadStream(filePath).pipe(response);
              return;
            }

            const start = range[1] ? Number(range[1]) : 0;
            const end = range[2]
              ? Math.min(Number(range[2]), stats.size - 1)
              : stats.size - 1;

            if (start >= stats.size || start > end) {
              response.statusCode = 416;
              response.setHeader("Content-Range", `bytes */${stats.size}`);
              response.end();
              return;
            }

            response.statusCode = 206;
            response.setHeader(
              "Content-Range",
              `bytes ${start}-${end}/${stats.size}`,
            );
            response.setHeader("Content-Length", end - start + 1);
            createReadStream(filePath, { start, end }).pipe(response);
          })
          .catch(() => {
            response.statusCode = 404;
            response.end();
          });
      });
    },
  };
}

/**
 * Serves a real assembled epoch package, the way the media server serves a
 * title folder: nested paths, spaces in filenames, and byte ranges.
 *
 * Byte ranges are not optional here. A single-file CMAF rendition is addressed
 * entirely by them, so a fixture server that ignored `Range` would hand the
 * player the whole file for every segment and prove nothing about the packaging
 * this suite exists to check.
 *
 * `/test-epoch-package/__link/<kbps>/<latencyMs>/…` serves the same package
 * through a simulated link: every response waits `latencyMs` before its first
 * byte and is then paced to `kbps`. A master requested under that prefix keeps
 * it for every playlist and segment it refers to, so a real player measures a
 * real slow (or fast) server, which is what the opening-rung tests need.
 */
function paceTo(
  source: Readable,
  bitsPerSecond: number,
  latencyMs: number,
  response: NodeJS.WritableStream,
): void {
  const pacer = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      setTimeout(
        () => callback(null, chunk),
        (chunk.length * 8 * 1000) / bitsPerSecond,
      );
    },
  });
  setTimeout(() => source.pipe(pacer).pipe(response), latencyMs);
}

function serveEpochPackage(): Plugin {
  return {
    name: "seyirlik-serve-epoch-package",
    async configureServer(server) {
      const titleRoot = await ensureEpochPackageFixture().catch((error) => {
        console.warn(
          "[seyirlik] the epoch playback fixture could not be built:",
          error instanceof Error ? error.message : String(error),
        );
        return null;
      });
      server.middlewares.use(
        "/test-epoch-package",
        (request, response, next) => {
          if (!titleRoot) {
            next();
            return;
          }
          const raw = decodeURIComponent(
            (request.url ?? "").split("?")[0].replace(/^\//, ""),
          );
          const link = /^__link\/(\d+)\/(\d+)\/(.*)$/.exec(raw);
          const requested = link ? link[3]! : raw;
          const send = (stream: Readable) =>
            link
              ? paceTo(
                  stream,
                  Number(link[1]) * 1000,
                  Number(link[2]),
                  response,
                )
              : stream.pipe(response);
          const chunked = { highWaterMark: 16 * 1024 };
          const filePath = path.resolve(titleRoot, requested);
          // A fixture server is still a server: a path that escapes the title
          // folder is refused rather than served.
          if (
            filePath !== path.resolve(titleRoot) &&
            !filePath.startsWith(`${path.resolve(titleRoot)}${path.sep}`)
          ) {
            response.statusCode = 403;
            response.end();
            return;
          }

          void stat(filePath)
            .then((stats) => {
              if (!stats.isFile()) {
                response.statusCode = 404;
                response.end();
                return;
              }
              response.setHeader(
                "Content-Type",
                filePath.endsWith(".m3u8")
                  ? "application/vnd.apple.mpegurl"
                  : filePath.endsWith(".m4a")
                    ? "audio/mp4"
                    : "video/mp4",
              );
              response.setHeader("Accept-Ranges", "bytes");
              response.setHeader("Cache-Control", "no-store");
              const range = /^bytes=(\d*)-(\d*)$/.exec(
                request.headers.range ?? "",
              );
              if (!range) {
                response.setHeader("Content-Length", stats.size);
                response.statusCode = 200;
                send(createReadStream(filePath, chunked));
                return;
              }
              const start = range[1] ? Number(range[1]) : 0;
              const end = range[2]
                ? Math.min(Number(range[2]), stats.size - 1)
                : stats.size - 1;
              if (start >= stats.size || start > end) {
                response.statusCode = 416;
                response.setHeader("Content-Range", `bytes */${stats.size}`);
                response.end();
                return;
              }
              response.statusCode = 206;
              response.setHeader(
                "Content-Range",
                `bytes ${start}-${end}/${stats.size}`,
              );
              response.setHeader("Content-Length", end - start + 1);
              send(createReadStream(filePath, { start, end, ...chunked }));
            })
            .catch(() => {
              response.statusCode = 404;
              response.end();
            });
        },
      );
    },
  };
}

/**
 * Serves the priced-ladder fixture (`src/test/ladderFixture.ts`), with the same
 * `__link/<kbps>/<latencyMs>/` simulated link as the epoch package, so the
 * opening-rung tests run a real player against a real slow or fast server.
 */
function serveLadderFixture(): Plugin {
  return {
    name: "seyirlik-serve-ladder-fixture",
    async configureServer(server) {
      const root = await ensureLadderFixture().catch((error) => {
        console.warn(
          "[seyirlik] the ladder fixture could not be built:",
          error instanceof Error ? error.message : String(error),
        );
        return null;
      });
      server.middlewares.use("/test-ladder", (request, response, next) => {
        if (!root) {
          next();
          return;
        }
        const raw = decodeURIComponent(
          (request.url ?? "").split("?")[0].replace(/^\//, ""),
        );
        const link = /^__link\/(\d+)\/(\d+)\/(.*)$/.exec(raw);
        const filePath = path.resolve(root, link ? link[3]! : raw);
        if (!filePath.startsWith(`${path.resolve(root)}${path.sep}`)) {
          response.statusCode = 403;
          response.end();
          return;
        }
        void stat(filePath)
          .then((stats) => {
            if (!stats.isFile()) throw new Error("not a file");
            response.statusCode = 200;
            response.setHeader(
              "Content-Type",
              filePath.endsWith(".m3u8")
                ? "application/vnd.apple.mpegurl"
                : "video/mp4",
            );
            response.setHeader("Content-Length", stats.size);
            response.setHeader("Cache-Control", "no-store");
            const stream = createReadStream(filePath, {
              highWaterMark: 16 * 1024,
            });
            if (link) {
              paceTo(stream, Number(link[1]) * 1000, Number(link[2]), response);
            } else {
              stream.pipe(response);
            }
          })
          .catch(() => {
            response.statusCode = 404;
            response.end();
          });
      });
    },
  };
}

/**
 * A real mouse, in the page's own coordinates.
 *
 * `userEvent` can click and it can drag from one element to another, but it
 * cannot hold a button down and let the test look at what the page did in the
 * meantime — which is the only interesting moment of a reorder gesture. The
 * test runs inside an iframe, so the frame's own offset is added here rather
 * than left for every caller to remember.
 */
const pointer = defineBrowserCommand<
  [action: "move" | "down" | "up", x?: number, y?: number]
>(async ({ page, iframe, frame }, action, x = 0, y = 0) => {
  if (action === "down") {
    await page.mouse.down();
    return;
  }
  if (action === "up") {
    await page.mouse.up();
    return;
  }
  /*
   * The test page lives in an iframe, and vitest scales that iframe when the
   * viewport asked for is larger than the browser window it has. Both have to
   * be undone here, or the mouse lands somewhere the test never named.
   */
  const box = await iframe.owner().boundingBox();
  const cssWidth = await (await frame()).evaluate(() => window.innerWidth);
  const scale = box && cssWidth ? box.width / cssWidth : 1;
  await page.mouse.move((box?.x ?? 0) + x * scale, (box?.y ?? 0) + y * scale);
});

export default defineConfig({
  plugins: [
    react(),
    serveRenditionFixtures(),
    serveEpochPackage(),
    serveLadderFixture(),
  ],
  test: {
    include: ["src/**/*.browser.test.tsx"],
    // A real browser with a real decoder. jsdom has no video pipeline at all,
    // so nothing about frame readiness or a visible handoff can be observed
    // there — which is the whole reason this suite exists separately.
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      // Chromium covers the Chrome path that originally lost its rendition
      // ladder. WebKit exercises the Safari media/event fallbacks, where the
      // capability probe and hidden-deck frame readiness behave differently.
      instances: [{ browser: "chromium" }, { browser: "webkit" }],
      commands: { pointer },
    },
    // Decoding, seeking and a rendezvous take real wall-clock time.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
