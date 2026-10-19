/**
 * The subtitle subsystem, end to end, against a synthetic library.
 *
 * Everything below the job handler is real: the handlers, the service, the
 * state machine, the pipeline, the scorer, the payload validator, the storage
 * writer, and the playback boundary. Files are written to a real temporary
 * directory and read back from the disk rather than from a mock's memory,
 * because the whole point of the storage module is what it does to a
 * filesystem, and a fake filesystem cannot fail the way a real one does.
 *
 * Two things are substituted, and both are named rather than hidden:
 *
 *  - **The providers.** A test that reached a real subtitle site would be a
 *    test of that site's availability, and would spend somebody else's rate
 *    limit to tell us nothing about this code.
 *  - **The execution repository.** The real one is PostgreSQL: an advisory
 *    lock, a checkpoint UPDATE and an event INSERT. The synthetic one here
 *    honours the same contract — one holder per media file, transactions that
 *    roll back, checkpoints that survive the call — so the service's use of it
 *    is exercised, but the SQL itself is NOT covered by this file and must be
 *    verified against a real database before the subsystem is trusted in
 *    production.
 *
 * No real media volume is touched. The library root is a temporary directory
 * created and removed by the test.
 */

import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlaybackRefreshBoundary } from "../playback/playbackRefresh";
import { PermanentJobError, DeferredJobError } from "../tasks/worker";
import type { JobHandler } from "../tasks/worker";
import type { SubtitleConfig } from "./subtitleConfig";
import type {
  SubtitleExecutionRepository,
  SubtitleWork,
} from "./subtitleExecution";
import { createSubtitleJobHandlers, SUBTITLE_JOB_TYPES } from "./subtitleJobs";
import {
  createProviderSession,
  type ProviderResult,
  type ProviderSessionManager,
  type ScoredCandidate,
  type SessionLookup,
  type SubtitleCandidate,
  type SubtitlePayload,
  type SubtitleProvider,
} from "./subtitleProvider";
import type {
  RecordInstallationInput,
  SubtitleAttemptRow,
  SubtitleRepository,
  SubtitleWantRow,
} from "./subtitleRepository";
import { SubtitleAttemptMovedError } from "./subtitleRepository";
import { createSubtitleService } from "./subtitleService";
import {
  assertTransition,
  UNCERTAIN_SUBTITLE_STATES,
  type SubtitleState,
  type SubtitleTrack,
} from "./subtitleState";
import { subtitleDigest, type SubtitleWriteIntent } from "./subtitleStorage";

/* ------------------------------------------------------------ the material */

const MEDIA_ID = "media-0001";
const ATTEMPT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const RELATIVE = "Movies/Dune (2021)/Dune (2021) [BluRay-1080p].mkv";

const SRT = (line: string) =>
  new TextEncoder().encode(
    `1\n00:00:01,000 --> 00:00:03,000\n${line}\n\n2\n00:00:04,000 --> 00:00:06,000\nAnd then.\n`,
  );

const payload = (line: string): SubtitlePayload => ({
  bytes: SRT(line),
  declaredFormat: "srt",
  declaredFileName: "whatever.srt",
});

const candidate = (
  over: Partial<SubtitleCandidate> = {},
): SubtitleCandidate => ({
  providerId: "synthetic",
  candidateId: "c1",
  language: "tur",
  format: "srt",
  forced: false,
  hearingImpaired: false,
  releaseTitle: "Dune 2021 1080p BluRay x264-SPARKS",
  releaseGroup: "SPARKS",
  source: "bluray",
  resolution: "1080p",
  hashMatched: false,
  providerRating: 8,
  identity: { title: "Dune", year: 2021, season: null, episode: null },
  ...over,
});

/* ------------------------------------------------- a provider we can steer */

interface ProviderScript {
  id?: string;
  requiresSession?: boolean;
  rank?: number;
  languages?: readonly string[] | null;
  search?: ProviderResult<readonly SubtitleCandidate[]>;
  searches?: ProviderResult<readonly SubtitleCandidate[]>[];
  download?: ProviderResult<SubtitlePayload>;
  downloads?: ProviderResult<SubtitlePayload>[];
  hangFor?: number;
}

type ScriptedProvider = SubtitleProvider & {
  readonly calls: { search: number; download: number };
};

function scriptedProvider(script: ProviderScript): ScriptedProvider {
  const calls = { search: 0, download: 0 };
  const next = <T>(
    queue: T[] | undefined,
    single: T | undefined,
    index: number,
  ): T =>
    queue ? (queue[Math.min(index, queue.length - 1)] as T) : (single as T);
  return {
    calls,
    id: script.id ?? "synthetic",
    label: "Synthetic",
    requiresSession: script.requiresSession ?? false,
    rank: script.rank ?? 10,
    languages: script.languages === undefined ? ["tur"] : script.languages,
    async search() {
      const index = calls.search++;
      if (script.hangFor)
        await new Promise((resolve) => setTimeout(resolve, script.hangFor));
      return (
        next(script.searches, script.search, index) ?? { outcome: "empty" }
      );
    },
    async download() {
      const index = calls.download++;
      return (
        next(script.downloads, script.download, index) ?? { outcome: "empty" }
      );
    },
  };
}

