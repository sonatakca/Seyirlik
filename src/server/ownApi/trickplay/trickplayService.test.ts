import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CatalogueRepository,
  MediaFileRow,
  MediaStreamRow,
} from "../catalogue/catalogueRepository";
import type { DatabasePool } from "../database/databasePool";
import { buildTrickplayLayout } from "./trickplayLayout";
import { planTrickplaySegments } from "./trickplaySegments";
import {
  buildTrickplayFilterGraph,
  createTrickplayService,
  frameIndexFromAnnouncement,
  isGeneratedMediaPath,
  TrickplayUnsupportedError,
} from "./trickplayService";
import { TrickplayValidationError } from "./trickplayValidation";
import {
  outputDirectoryFromArgs,
  writeTrickplaySheets,
} from "./trickplayTestFixtures";

/**
 * Every temporary tree a test made, removed once it is done with it.
 *
 * Shared rather than per-suite because these tests write real files into a real
 * media root; leaving one behind is a slow leak on a machine that runs the
 * suite all day.
 */
const temporaryRoots: string[] = [];
afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop() as string;
    await rm(root, { recursive: true, force: true });
  }
});

const LAYOUT = buildTrickplayLayout({
  durationMs: 3_600_000,
  sourceWidth: 3840,
  sourceHeight: 2160,
});

function videoStream(overrides: Partial<MediaStreamRow> = {}): MediaStreamRow {
  return {
    streamIndex: 0,
    kind: "video",
    codec: "hevc",
    profile: null,
    level: null,
    language: null,
    title: null,
    isDefault: true,
    isForced: false,
    isExternal: false,
    isTextSubtitle: false,
    externalRelativePath: null,
    channels: null,
    sampleRate: null,
    bitrateBps: null,
    width: 3840,
    height: 2160,
    pixelFormat: "yuv420p",
    frameRate: 24,
    videoRange: "SDR",
    colorTransfer: "bt709",
    colorPrimaries: "bt709",
    colorSpace: "bt709",
    bitDepth: 8,
    ...overrides,
  };
}

const SDR = { colorTransfer: "bt709", colorPrimaries: "bt709" };
const HDR10 = { colorTransfer: "smpte2084", colorPrimaries: "bt2020" };
const HLG = { colorTransfer: "arib-std-b67", colorPrimaries: "bt2020" };

describe("choosing a colour conversion from what the probe recorded", () => {
  it("adds no colour filter to an ordinary BT.709 source", () => {
    const graph = buildTrickplayFilterGraph(LAYOUT, SDR);

    expect(graph).not.toContain("tonemap");
    expect(graph).not.toContain("zscale");
    expect(graph).not.toContain("bt2020");
  });

  it("tone maps a PQ master, and only once", () => {
    const graph = buildTrickplayFilterGraph(LAYOUT, HDR10);

    expect(graph).toContain("zscale=t=linear:npl=100");
    expect(graph).toContain("tonemap=tonemap=hable:desat=0");
    expect(graph).toContain("zscale=t=bt709:m=bt709:r=tv");
    expect(graph.match(/tonemap=tonemap/g)).toHaveLength(1);
  });

  it("tone maps an HLG master the same way", () => {
    expect(buildTrickplayFilterGraph(LAYOUT, HLG)).toContain(
      "tonemap=tonemap=hable:desat=0",
    );
  });

  /*
   * BT.2020 primaries with a conventional curve is a gamut problem, not a
   * dynamic-range one. Tone mapping it would flatten a picture that has
   * nothing to flatten; ignoring the gamut leaves it oversaturated.
   */
  it("converts a wide-gamut SDR source without tone mapping it", () => {
    const graph = buildTrickplayFilterGraph(LAYOUT, {
      colorTransfer: "bt709",
      colorPrimaries: "bt2020",
    });

    expect(graph).toContain("zscale=p=bt709:m=bt709:r=tv");
    expect(graph).not.toContain("tonemap");
  });

  it("treats an unknown transfer as SDR rather than guessing at HDR", () => {
    expect(
      buildTrickplayFilterGraph(LAYOUT, {
        colorTransfer: null,
        colorPrimaries: null,
      }),
    ).not.toContain("tonemap");
  });
});

describe("fitting frames into a tile", () => {
  it("never stretches: it fits by the longer side and pads the rest", () => {
    const graph = buildTrickplayFilterGraph(LAYOUT, SDR);

    expect(graph).toContain(
      `scale=${LAYOUT.tileWidth}:${LAYOUT.tileHeight}:force_original_aspect_ratio=decrease`,
    );
    expect(graph).toContain(
      `pad=${LAYOUT.tileWidth}:${LAYOUT.tileHeight}:(ow-iw)/2:(oh-ih)/2`,
    );
  });

  it("squares non-square pixels before fitting, so anamorphic sources are not squashed", () => {
    const graph = buildTrickplayFilterGraph(LAYOUT, SDR);
    const squarePixels = graph.indexOf("scale=iw*sar:ih");
    const fit = graph.indexOf("force_original_aspect_ratio");

    expect(squarePixels).toBeGreaterThanOrEqual(0);
    expect(graph).toContain("setsar=1");
    expect(squarePixels).toBeLessThan(fit);
  });

  it("samples and tiles in one pass, with a deterministic output format", () => {
    const graph = buildTrickplayFilterGraph(LAYOUT, SDR);

    expect(graph.startsWith(`fps=1/${LAYOUT.intervalMs / 1_000}`)).toBe(true);
    expect(graph.endsWith(`tile=${LAYOUT.columns}x${LAYOUT.rows}`)).toBe(true);
    expect(graph).toContain("format=yuvj420p");
  });
});

