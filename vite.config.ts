/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import { loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { FLAG_COUNTRY_CODES } from "./src/lib/flagCountryCodes";
import {
  BUILD_META_NAME,
  describeBuild,
  parseReleaseNote,
  RELEASE_NOTE_FILE,
  type BuildInfo,
  type ReleaseNote,
} from "./src/lib/appVersion/buildInfo";

// flag-icons ships every flag in the world: ~270 CSS rules pulling ~3.5 MB of
// SVGs, all of which Vite emitted as assets and the PWA precached, for the ~40
// flags Seyirlik can actually show. This keeps only the rules whose country
// code appears in FLAG_COUNTRY_CODES; the rest never become assets at all.
function trimFlagIcons(): Plugin {
  const keptCodes = new Set(FLAG_COUNTRY_CODES);
  // Matches `.fi-xx{...}` and `.fi-xx.fi-squared{...}`, capturing the code.
  const flagRulePattern = /\.fi-([a-z0-9-]+)((?:\.[a-z0-9-]+)*)\{[^}]*\}/g;

  return {
    name: "seyirlik-trim-flag-icons",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("flag-icons") || !id.endsWith(".css")) {
        return null;
      }

      let keptRules = 0;
      let droppedRules = 0;

      const trimmed = code.replace(
        flagRulePattern,
        (rule: string, countryCode: string) => {
          // Only flag rules carry an image. Anything else under the `.fi-`
          // prefix is a shared utility (`.fi-squared` and friends) and has to
          // survive regardless of which flags are kept.
          if (!rule.includes("background-image")) {
            return rule;
          }

          if (keptCodes.has(countryCode)) {
            keptRules += 1;
            return rule;
          }

          droppedRules += 1;
          return "";
        },
      );

      this.info(
        `flag-icons: kept ${keptRules} rules, dropped ${droppedRules}.`,
      );

      return { code: trimmed, map: null };
    },
  };
}

function gitOutput(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // A `git archive` copy or an uploaded deploy has no repository.
    return null;
  }
}