/* ---------------------------------------------- a session we can hand over */

function steerableSessions(): ProviderSessionManager & {
  authenticate(): void;
  invalidations: string[];
} {
  let ready = false;
  const invalidations: string[] = [];
  return {
    authenticate() {
      ready = true;
    },
    invalidations,
    async acquire(providerId): Promise<SessionLookup> {
      return ready
        ? {
            outcome: "ready",
            session: createProviderSession({
              providerId,
              cookie: "cf_clearance=SYNTHETIC-SECRET-VALUE",
              userAgent: "Synthetic/1.0",
            }),
          }
        : {
            outcome: "needs-authentication",
            providerId,
            reason: "A person must sign in.",
            authenticateAt: null,
          };
    },
    async invalidate(providerId) {
      invalidations.push(providerId);
      ready = false;
    },
  };
}

/* --------------------------------------------- the synthetic durable state */

interface World {
  root: string;
  config: SubtitleConfig;
  repository: SubtitleRepository;
  execution: SubtitleExecutionRepository;
  events: { attemptId: string; type: string }[];
  installs: RecordInstallationInput[];
  attempts: Map<string, SubtitleAttemptRow>;
  wants: Map<string, SubtitleWantRow>;
  embedded: SubtitleTrack[];
  held: Set<string>;
  failRecordInstallation: boolean;
  state(): SubtitleState;
  sidecars(): Promise<string[]>;
}

function blankAttempt(
  over: Partial<SubtitleAttemptRow> = {},
): SubtitleAttemptRow {
  return {
    id: ATTEMPT_ID,
    wantId: "want-1",
    state: "wanted",
    attempt: 0,
    providerId: null,
    candidateId: null,
    score: null,
    failureClass: null,
    failureDetail: null,
    awaitingProviderId: null,
    runAfter: null,
    ...over,
  };
}