describe("recognising something Seyirlik generated", () => {
  it("names every rendition, package and content directory", () => {
    for (const generated of [
      "Movies/Dune (2021)/video/1080p60.mp4",
      "Movies/Dune (2021)/audio/english.m4a",
      "Movies/Dune (2021)/subtitle/english.vtt",
      "Movies/Dune (2021)/content/backdrop.jpg",
      "Movies/Dune (2021)/.seyirlik/master.m3u8",
    ]) {
      expect(isGeneratedMediaPath(generated)).toBe(true);
    }
  });

  it("leaves an original alone, in its bucket or beside its folder", () => {
    for (const original of [
      "Movies/Dune (2021)/src/Dune (2021).mkv",
      "Movies/Dune (2021)/Dune (2021).mkv",
      "Series/Andor/Season 1/src/Andor - S01E01 - Kassa.mkv",
    ]) {
      expect(isGeneratedMediaPath(original)).toBe(false);
    }
  });
});

/**
 * Generation, publication and deletion against a real filesystem.
 *
 * A fake FFmpeg that writes nothing would no longer prove anything: the whole
 * point of the redesign is that the bytes are read back before a row is
 * written, so the fake writes sheets and the tests can then take them away, cut
 * them short, or make it fail.
 */
describe("reading the frame FFmpeg has reached out of its own log", () => {
  const line = (index: number) =>
    `[Parsed_showinfo_6 @ 0xab6c0e580] n: ${index.toString().padStart(3, " ")} ` +
    "pts:    118 pts_time:1180    duration:      1 duration_time:10      " +
    "fmt:yuvj420p sar:1/1 s:320x180 i:P iskey:0 type:B checksum:71E008E8";

  it("takes the sampler's own count and nothing else from the line", () => {
    expect(frameIndexFromAnnouncement(line(0))).toBe(0);
    expect(frameIndexFromAnnouncement(line(118))).toBe(118);
  });

  /*
   * Everything else FFmpeg writes at info level goes past this function — the
   * stream summary, the muxer's own remarks, the source path among them. A
   * line that is not an announcement must not become a number.
   */
  it("declines every other line the log carries", () => {
    for (const other of [
      "",
      "  ",
      "Input #0, matroska,webm, from '/Volumes/Media/Shows/Arcane/S01E08.mkv':",
      "[Parsed_scale_3 @ 0x600002] w:3840 h:2160",
      "[Parsed_showinfo_6 @ 0x600002] config in time_base: 10/1, frame_rate: 1/10",
      "n: 4",
    ]) {
      expect(frameIndexFromAnnouncement(other)).toBeNull();
    }
  });
});