// A missing or unusable note leaves the build without one rather than failing
// it; `deploy/ship.sh` is what insists on a note before a release goes out.
function readReleaseNote(): ReleaseNote | null {
  try {
    return parseReleaseNote(readFileSync(RELEASE_NOTE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function readBuildInfo(): BuildInfo {
  // Named outright when the build runs from a `git archive` copy, which is how
  // www and origin are built; such a copy is the commit, so it is never dirty.
  const namedCommit =
    process.env.SEYIRLIK_BUILD_COMMIT?.trim() ||
    process.env.VERCEL_GIT_COMMIT_SHA?.trim();
  const commit = namedCommit || gitOutput(["rev-parse", "HEAD"]);
  const changes = namedCommit
    ? ""
    : gitOutput(["status", "--porcelain", "--untracked-files=no"]);
  return describeBuild({
    commit: commit || null,
    dirty: Boolean(changes),
    builtAt: new Date(),
    note: readReleaseNote(),
  });
}

// Writes this build's identity beside it as /version.json, and into
// index.html, so a running tab can tell a newer build is live (see
// src/lib/appVersion/appUpdate.ts).
function stampBuild(build: BuildInfo): Plugin {
  return {
    name: "seyirlik-stamp-build",
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: { name: BUILD_META_NAME, content: build.buildId },
          injectTo: "head",
        },
      ];
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: `${JSON.stringify(build, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // `process.env` is not populated from .env on its own, so an upstream set
  // there was silently ignored and the proxy fell back to a loopback port with
  // nothing behind it — which reaches the browser as an unexplained "invalid
  // response" at the login form.
  const environment = { ...process.env, ...loadEnv(mode, process.cwd(), "") };
  const build = readBuildInfo();

  return {
    define: {
      __SEYIRLIK_BUILD__: JSON.stringify(build),
    },
    plugins: [
      trimFlagIcons(),
      stampBuild(build),
      react(),
      VitePWA({
        registerType: "autoUpdate",
        injectRegister: "script-defer",
        scope: "/",
        includeAssets: [
          "favicon-16x16.png",
          "favicon-32x32.png",
          "apple-touch-icon.png",
        ],
        manifest: {
          name: "Seyirlik",
          short_name: "Seyirlik",
          description: "Personal media server interface",
          id: "/",
          start_url: "/",
          scope: "/",
          display: "standalone",
          orientation: "any",
          background_color: "#000000",
          theme_color: "#000000",
          categories: ["entertainment", "video", "media"],
          icons: [
            {
              src: "/pwa-192x192.png",
              sizes: "192x192",
              type: "image/png",
            },
            {
              src: "/pwa-512x512.png",
              sizes: "512x512",
              type: "image/png",
            },
            {
              src: "/maskable-icon-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        workbox: {
          // Script registration needs explicit activation; otherwise updated
          // workers wait indefinitely behind an open streaming tab.
          skipWaiting: true,
          clientsClaim: true,
          globPatterns: [
            "index.html",
            "registerSW.js",
            "assets/**/*.{js,css,svg,png,webp,woff2}",
            // The brand loading mark, shown while anything loads — offline
            // too, where a downloaded title is opened with no server at all.
            "artwork/seyirlik/animations/*.webp",
          ],
          globIgnores: ["**/*.{mp4,mkv,m3u8,ts,vtt,srt,ass}"],
          // The animated mark is just under 2 MB; a larger file than this is
          // left out of the precache silently, so the limit sits above it.
          maximumFileSizeToCacheInBytes: 2.5 * 1024 * 1024,
          navigateFallbackDenylist: [
            // Everything the server owns lives under the versioned namespace, so
            // one rule replaces the per-endpoint list this used to carry.
            /^\/ownAPI\//,
            // A redirect Vercel answers (vercel.json), not an app route: served
            // from the precache it would open the app's not-found page instead.
            /^\/control\/?$/,
            /\.(?:m3u8|ts|mp4|mkv|webm|vtt|srt|ass)$/i,
          ],
          runtimeCaching: [],
          // Offline playback of downloaded titles; see public/offline-sw.js.
          importScripts: ["offline-sw.js", "alerts-sw.js"],
        },
      }),
    ],
    resolve: {
      alias: {
        "@": new URL("./src", import.meta.url).pathname,
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/setupTests.ts"],
      globals: true,
      // The dual-deck handoff suite needs a real decoder and runs under
      // `vitest.browser.config.ts` (`npm run test:browser`). jsdom would load
      // it and hang waiting for video that never plays.
      // `.claude/**` holds nested worktrees and QA harnesses; a path filter
      // would otherwise collect the repository twice.
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/*.browser.test.tsx",
        ".claude/**",
      ],
      /*
       * Bounded on purpose, and this is not a performance setting.
       *
       * The packaging suites encode for real, and on macOS an `auto` encoder
       * resolves to VideoToolbox — of which the machine has a small, fixed
       * number of simultaneous sessions. Run one worker per core and the
       * seventh concurrent encode fails to open a session at all:
       *
       *   [h264_videotoolbox] Error retrieving the supported property
       *   dictionary err=-12903
       *   [out#0/hls] Nothing was written into output file
       *
       * which surfaces as a different integration test failing on every run,
       * for a reason that has nothing to do with what it asserts. Capping the
       * workers keeps the number of concurrent encoders inside what the
       * hardware will grant, which is what makes a full run reproducible
       * instead of a lottery.
       *
       * It belongs here rather than in a flag an operator has to remember: a
       * suite that only passes when invoked a particular way is a suite people
       * learn to disbelieve. The cost is roughly a minute on a full run.
       *
       * Tests that do not care which encoder they use should pin a software
       * one (see `scratchUnmount.integration.test.ts`); they then cost nothing
       * from this budget. Tests that exercise VideoToolbox deliberately keep
       * `auto` and are covered by the cap.
       */
      maxWorkers: 3,
      minWorkers: 1,
    },
    server: {
      proxy: {
        "/ownAPI": {
          target:
            environment.SEYIRLIK_OWN_API_UPSTREAM?.trim() ||
            "http://127.0.0.1:43110",
          // The upstream must see the browser's own Origin: it validates it, and
          // rewriting it here would make every dev origin look like the API's.
          changeOrigin: false,
        },
      },
    },
    build: {
      chunkSizeWarningLimit: 800,
      rollupOptions: {
        output: {
          manualChunks: {
            hls: ["hls.js"],
          },
        },
      },
    },
  };
});
