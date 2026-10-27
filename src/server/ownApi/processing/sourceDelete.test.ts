import { mkdtemp, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decideProcessing } from "../../../renditions/processing/decide";
import {
  computeSourceFingerprint,
  createEmptyRenditionRegistry,
  type RenditionRegistryItem,
} from "../../../renditions/registry";
import type { RouteContext, RoutePrincipal } from "../api/router";
import { OwnApiError } from "../ownApiHandler";
import { ADAPTIVE_PROFILE_VERSION } from "../../../renditions/adaptive/profile";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import type { JobQueue } from "../tasks/jobQueue";
import type { ProcessingJobStore } from "./jobStore";
import { createProcessingEnqueuer } from "./processingEnqueue";
import { createProcessingRoutes } from "./processingRoutes";

/*
 * Only the parts of the analysis that read the machine are replaced. The
 * manifest, the package files and the source file are all real: what this
 * route decides is whether the bytes on disk say the source is expendable, so
 * substituting the bytes would leave nothing worth testing.
 */
vi.mock("../../../renditions/probe", () => ({
  probeMediaFile: vi.fn(async () => ({})),
}));
vi.mock("../../../renditions/hardware/detect", () => ({
  detectHardware: vi.fn(async () => ({ platform: "test", adapters: [] })),
}));
vi.mock("../../../renditions/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../renditions/registry")>()),
  computeSourceFingerprint: vi.fn(async () => FINGERPRINT),
}));
vi.mock("../../../renditions/processing/decide", () => ({
  decideProcessing: vi.fn(() => ({
    action: "package-adaptive",
    summary: "",
    ladder: [{ qualityHeight: 1080, width: 1920, height: 1080 }],
    renditionsToEncode: [1080],
    estimate: { outputBytes: 0, stagingBytes: 0, sufficient: true },
    streams: { audio: [], subtitles: [], keptSubtitleStreamIndexes: [] },
    warnings: [],
  })),
  freeBytesOn: vi.fn(async () => 1_000_000_000),
}));

const ITEM = "11111111-1111-4111-8111-111111111111";
const FILE = "22222222-2222-4222-8222-222222222222";
const FINGERPRINT = "fingerprint-1";
const SOURCE_BYTES = "pretend source file";

interface Fixture {
  root: string;
  titleRoot: string;
  sourcePath: string;
}

/** A title folder holding a source and a complete one-rung package. */
async function fixture(
  options: {
    withSource?: boolean;
    withMedia?: boolean;
    /** Writes the rendition short, as an interrupted copy leaves it. */
    truncateMedia?: boolean;
  } = {},
): Promise<Fixture> {
  const {
    withSource = true,
    withMedia = true,
    truncateMedia = false,
  } = options;
  const root = await mkdtemp(path.join(tmpdir(), "seyirlik-source-delete-"));
  const titleRoot = path.join(root, "Movies", "Solaris (1972)");
  await mkdir(path.join(titleRoot, ".seyirlik", "video"), { recursive: true });
  await mkdir(path.join(titleRoot, "video"), { recursive: true });

  const sourcePath = path.join(titleRoot, "Solaris (1972).mkv");
  if (withSource) await writeFile(sourcePath, SOURCE_BYTES);

  const media = "video/1080p.mp4";
  const mediaBytes = "pretend rendition";
  if (withMedia) {
    await writeFile(
      path.join(titleRoot, ...media.split("/")),
      truncateMedia ? mediaBytes.slice(0, 5) : mediaBytes,
    );
  }
  await writeFile(path.join(titleRoot, ".seyirlik", "master.m3u8"), "#EXTM3U");
  await writeFile(
    path.join(titleRoot, ".seyirlik", "video", "1080p.m3u8"),
    "#EXTM3U",
  );
  await writeFile(
    path.join(titleRoot, ".seyirlik", "package.json"),
    JSON.stringify({
      schemaVersion: 1,
      profileVersion: ADAPTIVE_PROFILE_VERSION,
      sourceFingerprint: FINGERPRINT,
      createdAt: new Date().toISOString(),
      sourceDurationSeconds: 100,
      masterPlaylistPath: ".seyirlik/master.m3u8",
      video: [
        {
          id: "v1080",
          mediaPath: media,
          playlistPath: ".seyirlik/video/1080p.m3u8",
          fileSizeBytes: mediaBytes.length,
          qualityHeight: 1080,
          hdr: "sdr",
        },
      ],
      audio: [],
      subtitle: [],
      storage: { totalBytes: mediaBytes.length },
    }),
  );

  return { root, titleRoot, sourcePath };
}