describe("generating a set into the title's own folder", () => {
  let mediaRoot: string;
  let generatedStorage: string;
  let calls: string[][];
  let file: MediaFileRow | null;
  let streams: MediaStreamRow[];
  let itemKind: string;
  let rows: RawRow[];
  let deleted: string[];

  interface RawRow {
    id: string;
    media_file_id: string;
    tile_width: number;
    tile_height: number;
    columns: number;
    rows: number;
    interval_ms: number;
    thumbnail_count: number;
    sprite_count: number;
    storage_prefix: string | null;
    content_type: string;
  }

  const MOVIE_SOURCE: MediaFileRow = {
    id: "11111111-1111-4111-8111-111111111111",
    itemId: "22222222-2222-4222-8222-222222222222",
    relativePath: "Movies/Dune (2021)/src/Dune (2021).mkv",
    container: "mkv",
    sizeBytes: "1",
    mtimeMs: "1",
    fingerprint: "f",
    durationMs: "3600000",
    bitrateBps: null,
    isPrimary: true,
    probeState: "probed",
    missingSince: null,
  };

  const EPISODE_SOURCE: MediaFileRow = {
    ...MOVIE_SOURCE,
    relativePath: "Series/Andor/Season 1/src/Andor - S01E01 - Kassa.mkv",
  };

  const movieTitleRoot = () => path.join(mediaRoot, "Movies", "Dune (2021)");
  const movieTrickplay = () => path.join(movieTitleRoot(), "trickplay");

  const SHEET_WIDTH = LAYOUT.columns * LAYOUT.tileWidth;
  const SHEET_HEIGHT = LAYOUT.rows * LAYOUT.tileHeight;

  interface ServiceOptions {
    hasFilter?: (name: string) => Promise<boolean>;
    /** What the fake FFmpeg does with the staging directory it is given. */
    write?: (outputDirectory: string) => Promise<void>;
    /** Makes the row write fail, to exercise rollback. */
    failInsert?: boolean;
    /**
     * Zero-based frame indices the fake FFmpeg announces as it "decodes",
     * standing in for the `showinfo` lines a real one writes to its log.
     *
     * One list per planned segment, in segment order. Each segment counts its
     * own frames from zero, exactly as a real sampler seeked into the middle of
     * a file does, so this is also what proves the service adds them up rather
     * than reporting whichever one spoke last.
     */
    announce?: number[][];
    findPackagedVideo?: Parameters<
      typeof createTrickplayService
    >[0]["findPackagedVideo"];
    /** Probe this binary's filters for real instead of injecting the answer. */
    probeFiltersOf?: string;
  }

  function service(options: ServiceOptions = {}) {
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        if (text.trimStart().startsWith("SELECT")) {
          const matching = rows.filter(
            (row) => row.media_file_id === (values?.[0] ?? file?.id),
          );
          return { rows: matching, rowCount: matching.length };
        }
        if (text.trimStart().startsWith("DELETE")) {
          deleted.push(String(values?.[0]));
          rows = rows.filter((row) => row.id !== values?.[0]);
          return { rows: [], rowCount: 1 };
        }
        if (options.failInsert) throw new Error("the row could not be written");
        const [
          id,
          mediaFileId,
          tileWidth,
          tileHeight,
          columns,
          sheetRows,
          intervalMs,
          thumbnailCount,
          spriteCount,
        ] = values as [
          string,
          string,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
        ];
        const row: RawRow = {
          id,
          media_file_id: mediaFileId,
          tile_width: tileWidth,
          tile_height: tileHeight,
          columns,
          rows: sheetRows,
          interval_ms: intervalMs,
          thumbnail_count: thumbnailCount,
          sprite_count: spriteCount,
          storage_prefix: null,
          content_type: "image/jpeg",
        };
        rows = [
          ...rows.filter((existing) => existing.media_file_id !== mediaFileId),
          row,
        ];
        return { rows: [row], rowCount: 1 };
      },
    } as unknown as DatabasePool;

    const catalogue = {
      getPrimaryFile: async () => file,
      getFileById: async () => file,
      getItemKind: async () => itemKind,
      listStreams: async () => streams,
    } as unknown as CatalogueRepository;

    return createTrickplayService({
      pool,
      catalogue,
      mediaRoot,
      generatedStoragePath: generatedStorage,
      runFfmpeg: async (args, onFrame) => {
        calls.push(args);
        if (options.announce) {
          // Which segment this call is, found by the sheet it starts numbering
          // at rather than by call order.
          const startNumber = Number(args[args.indexOf("-start_number") + 1]);
          const ordinal = planTrickplaySegments(LAYOUT).findIndex(
            (segment) => segment.firstSpriteIndex === startNumber,
          );
          for (const index of options.announce[ordinal] ?? []) onFrame?.(index);
        }
        const outputDirectory = outputDirectoryFromArgs(args);
        if (options.write) {
          await options.write(outputDirectory);
          return;
        }
        await writeTrickplaySheets({
          directory: outputDirectory,
          count: LAYOUT.spriteCount,
          width: SHEET_WIDTH,
          height: SHEET_HEIGHT,
        });
      },
      // Every filter present unless a test says otherwise, so no process is
      // spawned to find out.
      ...(options.probeFiltersOf
        ? { ffmpegPath: options.probeFiltersOf }
        : { hasFilter: options.hasFilter ?? (async () => true) }),
      ...(options.findPackagedVideo
        ? { findPackagedVideo: options.findPackagedVideo }
        : {}),
    });
  }

  beforeEach(async () => {
    const base = await mkdtemp(path.join(tmpdir(), "trickplay-"));
    mediaRoot = path.join(base, "media");
    generatedStorage = path.join(base, "generated");
    await mkdir(path.join(mediaRoot, "Movies", "Dune (2021)", "src"), {
      recursive: true,
    });
    await mkdir(path.join(mediaRoot, "Series", "Andor", "Season 1", "src"), {
      recursive: true,
    });
    await mkdir(generatedStorage, { recursive: true });
    calls = [];
    rows = [];
    deleted = [];
    file = MOVIE_SOURCE;
    itemKind = "movie";
    streams = [videoStream()];
    temporaryRoots.push(base);
  });

  it("decodes the original source file, named as an argument and never a shell string", async () => {
    await service().generateForItem(MOVIE_SOURCE.itemId);

    const args = calls[0] as string[];
    expect(args[args.indexOf("-i") + 1]).toBe(
      path.resolve(mediaRoot, "Movies/Dune (2021)/src/Dune (2021).mkv"),
    );
    expect(args.some((arg) => arg.includes("|") || arg.includes(";"))).toBe(
      false,
    );
  });

  describe("a title whose source packaging consumed", () => {
    const PACKAGED: MediaFileRow = {
      ...MOVIE_SOURCE,
      probeState: "packaged",
      durationMs: null,
    };
    const rendition = () =>
      path.join(movieTitleRoot(), "video", "2160p", "media.mp4");
    const renditionPlaylist = () =>
      path.join(movieTitleRoot(), ".seyirlik", "video", "2160p.m3u8");
    const packagedVideo = async () => ({
      path: rendition(),
      playlistPath: renditionPlaylist(),
      width: 3840,
      height: 2160,
      durationSeconds: 3_600,
      colorTransfer: "smpte2084",
      colorPrimaries: "bt2020",
    });

    it("samples the package's best rendition through its playlist, colour-corrected by its own transfer", async () => {
      file = PACKAGED;
      streams = [];
      const set = await service({
        findPackagedVideo: packagedVideo,
      }).generateForItem(PACKAGED.itemId);

      expect(set?.spriteCount).toBe(LAYOUT.spriteCount);
      const args = calls[0] as string[];
      // The playlist, not the MP4: its byte ranges are the fragment index
      // the MP4 demuxer would otherwise rebuild with a seek per fragment.
      expect(args[args.indexOf("-i") + 1]).toBe(renditionPlaylist());
      expect(args[args.indexOf("-map") + 1]).toBe("0:v:0");
      expect(args[args.indexOf("-vf") + 1]).toContain("tonemap");
      expect(rows).toHaveLength(1);
    });

    it("keeps sampling the source while it is still on disk", async () => {
      await writeFile(
        path.resolve(mediaRoot, MOVIE_SOURCE.relativePath),
        "source",
      );
      await service({ findPackagedVideo: packagedVideo }).generateForItem(
        MOVIE_SOURCE.itemId,
      );

      const args = calls[0] as string[];
      expect(args[args.indexOf("-i") + 1]).toBe(
        path.resolve(mediaRoot, MOVIE_SOURCE.relativePath),
      );
    });

    it("has nothing to sample when there is no package either", async () => {
      file = PACKAGED;
      expect(
        await service({
          findPackagedVideo: async () => null,
        }).generateForItem(PACKAGED.itemId),
      ).toBeNull();
      expect(calls).toEqual([]);
    });
  });

  it("maps the very stream whose colours and size the layout came from", async () => {
    streams = [videoStream({ streamIndex: 3, width: 3840, height: 2160 })];

    await service().generateForItem(MOVIE_SOURCE.itemId);

    const args = calls[0] as string[];
    expect(args[args.indexOf("-map") + 1]).toBe("0:3");
  });

  it("numbers sheets from zero, the way every reader of them counts", async () => {
    await service().generateForItem(MOVIE_SOURCE.itemId);

    const args = calls[0] as string[];
    expect(args[args.indexOf("-start_number") + 1]).toBe("0");
  });

  /*
   * The heart of the redesign. A movie's sheets belong beside its `video/` and
   * `audio/`, not in a central tree keyed by an id nobody can read.
   */
  it("publishes a movie's sheets into <titleRoot>/trickplay", async () => {
    const set = await service().generateForItem(MOVIE_SOURCE.itemId);

    expect(set).not.toBeNull();
    expect(await readdir(movieTrickplay())).toContain("sprite_0.jpg");
    expect(await readdir(movieTrickplay())).toHaveLength(LAYOUT.spriteCount);
  });

  it("publishes an episode's sheets into its own nested title folder", async () => {
    file = EPISODE_SOURCE;
    itemKind = "episode";

    await service().generateForItem(EPISODE_SOURCE.itemId);

    const episodeRoot = path.join(
      mediaRoot,
      "Series/Andor/Season 1/Andor - S01E01 - Kassa",
    );
    expect(await readdir(path.join(episodeRoot, "trickplay"))).toContain(
      "sprite_0.jpg",
    );
    // Never the season folder, which eleven other episodes share.
    await expect(
      readdir(path.join(mediaRoot, "Series/Andor/Season 1/trickplay")),
    ).rejects.toThrow();
  });

  /*
   * The old layout is gone, not merely deprecated: a run that still created a
   * UUID directory would leave the migration with a moving target.
   */
  it("writes nothing at all into the old central storage tree", async () => {
    await service().generateForItem(MOVIE_SOURCE.itemId);

    expect(
      await readdir(path.join(generatedStorage, "trickplay")).catch(() => []),
    ).toEqual([]);
  });

  it("records no storage prefix, because there is no longer an address to record", async () => {
    const set = await service().generateForItem(MOVIE_SOURCE.itemId);

    expect(set?.storagePrefix).toBeNull();
  });

  it("stages into a hidden sibling and leaves none of it behind", async () => {
    let stagedInto = "";
    await service({
      write: async (directory) => {
        stagedInto = directory;
        await writeTrickplaySheets({
          directory,
          count: LAYOUT.spriteCount,
          width: SHEET_WIDTH,
          height: SHEET_HEIGHT,
        });
      },
    }).generateForItem(MOVIE_SOURCE.itemId);

    expect(path.basename(stagedInto).startsWith(".trickplay-publish-")).toBe(
      true,
    );
    expect(path.dirname(stagedInto)).toBe(movieTitleRoot());
    const remaining = await readdir(movieTitleRoot());
    expect(remaining.filter((name) => name.includes("publish"))).toEqual([]);
  });

  it("writes a row that describes the sheets actually on disk", async () => {
    const set = await service().generateForItem(MOVIE_SOURCE.itemId);

    const onDisk = (await readdir(movieTrickplay())).length;
    expect(set?.spriteCount).toBe(onDisk);
    expect(set?.tileWidth).toBe(LAYOUT.tileWidth);
    expect(set?.tileHeight).toBe(LAYOUT.tileHeight);
    expect(set?.intervalMs).toBe(LAYOUT.intervalMs);
  });

  it("carries the source's own colour decision into the filter graph", async () => {
    streams = [videoStream({ ...HDR10, bitDepth: 10 })];
    await service().generateForItem(MOVIE_SOURCE.itemId);
    const hdrArgs = calls[0] as string[];
    expect(hdrArgs[hdrArgs.indexOf("-vf") + 1]).toContain("tonemap");

    calls = [];
    rows = [];
    streams = [videoStream()];
    await service().generateForItem(MOVIE_SOURCE.itemId);
    const sdrArgs = calls[0] as string[];
    expect(sdrArgs[sdrArgs.indexOf("-vf") + 1]).not.toContain("tonemap");
  });

  it("refuses a source that is itself a generated rendition", async () => {
    file = {
      ...MOVIE_SOURCE,
      relativePath: "Movies/Dune (2021)/video/1080p60.mp4",
    };

    expect(await service().generateForItem(MOVIE_SOURCE.itemId)).toBeNull();
    expect(calls).toEqual([]);
  });

  /*
   * The managed directory is now itself a generated one, so a row that somehow
   * pointed at a sheet must never be sampled as though it were a source.
   */
  it("refuses a source that lives inside a trickplay directory", async () => {
    file = {
      ...MOVIE_SOURCE,
      relativePath: "Movies/Dune (2021)/trickplay/sprite_0.jpg",
    };

    expect(await service().generateForItem(MOVIE_SOURCE.itemId)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("refuses a file the probe has not reached", async () => {
    file = { ...MOVIE_SOURCE, probeState: "pending" };

    expect(await service().generateForItem(MOVIE_SOURCE.itemId)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("leaves an existing set alone rather than decoding the file again", async () => {
    await service().generateForItem(MOVIE_SOURCE.itemId);
    calls = [];

    await service().generateForItem(MOVIE_SOURCE.itemId);

    expect(calls).toEqual([]);
  });

  it("refuses an HDR title up front when the colour filter is missing", async () => {
    streams = [
      videoStream({ colorTransfer: "smpte2084", colorPrimaries: "bt2020" }),
    ];
    const withoutZscale = service({
      hasFilter: async (name) => name !== "zscale",
    });

    await expect(
      withoutZscale.generateForItem(MOVIE_SOURCE.itemId),
    ).rejects.toThrow(TrickplayUnsupportedError);
    // Nothing spawned, nothing written: the check happens before both.
    expect(calls).toEqual([]);
    expect(await readdir(movieTitleRoot())).toEqual(["src"]);
  });

  it("does not call an FFmpeg it cannot start an HDR limitation", async () => {
    streams = [videoStream(HDR10)];
    const pending = service({
      probeFiltersOf: path.join(mediaRoot, "no-such-ffmpeg"),
    }).generateForItem(MOVIE_SOURCE.itemId);

    await expect(pending).rejects.toThrow("FFmpeg could not be started.");
    await expect(pending).rejects.not.toBeInstanceOf(TrickplayUnsupportedError);
    expect(calls).toEqual([]);
  });

  it("says what to do, and names no file", async () => {
    streams = [
      videoStream({ colorTransfer: "arib-std-b67", colorPrimaries: "bt2020" }),
    ];
    await service({ hasFilter: async () => false })
      .generateForItem(MOVIE_SOURCE.itemId)
      .catch((error: unknown) => {
        const message = (error as Error).message;
        expect(message).toContain("zscale");
        expect(message).toContain("libzimg");
        expect(message).not.toContain("/");
      });
  });

  it("still generates an SDR title on the same FFmpeg", async () => {
    // The 209 SDR titles must not be held back by the 65 HDR ones.
    streams = [videoStream()];
    const withoutZscale = service({
      hasFilter: async (name) => name !== "zscale",
    });

    expect(
      await withoutZscale.generateForItem(MOVIE_SOURCE.itemId),
    ).not.toBeNull();
    expect(calls).toHaveLength(planTrickplaySegments(LAYOUT).length);
  });

  /*
   * A trickplay pass used to be the one job on the page that could say nothing
   * at all about itself. FFmpeg reports against what it has *written*, and the
   * tiler holds a hundred frames before it writes a sheet — so a run over a
   * television episode stayed silent until it was two thirds done. The sampler
   * is asked to name each frame instead, which is a thing it does once per
   * sampling interval from the first second onwards.
   */
  it("reports the frame the sampler has reached, against the layout's own count", async () => {
    const seen: Array<{ completed: number; total: number }> = [];

    await service({ announce: [[0, 1, 2]] }).generateForItem(
      MOVIE_SOURCE.itemId,
      { onProgress: (progress) => seen.push(progress) },
    );

    // Announced zero-based; a frame the sampler has named is one it has done.
    expect(seen).toEqual([
      { completed: 1, total: LAYOUT.thumbnailCount },
      { completed: 2, total: LAYOUT.thumbnailCount },
      { completed: 3, total: LAYOUT.thumbnailCount },
    ]);
  });

  /*
   * Every segment counts its own frames from zero, so the only figure that
   * means anything to somebody watching a progress bar is their sum. Reporting
   * one segment's counter would make the bar jump backwards each time a
   * different segment spoke.
   */
  it("adds up what every segment has sampled rather than reporting one", async () => {
    const seen: Array<{ completed: number; total: number }> = [];
    const segments = planTrickplaySegments(LAYOUT);
    expect(segments.length).toBeGreaterThan(1);

    await service({ announce: [[0, 1], [0], [0, 1, 2]] }).generateForItem(
      MOVIE_SOURCE.itemId,
      { onProgress: (progress) => seen.push(progress) },
    );

    expect(seen.map((progress) => progress.completed)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(seen.at(-1)?.total).toBe(LAYOUT.thumbnailCount);
  });

  it("asks FFmpeg to name its frames only when somebody is listening", async () => {
    await service().generateForItem(MOVIE_SOURCE.itemId);
    const silent = calls[0] as string[];

    expect(silent[silent.indexOf("-loglevel") + 1]).toBe("error");
    expect(silent[silent.indexOf("-vf") + 1]).not.toContain("showinfo");

    calls.length = 0;
    await service().generateForItem(MOVIE_SOURCE.itemId, {
      force: true,
      onProgress: () => undefined,
    });
    const watched = calls[0] as string[];

    // `showinfo` speaks at info level and would be swallowed at error level.
    expect(watched[watched.indexOf("-loglevel") + 1]).toBe("info");
    expect(watched).toContain("-nostats");
    // After the scale, so it hashes a tile rather than a full-sized frame, and
    // before the tiler, which is the thing that hides the frames.
    expect(watched[watched.indexOf("-vf") + 1]).toMatch(
      /,showinfo,tile=\d+x\d+$/,
    );
  });
});

/**
 * The invariant the staged publication exists for.
 *
 * A title that has sheets keeps them through every way a rebuild can fail. The
 * previous implementation deleted first and generated second, so each of these
 * cases used to end with a title that had nothing.
 */
describe("failure never costs a title the sheets it already had", () => {
  let mediaRoot: string;
  let generatedStorage: string;
  let rows: Array<Record<string, unknown>>;
  let file: MediaFileRow;
  let streams: MediaStreamRow[];

  const SOURCE: MediaFileRow = {
    id: "11111111-1111-4111-8111-111111111111",
    itemId: "22222222-2222-4222-8222-222222222222",
    relativePath: "Movies/Dune (2021)/src/Dune (2021).mkv",
    container: "mkv",
    sizeBytes: "1",
    mtimeMs: "1",
    fingerprint: "f",
    durationMs: "3600000",
    bitrateBps: null,
    isPrimary: true,
    probeState: "probed",
    missingSince: null,
  };

  const SHEET_WIDTH = LAYOUT.columns * LAYOUT.tileWidth;
  const SHEET_HEIGHT = LAYOUT.rows * LAYOUT.tileHeight;
  const titleRoot = () => path.join(mediaRoot, "Movies", "Dune (2021)");
  const live = () => path.join(titleRoot(), "trickplay");

  function service(options: {
    write?: (directory: string) => Promise<void>;
    failInsert?: boolean;
  }) {
    const pool = {
      query: async (text: string) => {
        if (text.trimStart().startsWith("SELECT")) {
          return { rows, rowCount: rows.length };
        }
        if (options.failInsert) throw new Error("the row could not be written");
        return {
          rows: [
            {
              ...(rows[0] ?? {}),
              id: "55555555-5555-4555-8555-555555555555",
              media_file_id: SOURCE.id,
              storage_prefix: null,
            },
          ],
          rowCount: 1,
        };
      },
    } as unknown as DatabasePool;

    const catalogue = {
      getPrimaryFile: async () => file,
      getFileById: async () => file,
      getItemKind: async () => "movie",
      listStreams: async () => streams,
    } as unknown as CatalogueRepository;

    return createTrickplayService({
      pool,
      catalogue,
      mediaRoot,
      generatedStoragePath: generatedStorage,
      runFfmpeg: async (args) => {
        const directory = outputDirectoryFromArgs(args);
        if (options.write) {
          await options.write(directory);
          return;
        }
        await writeTrickplaySheets({
          directory,
          count: LAYOUT.spriteCount,
          width: SHEET_WIDTH,
          height: SHEET_HEIGHT,
        });
      },
      hasFilter: async () => true,
    });
  }

  /** The bytes of the live set, so "unchanged" can mean byte-for-byte. */
  async function liveFingerprint(): Promise<string[]> {
    const names = (await readdir(live()).catch(() => [])).sort();
    const digests: string[] = [];
    for (const name of names) {
      const bytes = await readFile(path.join(live(), name));
      digests.push(
        `${name}:${createHash("sha256").update(bytes).digest("hex")}`,
      );
    }
    return digests;
  }

  beforeEach(async () => {
    const base = await mkdtemp(path.join(tmpdir(), "trickplay-regen-"));
    temporaryRoots.push(base);
    mediaRoot = path.join(base, "media");
    generatedStorage = path.join(base, "generated");
    await mkdir(path.join(mediaRoot, "Movies", "Dune (2021)", "src"), {
      recursive: true,
    });
    file = SOURCE;
    streams = [videoStream()];
    rows = [
      {
        id: "44444444-4444-4444-8444-444444444444",
        media_file_id: SOURCE.id,
        tile_width: LAYOUT.tileWidth,
        tile_height: LAYOUT.tileHeight,
        columns: LAYOUT.columns,
        rows: LAYOUT.rows,
        interval_ms: LAYOUT.intervalMs,
        thumbnail_count: LAYOUT.thumbnailCount,
        sprite_count: LAYOUT.spriteCount,
        storage_prefix: null,
        content_type: "image/jpeg",
      },
    ];
    // The set the title already has, including one sheet more than a shorter
    // replacement would produce, so a stale leftover would be visible.
    await writeTrickplaySheets({
      directory: live(),
      count: LAYOUT.spriteCount,
      width: SHEET_WIDTH,
      height: SHEET_HEIGHT,
    });
  });

  it("leaves the previous sheets byte-identical when FFmpeg fails", async () => {
    const before = await liveFingerprint();

    await expect(
      service({
        write: async () => {
          throw new Error("Trickplay generation failed.");
        },
      }).generateForItem(SOURCE.itemId, { force: true }),
    ).rejects.toThrow("Trickplay generation failed.");

    expect(await liveFingerprint()).toEqual(before);
    expect(
      (await readdir(titleRoot())).filter((name) => name.includes("publish")),
    ).toEqual([]);
  });

  it("leaves the previous sheets in place when the new ones do not validate", async () => {
    const before = await liveFingerprint();

    await expect(
      service({
        // Exits zero having written a truncated set: one empty file.
        write: async (directory) => {
          await mkdir(directory, { recursive: true });
          await writeFile(
            path.join(directory, "sprite_0.jpg"),
            Buffer.alloc(0),
          );
        },
      }).generateForItem(SOURCE.itemId, { force: true }),
    ).rejects.toThrow(TrickplayValidationError);

    expect(await liveFingerprint()).toEqual(before);
  });

  it("puts the previous sheets back when the row cannot be written", async () => {
    const before = await liveFingerprint();

    await expect(
      service({ failInsert: true }).generateForItem(SOURCE.itemId, {
        force: true,
      }),
    ).rejects.toThrow("the row could not be written");

    expect(await liveFingerprint()).toEqual(before);
  });

  /*
   * The other half of the invariant: when it works, it really does replace. A
   * shorter replacement must not leave the tail of the old set behind, because
   * the row would then under-report sheets that the folder still holds.
   */
  it("replaces the set completely on success, leaving no stale sheets", async () => {
    await service({
      write: async (directory) => {
        await writeTrickplaySheets({
          directory,
          count: 2,
          width: SHEET_WIDTH,
          height: SHEET_HEIGHT,
        });
      },
    }).generateForItem(SOURCE.itemId, { force: true });

    expect((await readdir(live())).sort()).toEqual([
      "sprite_0.jpg",
      "sprite_1.jpg",
    ]);
    expect(
      (await readdir(titleRoot())).filter(
        (name) => name.includes("publish") || name.includes("retired"),
      ),
    ).toEqual([]);
  });
});

/**
 * The old external folders have no authority over anything.
 *
 * A library full of `<title>.trickplay` must not look, to this server, like a
 * library that already has trickplay. Only two things together mean that: a row
 * in `trickplay_sets`, and the managed directory the row's file resolves to.
 */
describe("legacy *.trickplay never counts as generated trickplay", () => {
  let mediaRoot: string;
  let generatedStorage: string;
  let rows: Array<Record<string, unknown>>;
  let calls: string[][];

  const SOURCE: MediaFileRow = {
    id: "11111111-1111-4111-8111-111111111111",
    itemId: "22222222-2222-4222-8222-222222222222",
    relativePath: "Movies/Dune (2021)/src/Dune (2021).mkv",
    container: "mkv",
    sizeBytes: "1",
    mtimeMs: "1",
    fingerprint: "f",
    durationMs: "3600000",
    bitrateBps: null,
    isPrimary: true,
    probeState: "probed",
    missingSince: null,
  };

  const titleRoot = () => path.join(mediaRoot, "Movies", "Dune (2021)");

  function service() {
    const pool = {
      query: async (text: string) => {
        if (text.trimStart().startsWith("SELECT")) {
          return { rows, rowCount: rows.length };
        }
        return {
          rows: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              media_file_id: SOURCE.id,
              tile_width: LAYOUT.tileWidth,
              tile_height: LAYOUT.tileHeight,
              columns: LAYOUT.columns,
              rows: LAYOUT.rows,
              interval_ms: LAYOUT.intervalMs,
              thumbnail_count: LAYOUT.thumbnailCount,
              sprite_count: LAYOUT.spriteCount,
              storage_prefix: null,
              content_type: "image/jpeg",
            },
          ],
          rowCount: 1,
        };
      },
    } as unknown as DatabasePool;
    const catalogue = {
      getPrimaryFile: async () => SOURCE,
      getFileById: async () => SOURCE,
      getItemKind: async () => "movie",
      listStreams: async () => [videoStream()],
    } as unknown as CatalogueRepository;
    return createTrickplayService({
      pool,
      catalogue,
      mediaRoot,
      generatedStoragePath: generatedStorage,
      runFfmpeg: async (args) => {
        calls.push(args);
        await writeTrickplaySheets({
          directory: outputDirectoryFromArgs(args),
          count: LAYOUT.spriteCount,
          width: LAYOUT.columns * LAYOUT.tileWidth,
          height: LAYOUT.rows * LAYOUT.tileHeight,
        });
      },
      hasFilter: async () => true,
    });
  }

  beforeEach(async () => {
    const base = await mkdtemp(path.join(tmpdir(), "trickplay-legacy-"));
    temporaryRoots.push(base);
    mediaRoot = path.join(base, "media");
    generatedStorage = path.join(base, "generated");
    rows = [];
    calls = [];
    await mkdir(path.join(titleRoot(), "src"), { recursive: true });
    // Exactly what a Jellyfin-era library looks like.
    await mkdir(
      path.join(titleRoot(), "Dune (2021) [438631].trickplay", "320 - 10x10"),
      {
        recursive: true,
      },
    );
    await writeFile(
      path.join(
        titleRoot(),
        "Dune (2021) [438631].trickplay",
        "320 - 10x10",
        "0.jpg",
      ),
      "old",
    );
  });

  it("reports no set for a title that has only the old external folder", async () => {
    expect(await service().findForItem(SOURCE.itemId)).toBeNull();
  });

  it("does not suppress generation", async () => {
    const set = await service().generateForItem(SOURCE.itemId);

    expect(set).not.toBeNull();
    expect(calls).toHaveLength(planTrickplaySegments(LAYOUT).length);
    expect(await readdir(path.join(titleRoot(), "trickplay"))).toContain(
      "sprite_0.jpg",
    );
  });

  it("leaves the old folder exactly where it was", async () => {
    await service().generateForItem(SOURCE.itemId);

    expect(
      await readFile(
        path.join(
          titleRoot(),
          "Dune (2021) [438631].trickplay",
          "320 - 10x10",
          "0.jpg",
        ),
        "utf8",
      ),
    ).toBe("old");
  });

  it("is not counted as a generated file id by the bulk sweep", async () => {
    expect(await service().listGeneratedMediaFileIds([SOURCE.id])).toEqual(
      new Set(),
    );
  });
});

describe("deleting a title's trickplay", () => {
  let mediaRoot: string;
  let generatedStorage: string;
  let rows: Array<Record<string, unknown>>;

  const SOURCE: MediaFileRow = {
    id: "11111111-1111-4111-8111-111111111111",
    itemId: "22222222-2222-4222-8222-222222222222",
    relativePath: "Movies/Dune (2021)/src/Dune (2021).mkv",
    container: "mkv",
    sizeBytes: "1",
    mtimeMs: "1",
    fingerprint: "f",
    durationMs: "3600000",
    bitrateBps: null,
    isPrimary: true,
    probeState: "probed",
    missingSince: null,
  };

  const titleRoot = () => path.join(mediaRoot, "Movies", "Dune (2021)");

  function service() {
    const pool = {
      query: async (text: string) => {
        if (text.trimStart().startsWith("SELECT")) {
          return { rows, rowCount: rows.length };
        }
        rows = [];
        return { rows: [], rowCount: 1 };
      },
    } as unknown as DatabasePool;
    const catalogue = {
      getPrimaryFile: async () => SOURCE,
      getFileById: async () => SOURCE,
      getItemKind: async () => "movie",
      listStreams: async () => [videoStream()],
    } as unknown as CatalogueRepository;
    return createTrickplayService({
      pool,
      catalogue,
      mediaRoot,
      generatedStoragePath: generatedStorage,
      runFfmpeg: async () => undefined,
      hasFilter: async () => true,
    });
  }

  beforeEach(async () => {
    const base = await mkdtemp(path.join(tmpdir(), "trickplay-delete-"));
    temporaryRoots.push(base);
    mediaRoot = path.join(base, "media");
    generatedStorage = path.join(base, "generated");
    rows = [
      {
        id: "44444444-4444-4444-8444-444444444444",
        media_file_id: SOURCE.id,
        tile_width: LAYOUT.tileWidth,
        tile_height: LAYOUT.tileHeight,
        columns: LAYOUT.columns,
        rows: LAYOUT.rows,
        interval_ms: LAYOUT.intervalMs,
        thumbnail_count: LAYOUT.thumbnailCount,
        sprite_count: LAYOUT.spriteCount,
        storage_prefix: null,
        content_type: "image/jpeg",
      },
    ];
    // Everything a title folder can hold, so the delete has something to get
    // wrong.
    for (const directory of [
      "src",
      "video",
      "audio",
      "subtitle",
      "content",
      ".seyirlik",
      "trickplay",
      "Dune (2021) [438631].trickplay",
      "trailers/trailer.trickplay",
    ]) {
      await mkdir(path.join(titleRoot(), directory), { recursive: true });
      await writeFile(path.join(titleRoot(), directory, "keep.txt"), "x");
    }
  });

  it("removes the managed directory and nothing whose name merely ends in it", async () => {
    await service().deleteForItem(SOURCE.itemId);

    const remaining = (await readdir(titleRoot())).sort();
    expect(remaining).toEqual(
      [
        ".seyirlik",
        "Dune (2021) [438631].trickplay",
        "audio",
        "content",
        "src",
        "subtitle",
        "trailers",
        "video",
      ].sort(),
    );
    expect(
      await readdir(path.join(titleRoot(), "trailers", "trailer.trickplay")),
    ).toEqual(["keep.txt"]);
  });
});