async function createWorld(
  over: {
    attempt?: Partial<SubtitleAttemptRow>;
    want?: Partial<SubtitleWantRow>;
    embedded?: SubtitleTrack[];
    checkpoint?: Partial<
      Pick<SubtitleWork, "selected" | "intent" | "replace" | "resumeStage">
    >;
    installs?: RecordInstallationInput[];
  } = {},
): Promise<World> {
  const root = await mkdtemp(path.join(tmpdir(), "seyirlik-subtitles-"));
  await mkdir(path.join(root, path.dirname(RELATIVE)), { recursive: true });
  await writeFile(path.join(root, RELATIVE), "not really a film");

  const attempts = new Map<string, SubtitleAttemptRow>([
    [ATTEMPT_ID, blankAttempt(over.attempt)],
  ]);
  const wants = new Map<string, SubtitleWantRow>([
    [
      "want-1",
      {
        id: "want-1",
        mediaFileId: MEDIA_ID,
        language: "tur",
        forced: false,
        hearingImpaired: "indifferent",
        active: true,
        ...over.want,
      },
    ],
  ]);
  const events: World["events"] = [];
  const installs: RecordInstallationInput[] = [...(over.installs ?? [])];
  const checkpoint = {
    selected: null as ScoredCandidate | null,
    intent: null as SubtitleWriteIntent | null,
    replace: false,
    resumeStage: null as SubtitleWork["resumeStage"],
    ...over.checkpoint,
  };

  const repository: SubtitleRepository = {
    async getAttempt(id) {
      return attempts.get(id) ?? null;
    },
    // The operations listing; this workflow does not exercise it.
    async recentAttempts() {
      return [];
    },
    // Request routes; this workflow starts attempts directly.
    async openAttempt() {
      return null;
    },
    async titleMediaFiles() {
      return [];
    },
    // The upload route resolves its own path; this workflow does not.
    async mediaFileRelativePath() {
      return null;
    },
    async attemptsAwaiting() {
      return [];
    },
    async ensureWant() {
      throw new Error("not exercised");
    },
    async activeWants() {
      return [...wants.values()].filter((w) => w.active);
    },
    async deactivateWant(id) {
      const want = wants.get(id);
      if (want) wants.set(id, { ...want, active: false });
    },
    async beginAttempt() {
      throw new Error("not exercised");
    },
    async moveAttempt(input) {
      const current = attempts.get(input.attemptId);
      if (!current || current.state !== input.from)
        throw new SubtitleAttemptMovedError(input.attemptId, input.from);
      assertTransition(input.from, input.to);
      const moved: SubtitleAttemptRow = {
        ...current,
        state: input.to,
        attempt: current.attempt + (input.countsAsAttempt ? 1 : 0),
        providerId: input.providerId ?? current.providerId,
        candidateId: input.candidateId ?? current.candidateId,
        score: input.score ?? current.score,
        failureClass: input.failureClass ?? null,
        failureDetail: input.failureDetail ?? null,
        awaitingProviderId: input.awaitingProviderId ?? null,
        runAfter: input.runAfter ?? null,
      };
      attempts.set(input.attemptId, moved);
      return moved;
    },
    async uncertainAttempts() {
      return [...attempts.values()].filter((a) =>
        UNCERTAIN_SUBTITLE_STATES.includes(a.state),
      );
    },
    async recordInstallation(input) {
      if (world.failRecordInstallation)
        throw new Error("The catalogue went away mid-commit.");
      installs.push(input);
      return "installation-1";
    },
    async managedDigest(mediaFileId, relativePath) {
      const found = installs.find(
        (i) => i.mediaFileId === mediaFileId && i.relativePath === relativePath,
      );
      return found?.sha256 ?? null;
    },
    async recordRetiming(input) {
      const index = installs.findIndex(
        (i) =>
          i.mediaFileId === input.mediaFileId &&
          i.relativePath === input.relativePath,
      );
      const previous = installs[index];
      const record: RecordInstallationInput = {
        wantId: previous?.wantId ?? null,
        attemptId: previous?.attemptId ?? null,
        hearingImpaired: previous?.hearingImpaired ?? false,
        providerId: previous?.providerId ?? null,
        mediaFileId: input.mediaFileId,
        relativePath: input.relativePath,
        language: previous?.language ?? input.language,
        forced: previous?.forced ?? input.forced,
        format: input.format,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
        cueCount: input.cueCount,
        syncState: "assumed-in-sync",
      };
      if (index >= 0) installs.splice(index, 1, record);
      else installs.push(record);
    },
    async forgetInstallation(mediaFileId, relativePath) {
      const index = installs.findIndex(
        (i) => i.mediaFileId === mediaFileId && i.relativePath === relativePath,
      );
      if (index >= 0) installs.splice(index, 1);
    },
  };

  const held = new Set<string>();
  const execution: SubtitleExecutionRepository = {
    async withAttempt(attemptId, operation) {
      const want = wants.get(attempts.get(attemptId)?.wantId ?? "");
      if (!want) throw new Error("The subtitle attempt no longer exists.");
      if (held.has(want.mediaFileId)) return undefined;
      held.add(want.mediaFileId);
      const controller = new AbortController();
      try {
        const work: SubtitleWork = {
          attempt: attempts.get(attemptId)!,
          want,
          relativePath: RELATIVE,
          query: {
            title: "Dune",
            year: 2021,
            season: null,
            episode: null,
            language: want.language,
            wantForced: want.forced,
            releaseTitle: null,
            releaseGroup: null,
            source: null,
            resolution: null,
            videoHash: null,
            durationSeconds: 9180,
          },
          embedded: over.embedded ?? [],
          selected: checkpoint.selected,
          intent: checkpoint.intent,
          replace: checkpoint.replace,
          resumeStage: checkpoint.resumeStage,
          repository,
          signal: controller.signal,
          async checkpoint(patch) {
            if (patch.selected) checkpoint.selected = patch.selected;
            if (patch.intent) checkpoint.intent = patch.intent;
            if (patch.resumeStage) checkpoint.resumeStage = patch.resumeStage;
            if (patch.replace !== undefined) checkpoint.replace = patch.replace;
            Object.assign(work, checkpoint);
          },
          async event(type) {
            events.push({ attemptId, type });
          },
          async transaction(inner) {
            const snapshot = {
              attempts: new Map(attempts),
              wants: new Map(wants),
              installs: [...installs],
              events: events.length,
            };
            try {
              return await inner();
            } catch (error) {
              attempts.clear();
              for (const [k, v] of snapshot.attempts) attempts.set(k, v);
              wants.clear();
              for (const [k, v] of snapshot.wants) wants.set(k, v);
              installs.splice(0, installs.length, ...snapshot.installs);
              events.length = snapshot.events;
              throw error;
            }
          },
        };
        return await operation(work);
      } finally {
        held.delete(want.mediaFileId);
      }
    },
  };

  const world: World = {
    root,
    config: { libraryRoot: root, providerIds: ["synthetic"], timeoutMs: 2_000 },
    repository,
    execution,
    events,
    installs,
    attempts,
    wants,
    embedded: over.embedded ?? [],
    held,
    failRecordInstallation: false,
    state: () => attempts.get(ATTEMPT_ID)!.state,
    async sidecars() {
      const entries = await readdir(path.join(root, path.dirname(RELATIVE)));
      return entries.filter((name) => !name.endsWith(".mkv")).sort();
    },
  };
  return world;
}