function stubStore(activeJob: { id: string } | null): ProcessingJobStore {
  return {
    findActiveForFile: async () => activeJob,
  } as unknown as ProcessingJobStore;
}

function stubCatalogue(): CatalogueRepository {
  return {
    // A movie: its package sits beside it, which is what this suite exercises.
    getItemKind: async () => "movie" as const,
    listFilesForItem: async () => [
      {
        id: FILE,
        relativePath: "Movies/Solaris (1972)/Solaris (1972).mkv",
        missingSince: null,
        sizeBytes: BigInt(SOURCE_BYTES.length),
      },
    ],
  } as unknown as CatalogueRepository;
}

async function callDelete(
  fixtureData: Fixture,
  options: {
    store?: ProcessingJobStore;
    storageAvailable?: () => boolean;
  } = {},
) {
  const catalogue = stubCatalogue();

  const routes = createProcessingRoutes({
    catalogue,
    store: options.store ?? stubStore(null),
    queue: {} as unknown as JobQueue,
    mediaRoot: fixtureData.root,
    workRoot: fixtureData.root,
    ...(options.storageAvailable
      ? { storageAvailable: options.storageAvailable }
      : {}),
  });
  const route = routes.find(
    (candidate) =>
      candidate.path === "/processing/source/delete" &&
      candidate.method === "POST",
  );
  expect(route).toBeDefined();

  const sent = { statusCode: 200, body: "" };
  const response = {
    get statusCode() {
      return sent.statusCode;
    },
    set statusCode(value: number) {
      sent.statusCode = value;
    },
    setHeader() {},
    end(chunk?: string) {
      sent.body = chunk ?? "";
    },
  } as unknown as ServerResponse;

  const principal: RoutePrincipal = {
    userId: ITEM,
    username: "admin",
    displayName: "Admin",
    isAdministrator: true,
    sessionId: FILE,
    sessionTokenHash: Buffer.alloc(32),
  };
  const context: RouteContext = {
    request: {} as IncomingMessage,
    response,
    requestId: "req-1",
    url: new URL("https://seyirlik.test/processing/source/delete"),
    params: {},
    method: "POST",
    principal,
    requirePrincipal: () => principal,
    readJson: async () => ({ itemId: ITEM }),
  };

  let error: OwnApiError | undefined;
  try {
    await route!.handle(context);
  } catch (thrown) {
    error = thrown as OwnApiError;
  }
  return {
    error,
    data: sent.body ? (JSON.parse(sent.body) as { data: unknown }).data : null,
  };
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(computeSourceFingerprint).mockResolvedValue(FINGERPRINT);
  vi.mocked(decideProcessing).mockReturnValue({
    action: "package-adaptive",
    summary: "",
    ladder: [{ qualityHeight: 1080, width: 1920, height: 1080 }],
    renditionsToEncode: [1080],
    estimate: { outputBytes: 0, stagingBytes: 0, sufficient: true },
    streams: { audio: [], subtitles: [], keptSubtitleStreamIndexes: [] },
    warnings: [],
  } as unknown as ReturnType<typeof decideProcessing>);
});

describe("POST /processing/source/delete", () => {
  it("removes the source once the package is complete and intact", async () => {
    const data = await fixture();
    const result = await callDelete(data);

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({
      deleted: true,
      alreadyAbsent: false,
      freedBytes: SOURCE_BYTES.length,
    });
    expect(await exists(data.sourcePath)).toBe(false);
    // Only the source goes: the package is the whole point of removing it.
    expect(await exists(path.join(data.titleRoot, "video", "1080p.mp4"))).toBe(
      true,
    );
  });

  it("keeps the source when today's ladder would still add a rung", async () => {
    const data = await fixture();
    vi.mocked(decideProcessing).mockReturnValue({
      action: "package-adaptive",
      summary: "",
      ladder: [
        { qualityHeight: 1440, width: 2560, height: 1440 },
        { qualityHeight: 1080, width: 1920, height: 1080 },
      ],
      renditionsToEncode: [1440],
      estimate: { outputBytes: 0, stagingBytes: 0, sufficient: true },
      streams: { audio: [], subtitles: [], keptSubtitleStreamIndexes: [] },
      warnings: [],
    } as unknown as ReturnType<typeof decideProcessing>);

    const result = await callDelete(data);

    expect(result.error?.code).toBe("PROCESSING_PACKAGE_INCOMPLETE");
    expect(await exists(data.sourcePath)).toBe(true);
  });

  it("keeps a source whose bytes no longer match the package", async () => {
    const data = await fixture();
    vi.mocked(computeSourceFingerprint).mockResolvedValue("fingerprint-2");

    const result = await callDelete(data);

    expect(result.error?.code).toBe("PROCESSING_PACKAGE_INCOMPLETE");
    expect(await exists(data.sourcePath)).toBe(true);
  });

  it("keeps the source when a package file the manifest claims is gone", async () => {
    const data = await fixture({ withMedia: false });
    const result = await callDelete(data);

    expect(result.error?.code).toBe("PROCESSING_PACKAGE_INCOMPLETE");
    expect(await exists(data.sourcePath)).toBe(true);
  });

  /*
   * The failure House of the Dragon S01E01 arrived as: every file the manifest
   * names is present, and one of them is 68 MB shorter than it was published
   * at. Nothing opens wrong, nothing logs, and the last three minutes of the
   * 4K rung simply are not there — so the source is the only whole copy left
   * and must not be removed.
   */
  it("keeps the source when a rendition on disk is shorter than the package records", async () => {
    const data = await fixture({ truncateMedia: true });
    const result = await callDelete(data);

    expect(result.error?.code).toBe("PROCESSING_PACKAGE_INCOMPLETE");
    expect(await exists(data.sourcePath)).toBe(true);
  });

  it("names the damaged file and both sizes, so the message can be acted on", async () => {
    const data = await fixture({ truncateMedia: true });
    const result = await callDelete(data);

    expect(result.error?.message).toContain("video/1080p.mp4");
    expect(result.error?.message).toContain("5 bytes on disk");
    expect(result.error?.message).toContain("17");
  });

  it("keeps the source while the media volume is unavailable", async () => {
    const data = await fixture();
    const result = await callDelete(data, { storageAvailable: () => false });

    expect(result.error?.code).toBe("PROCESSING_STORAGE_UNAVAILABLE");
    expect(await exists(data.sourcePath)).toBe(true);
  });

  it("keeps the source while a processing job is still reading it", async () => {
    const data = await fixture();
    const result = await callDelete(data, {
      store: stubStore({ id: "job-1" }),
    });

    expect(result.error?.code).toBe("PROCESSING_JOB_EXISTS");
    expect(await exists(data.sourcePath)).toBe(true);
  });

  it("reports an already absent source rather than failing", async () => {
    const data = await fixture({ withSource: false });
    const result = await callDelete(data);

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({
      deleted: false,
      alreadyAbsent: true,
      freedBytes: 0,
    });
  });
});

/*
 * The helper that removes sources after upload asks for one thing more than
 * the button: that the source is still the bytes *its job* built from, not
 * merely bytes some package in the folder matches.
 */