/* ------------------------------------------------------------ the harness */

function handlersFor(
  world: World,
  providers: SubtitleProvider[],
  sessions: ProviderSessionManager,
): Record<string, JobHandler> {
  return createSubtitleJobHandlers(
    createSubtitleService({
      config: world.config,
      execution: world.execution,
      providers,
      sessions,
      playback: createPlaybackRefreshBoundary(),
    }),
    world.repository,
  );
}

function invoke(
  handlers: Record<string, JobHandler>,
  type: string,
  payloadFields: Record<string, unknown> = { attemptId: ATTEMPT_ID },
  isCancelled: () => Promise<boolean> = async () => false,
) {
  return handlers[type]!({
    job: { payload: payloadFields },
    reportProgress: async () => {},
    isCancelled,
  } as unknown as Parameters<JobHandler>[0]);
}

let world: World;
afterEach(async () => {
  if (world) await rm(world.root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ tests */

describe("finding a subtitle and putting it beside the film", () => {
  beforeEach(async () => {
    world = await createWorld();
  });

  it("installs it, names it by convention, and records the receipt", async () => {
    const provider = scriptedProvider({
      search: { outcome: "ok", value: [candidate()] },
      download: { outcome: "ok", value: payload("Fear is the mind-killer.") },
    });
    const result = await invoke(
      handlersFor(world, [provider], steerableSessions()),
      SUBTITLE_JOB_TYPES.run,
    );

    expect(result).toMatchObject({ state: "installed", duplicate: false });
    expect(await world.sidecars()).toEqual([
      "Dune (2021) [BluRay-1080p].tur.srt",
    ]);
    expect(world.state()).toBe("installed");
    expect(world.wants.get("want-1")!.active).toBe(false);
    expect(world.installs).toEqual([
      expect.objectContaining({
        mediaFileId: MEDIA_ID,
        relativePath: "Movies/Dune (2021)/Dune (2021) [BluRay-1080p].tur.srt",
        language: "tur",
        format: "srt",
        providerId: "synthetic",
        cueCount: 2,
        syncState: "unknown",
      }),
    ]);
  });

  it("leaves the bytes it was given, not a re-encoding of them", async () => {
    const bytes = payload("Fear is the mind-killer.");
    await invoke(
      handlersFor(
        world,
        [
          scriptedProvider({
            search: { outcome: "ok", value: [candidate()] },
            download: { outcome: "ok", value: bytes },
          }),
        ],
        steerableSessions(),
      ),
      SUBTITLE_JOB_TYPES.run,
    );
    const written = await readFile(
      path.join(
        world.root,
        "Movies/Dune (2021)/Dune (2021) [BluRay-1080p].tur.srt",
      ),
    );
    expect(subtitleDigest(written)).toBe(subtitleDigest(bytes.bytes));
    expect(world.installs[0]!.sha256).toBe(subtitleDigest(bytes.bytes));
  });

  it("walks the states it claims to walk, in order", async () => {
    await invoke(
      handlersFor(
        world,
        [
          scriptedProvider({
            search: { outcome: "ok", value: [candidate()] },
            download: { outcome: "ok", value: payload("Hello.") },
          }),
        ],
        steerableSessions(),
      ),
      SUBTITLE_JOB_TYPES.run,
    );
    expect(world.events.map((e) => e.type)).toEqual([
      "search-started",
      "candidate-selected",
      "installed",
      "playback-refresh",
    ]);
  });

  it("reports the playback refresh it could not make, rather than failing over it", async () => {
    const result = await invoke(
      handlersFor(
        world,
        [
          scriptedProvider({
            search: { outcome: "ok", value: [candidate()] },
            download: { outcome: "ok", value: payload("Hello.") },
          }),
        ],
        steerableSessions(),
      ),
      SUBTITLE_JOB_TYPES.run,
    );
    // No player is wired in here; the install still stands.
    expect(result).toMatchObject({
      state: "installed",
      playback: "unconfigured",
    });
  });
});

describe("declining to write", () => {
  it("does nothing when the film already carries the language embedded", async () => {
    world = await createWorld({
      embedded: [
        {
          origin: "embedded",
          language: "tur",
          forced: false,
          hearingImpaired: false,
          format: "srt",
          streamIndex: 3,
        } as SubtitleTrack,
      ],
    });
    const provider = scriptedProvider({
      search: { outcome: "ok", value: [candidate()] },
    });
    const result = await invoke(
      handlersFor(world, [provider], steerableSessions()),
      SUBTITLE_JOB_TYPES.run,
    );
    expect(result).toMatchObject({ state: "superseded", existing: true });
    expect(provider.calls.search).toBe(0);
    expect(await world.sidecars()).toEqual([]);
    expect(world.wants.get("want-1")!.active).toBe(false);
  });

  it("refuses to overwrite a subtitle somebody else put there", async () => {
    world = await createWorld();
    await writeFile(
      path.join(
        world.root,
        "Movies/Dune (2021)/Dune (2021) [BluRay-1080p].tur.srt",
      ),
      "1\n00:00:01,000 --> 00:00:02,000\nHand made.\n",
    );
    const result = await invoke(
      handlersFor(
        world,
        [
          scriptedProvider({
            search: { outcome: "ok", value: [candidate()] },
            download: { outcome: "ok", value: payload("Ours.") },
          }),
        ],
        steerableSessions(),
      ),
      SUBTITLE_JOB_TYPES.run,
    );
    expect(result).toMatchObject({ state: "superseded", existing: true });
    expect(
      await readFile(
        path.join(
          world.root,
          "Movies/Dune (2021)/Dune (2021) [BluRay-1080p].tur.srt",
        ),
        "utf8",
      ),
    ).toContain("Hand made.");
  });

  it("still refuses when told to replace, if it did not install what is there", async () => {
    world = await createWorld();
    const target = path.join(
      world.root,
      "Movies/Dune (2021)/Dune (2021) [BluRay-1080p].tur.srt",
    );
    await writeFile(target, "1\n00:00:01,000 --> 00:00:02,000\nHand made.\n");
    const result = await invoke(
      handlersFor(
        world,
        [
          scriptedProvider({
            search: { outcome: "ok", value: [candidate()] },
            download: { outcome: "ok", value: payload("Ours.") },
          }),
        ],
        steerableSessions(),
      ),
      SUBTITLE_JOB_TYPES.run,
      { attemptId: ATTEMPT_ID, replace: true },
    );
    expect(result).toMatchObject({ state: "failed" });
    expect(await readFile(target, "utf8")).toContain("Hand made.");
  });

  it("replaces what it installed itself, when told to", async () => {
    world = await createWorld();
    const target = path.join(
      world.root,
      "Movies/Dune (2021)/Dune (2021) [BluRay-1080p].tur.srt",
    );
    const mine = payload("Mine, from before.");
    await writeFile(target, mine.bytes);
    world.installs.push({
      mediaFileId: MEDIA_ID,
      wantId: "want-1",
      attemptId: null,
      relativePath: "Movies/Dune (2021)/Dune (2021) [BluRay-1080p].tur.srt",
      language: "tur",
      forced: false,
      hearingImpaired: false,
      format: "srt",
      sha256: subtitleDigest(mine.bytes),
      sizeBytes: mine.bytes.length,
      cueCount: 2,
      providerId: "synthetic",
    });
    const better = payload("Mine, improved.");
    const result = await invoke(
      handlersFor(
        world,
        [
          scriptedProvider({
            search: { outcome: "ok", value: [candidate()] },
            download: { outcome: "ok", value: better },
          }),
        ],
        steerableSessions(),
      ),
      SUBTITLE_JOB_TYPES.run,
      { attemptId: ATTEMPT_ID, replace: true },
    );
    expect(result).toMatchObject({ state: "installed" });
    expect(await readFile(target, "utf8")).toContain("Mine, improved.");
  });

  it("calls byte-identical content a duplicate rather than a write", async () => {
    world = await createWorld();
    const same = payload("Already exactly this.");
    await writeFile(
      path.join(
        world.root,
        "Movies/Dune (2021)/Dune (2021) [BluRay-1080p].tur.srt",
      ),
      same.bytes,
    );
    world.installs.push({
      mediaFileId: MEDIA_ID,
      wantId: "want-1",
      attemptId: null,
      relativePath: "Movies/Dune (2021)/Dune (2021) [BluRay-1080p].tur.srt",
      language: "tur",
      forced: false,
      hearingImpaired: false,
      format: "srt",
      sha256: subtitleDigest(same.bytes),
      sizeBytes: same.bytes.length,
      cueCount: 2,
      providerId: "synthetic",
    });
    const result = await invoke(
      handlersFor(
        world,
        [
          scriptedProvider({
            search: { outcome: "ok", value: [candidate()] },
            download: { outcome: "ok", value: same },
          }),
        ],
        steerableSessions(),
      ),
      SUBTITLE_JOB_TYPES.run,
      { attemptId: ATTEMPT_ID, replace: true },
    );
    expect(result).toMatchObject({ state: "installed", duplicate: true });
    // A duplicate satisfies the want without claiming ownership of the file.
    expect(world.installs).toHaveLength(1);
  });

  it("does no work for a want somebody has since cancelled", async () => {
    world = await createWorld({ want: { active: false } });
    const provider = scriptedProvider({
      search: { outcome: "ok", value: [candidate()] },
    });
    await invoke(
      handlersFor(world, [provider], steerableSessions()),
      SUBTITLE_JOB_TYPES.run,
    );
    expect(provider.calls.search).toBe(0);
    expect(await world.sidecars()).toEqual([]);
  });
});

describe("what a provider offers and what is accepted", () => {
  beforeEach(async () => {
    world = await createWorld();
  });

  it("will not install a subtitle for a different film, however well labelled", async () => {
    const result = await invoke(
      handlersFor(
        world,
        [
          scriptedProvider({
            search: {
              outcome: "ok",
              value: [
                candidate({
                  identity: {
                    title: "Dune: Part Two",
                    year: 2024,
                    season: null,
                    episode: null,
                  },
                }),
              ],
            },
            download: { outcome: "ok", value: payload("Wrong film.") },
          }),
        ],
        steerableSessions(),
      ),
      SUBTITLE_JOB_TYPES.run,
    );
    expect(result).toMatchObject({ state: "unavailable" });
    expect(await world.sidecars()).toEqual([]);
  });

  it("will not install a candidate that says nothing about what it is for", async () => {
    const bare = candidate();
    delete (bare as { identity?: unknown }).identity;
    const result = await invoke(
      handlersFor(
        world,
        [
          scriptedProvider({
            search: { outcome: "ok", value: [bare] },
            download: { outcome: "ok", value: payload("A guess.") },
          }),
        ],
        steerableSessions(),
      ),
      SUBTITLE_JOB_TYPES.run,
    );
    expect(result).toMatchObject({ state: "unavailable" });
  });

  it("prefers the better-matching candidate and stops there", async () => {
    const provider = scriptedProvider({
      search: {
        outcome: "ok",
        value: [
          candidate({ candidateId: "poor", releaseGroup: null, source: null }),
          candidate({ candidateId: "good", hashMatched: true }),
        ],
      },
      download: { outcome: "ok", value: payload("The good one.") },
    });
    // The query carries no video hash, so hashMatch cannot score; the tie is
    // broken by candidate id, which is what makes two runs agree.
    await invoke(
      handlersFor(world, [provider], steerableSessions()),
      SUBTITLE_JOB_TYPES.run,
    );
    expect(provider.calls.download).toBe(1);
  });

  it("moves to the next candidate when the first will not download", async () => {
    const provider = scriptedProvider({
      search: {
        outcome: "ok",
        value: [
          candidate({ candidateId: "a" }),
          candidate({ candidateId: "b" }),
        ],
      },
      downloads: [
        { outcome: "error", reason: "The provider broke.", retryable: true },
        { outcome: "ok", value: payload("The second one.") },
      ],
    });
    const result = await invoke(
      handlersFor(world, [provider], steerableSessions()),
      SUBTITLE_JOB_TYPES.run,
    );
    expect(result).toMatchObject({ state: "installed" });
    expect(provider.calls.download).toBe(2);
    expect(
      await readFile(
        path.join(
          world.root,
          "Movies/Dune (2021)/Dune (2021) [BluRay-1080p].tur.srt",
        ),
        "utf8",
      ),
    ).toContain("The second one.");
  });

  /*
   * The Sopranos, 2026-10-19: every chosen download was a pack without this
   * episode. That is an absence, and it was being filed as failed/unknown.
   */
  it("calls it unavailable when every chosen download held nothing for this episode", async () => {
    const provider = scriptedProvider({
      search: {
        outcome: "ok",
        value: [
          candidate({ candidateId: "a" }),
          candidate({ candidateId: "b" }),
        ],
      },
      download: { outcome: "empty" },
    });
    const result = await invoke(
      handlersFor(world, [provider], steerableSessions()),
      SUBTITLE_JOB_TYPES.run,
    );
    expect(result).toMatchObject({ state: "unavailable" });
    expect(provider.calls.download).toBe(2);
    expect(world.attempts.get(ATTEMPT_ID)!.failureClass).toBeNull();
  });

  it("says the media is missing when its source is not on the disk", async () => {
    await rm(path.join(world.root, RELATIVE));
    const result = await invoke(
      handlersFor(world, [scriptedProvider({})], steerableSessions()),
      SUBTITLE_JOB_TYPES.run,
    );
    expect(result).toMatchObject({ state: "failed", failure: "media-missing" });
  });

  /*
   * A login page served where a subtitle was promised is a fault, not an
   * absence: `unavailable` would say the provider has nothing, and this
   * provider has something wrong with it.
   */
  it("calls a payload that is not a subtitle a fault, and writes nothing", async () => {
    const result = await invoke(
      handlersFor(
        world,
        [
          scriptedProvider({
            search: { outcome: "ok", value: [candidate()] },
            download: {
              outcome: "ok",
              value: {
                bytes: new TextEncoder().encode(
                  "<html><body>Sign in to continue</body></html>",
                ),
                declaredFormat: "srt",
                declaredFileName: "subtitle.srt",
              },
            },
          }),
        ],
        steerableSessions(),
      ),
      SUBTITLE_JOB_TYPES.run,
    );
    expect(result).toMatchObject({
      state: "failed",
      failure: "payload-invalid",
    });
    expect(await world.sidecars()).toEqual([]);
  });

  it("does not ask a provider that cannot carry the language", async () => {
    const provider = scriptedProvider({
      languages: ["deu"],
      search: { outcome: "ok", value: [candidate()] },
    });
    const result = await invoke(
      handlersFor(world, [provider], steerableSessions()),
      SUBTITLE_JOB_TYPES.run,
    );
    expect(provider.calls.search).toBe(0);
    expect(result).toMatchObject({ state: "failed", failure: "no-provider" });
  });

  it("classifies a provider that never answers as a timeout, not a mystery", async () => {
    world.config = { ...world.config, timeoutMs: 30 };
    const result = await invoke(
      handlersFor(
        world,
        [scriptedProvider({ hangFor: 500, search: { outcome: "empty" } })],
        steerableSessions(),
      ),
      SUBTITLE_JOB_TYPES.run,
    );
    expect(result).toMatchObject({
      state: "failed",
      failure: "provider-timeout",
    });
  });

  it("keeps a rate limit distinct from a fault", async () => {
    const result = await invoke(
      handlersFor(
        world,
        [
          scriptedProvider({
            search: { outcome: "rate-limited", retryAfterMs: 60_000 },
          }),
        ],
        steerableSessions(),
      ),
      SUBTITLE_JOB_TYPES.run,
    );
    expect(result).toMatchObject({
      state: "failed",
      failure: "provider-rate-limited",
    });
  });
});

describe("a provider that wants a person", () => {
  beforeEach(async () => {
    world = await createWorld();
  });

  it("pauses in a resumable state rather than failing", async () => {
    const sessions = steerableSessions();
    const provider = scriptedProvider({
      requiresSession: true,
      search: { outcome: "ok", value: [candidate()] },
      download: { outcome: "ok", value: payload("After signing in.") },
    });
    const result = await invoke(
      handlersFor(world, [provider], sessions),
      SUBTITLE_JOB_TYPES.run,
    );

    expect(result).toMatchObject({
      state: "needs-authentication",
      providerId: "synthetic",
    });
    expect(world.state()).toBe("needs-authentication");
    expect(world.attempts.get(ATTEMPT_ID)!.awaitingProviderId).toBe(
      "synthetic",
    );
    // The provider was never reached, so nothing was spent on it.
    expect(provider.calls.search).toBe(0);
    expect(await world.sidecars()).toEqual([]);
  });

  it("stays paused when run again without being resumed", async () => {
    const sessions = steerableSessions();
    const handlers = handlersFor(
      world,
      [scriptedProvider({ requiresSession: true })],
      sessions,
    );
    await invoke(handlers, SUBTITLE_JOB_TYPES.run);
    sessions.authenticate();
    const again = await invoke(handlers, SUBTITLE_JOB_TYPES.run);
    expect(again).toMatchObject({ state: "needs-authentication" });
    expect(world.state()).toBe("needs-authentication");
  });

  it("installs once a person has signed in and the resume job runs", async () => {
    const sessions = steerableSessions();
    const provider = scriptedProvider({
      requiresSession: true,
      search: { outcome: "ok", value: [candidate()] },
      download: { outcome: "ok", value: payload("After signing in.") },
    });
    const handlers = handlersFor(world, [provider], sessions);

    await invoke(handlers, SUBTITLE_JOB_TYPES.run);
    sessions.authenticate();
    const resumed = await invoke(handlers, SUBTITLE_JOB_TYPES.resume);

    expect(resumed).toMatchObject({ state: "installed" });
    expect(await world.sidecars()).toEqual([
      "Dune (2021) [BluRay-1080p].tur.srt",
    ]);
    expect(world.events.map((e) => e.type)).toContain("authentication-resumed");
  });

  it("tells the session store when the far end rejects a session it handed out", async () => {
    const sessions = steerableSessions();
    sessions.authenticate();
    await invoke(
      handlersFor(
        world,
        [
          scriptedProvider({
            requiresSession: true,
            search: {
              outcome: "needs-authentication",
              reason: "Challenged again.",
              authenticateAt: null,
            },
          }),
        ],
        sessions,
      ),
      SUBTITLE_JOB_TYPES.run,
    );
    expect(sessions.invalidations).toEqual(["synthetic"]);
    expect(world.state()).toBe("needs-authentication");
  });

  it("keeps session material out of everything it returns and records", async () => {
    const sessions = steerableSessions();
    sessions.authenticate();
    const result = await invoke(
      handlersFor(
        world,
        [
          scriptedProvider({
            requiresSession: true,
            search: { outcome: "ok", value: [candidate()] },
            download: { outcome: "ok", value: payload("Signed in.") },
          }),
        ],
        sessions,
      ),
      SUBTITLE_JOB_TYPES.run,
    );
    const everything = JSON.stringify({
      result,
      events: world.events,
      installs: world.installs,
      attempt: world.attempts.get(ATTEMPT_ID),
    });
    expect(everything).not.toContain("SYNTHETIC-SECRET-VALUE");
    expect(everything).not.toMatch(/cf_clearance|cookie/i);
  });
});

describe("picking up after a crash", () => {
  it("recovers bytes that landed before the catalogue could record them", async () => {
    world = await createWorld();
    world.failRecordInstallation = true;
    const provider = scriptedProvider({
      search: { outcome: "ok", value: [candidate()] },
      download: { outcome: "ok", value: payload("Committed, unrecorded.") },
    });
    const handlers = handlersFor(world, [provider], steerableSessions());

    await expect(invoke(handlers, SUBTITLE_JOB_TYPES.run)).rejects.toThrow(
      /catalogue went away/,
    );
    // The file is on the disk and the attempt is in the state that says so.
    expect(await world.sidecars()).toEqual([
      "Dune (2021) [BluRay-1080p].tur.srt",
    ]);
    expect(world.state()).toBe("validating");
    expect(world.installs).toEqual([]);

    world.failRecordInstallation = false;
    const reconciled = await invoke(handlers, SUBTITLE_JOB_TYPES.reconcile, {});

    expect(reconciled).toMatchObject({ examined: 1 });
    expect(world.state()).toBe("installed");
    expect(world.installs).toHaveLength(1);
    // Recovery re-used the file already there rather than downloading again.
    expect(provider.calls.download).toBe(1);
  });

  it("asks for a person when the receipt does not match what is on the disk", async () => {
    world = await createWorld({
      attempt: { state: "validating" },
      checkpoint: {
        intent: {
          mediaFileId: MEDIA_ID,
          language: "tur",
          flags: { forced: false, hearingImpaired: false },
          format: "srt",
          sha256: "0".repeat(64),
          sizeBytes: 10,
          cueCount: 1,
          fileIdentity: "1:1",
          operationId: ATTEMPT_ID,
        },
      },
    });
    const result = await invoke(
      handlersFor(world, [scriptedProvider({})], steerableSessions()),
      SUBTITLE_JOB_TYPES.run,
    );
    expect(result).toMatchObject({
      state: "validating",
      attention: "commit-ambiguous",
    });
    expect(world.events.map((e) => e.type)).toContain("operator-attention");
    expect(world.installs).toEqual([]);
  });

  it("leaves a finished attempt alone", async () => {
    world = await createWorld({ attempt: { state: "installed" } });
    const provider = scriptedProvider({
      search: { outcome: "ok", value: [candidate()] },
    });
    const result = await invoke(
      handlersFor(world, [provider], steerableSessions()),
      SUBTITLE_JOB_TYPES.run,
    );
    expect(result).toEqual({ state: "installed" });
    expect(provider.calls.search).toBe(0);
  });
});

describe("two workers, one film", () => {
  it("gives the second one nothing to do, and asks it back later", async () => {
    world = await createWorld();
    world.held.add(MEDIA_ID);
    const error = await invoke(
      handlersFor(world, [scriptedProvider({})], steerableSessions()),
      SUBTITLE_JOB_TYPES.run,
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(DeferredJobError);
    expect((error as DeferredJobError).retryAfterMs).toBe(5_000);
    expect(await world.sidecars()).toEqual([]);
  });

  it("refuses a task naming an attempt that is gone, permanently", async () => {
    world = await createWorld();
    world.attempts.delete(ATTEMPT_ID);
    await expect(
      invoke(
        handlersFor(world, [scriptedProvider({})], steerableSessions()),
        SUBTITLE_JOB_TYPES.run,
      ),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });
});

describe("being told to stop", () => {
  it("stops without leaving a partial file behind", async () => {
    world = await createWorld();
    let seen = 0;
    const result = await invoke(
      handlersFor(
        world,
        [
          scriptedProvider({
            search: { outcome: "ok", value: [candidate()] },
            download: { outcome: "ok", value: payload("Never lands.") },
          }),
        ],
        steerableSessions(),
      ),
      SUBTITLE_JOB_TYPES.run,
      { attemptId: ATTEMPT_ID },
      async () => ++seen > 2,
    );
    expect(result).toMatchObject({ state: "failed" });
    expect(await world.sidecars()).toEqual([]);
  });
});