describe("removing a source for a particular job", () => {
  function enqueuer(
    root: string,
    registry?: Parameters<typeof createProcessingEnqueuer>[0]["registry"],
  ) {
    return createProcessingEnqueuer({
      ...(registry ? { registry } : {}),
      catalogue: stubCatalogue(),
      store: stubStore(null),
      queue: {} as unknown as JobQueue,
      mediaRoot: root,
      workRoot: root,
      ffprobePath: "ffprobe",
      hardware: async () =>
        ({ platform: "test", adapters: [] }) as unknown as Awaited<
          ReturnType<Parameters<typeof createProcessingEnqueuer>[0]["hardware"]>
        >,
      storageGuard: { mayStartWork: () => true } as unknown as Parameters<
        typeof createProcessingEnqueuer
      >[0]["storageGuard"],
    });
  }

  it("removes it when the job's fingerprint is the source's", async () => {
    const data = await fixture();
    const removal = await enqueuer(data.root).removeSource(ITEM, FILE, {
      expectedFingerprint: FINGERPRINT,
    });
    expect(removal).toMatchObject({
      deleted: true,
      freedBytes: SOURCE_BYTES.length,
    });
    expect(await exists(data.sourcePath)).toBe(false);
  });

  it("keeps it when the job built from other bytes", async () => {
    const data = await fixture();
    await expect(
      enqueuer(data.root).removeSource(ITEM, FILE, {
        expectedFingerprint: "fingerprint-of-an-older-download",
      }),
    ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await exists(data.sourcePath)).toBe(true);
  });

  it("tells the caller which package was found damaged", async () => {
    const data = await fixture({ truncateMedia: true });
    const onDamage = vi.fn();
    await expect(
      enqueuer(data.root).removeSource(ITEM, FILE, { onDamage }),
    ).rejects.toMatchObject({ code: "PROCESSING_PACKAGE_INCOMPLETE" });
    expect(onDamage).toHaveBeenCalledWith(
      FILE,
      expect.objectContaining({ rungs: [1080], elsewhere: false }),
    );
    expect(await exists(data.sourcePath)).toBe(true);
  });

  /*
   * Lilyhammer S01E01, 2026-10-20: the package was whole, the registry write
   * that tells playback about it was lost, and the source was removed.
   */
  describe("asks the registry playback reads", () => {
    const registryWith = (entry: Partial<RenditionRegistryItem> | null) => ({
      read: async () => ({
        ...createEmptyRenditionRegistry(),
        items: entry
          ? [
              {
                id: "11111111-1111-4111-8111-111111111111",
                relativePath: "Movies/Solaris (1972)/Solaris (1972).mkv",
                size: SOURCE_BYTES.length,
                // The stub catalogue row records no modification time.
                mtimeMs: 0,
                sourceFingerprint: FINGERPRINT,
                profileVersion: "legacy",
                lastSeenAt: "2026-10-20T00:00:00.000Z",
                adaptiveStatus: "ready" as const,
                adaptiveProfileVersion: ADAPTIVE_PROFILE_VERSION,
                ...entry,
              },
            ]
          : [],
      }),
    });

    it("removes it once playback's entry is ready", async () => {
      const data = await fixture();
      const removal = await enqueuer(data.root, registryWith({})).removeSource(
        ITEM,
        FILE,
      );
      expect(removal.deleted).toBe(true);
    });

    it.each([
      ["there is no entry", null, "has no entry"],
      [
        "the entry is not ready",
        { adaptiveStatus: "pending" as const },
        "is pending",
      ],
      [
        "the entry describes other bytes",
        { sourceFingerprint: "b".repeat(64) },
        "other source bytes",
      ],
    ])("keeps it when %s", async (_label, entry, reason) => {
      const data = await fixture();
      const refusal = enqueuer(data.root, registryWith(entry)).removeSource(
        ITEM,
        FILE,
      );
      await expect(refusal).rejects.toMatchObject({
        code: "PROCESSING_PACKAGE_INCOMPLETE",
      });
      await expect(refusal).rejects.toThrow(reason);
      expect(await exists(data.sourcePath)).toBe(true);
    });
  });
});
