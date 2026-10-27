/**
 * The SABnzbd boundary. Every call to it happens here.
 *
 * Only the subset this phase needs: check it is there, read the queue and the
 * history, submit an NZB, and remove a job Seyirlik itself created. SABnzbd
 * exposes a great deal more, and implementing methods nothing calls would be
 * surface to keep working for no one.
 *
 * The API key travels in the query string because SABnzbd offers no other way,
 * which makes this the same problem the indexer client has: the key is added
 * at the moment of the request, and nothing from a transport failure is
 * carried into an error, because a fetch rejection stringifies to a message
 * containing the URL.
 */

export type SabErrorKind =
  | "auth"
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "bad-request"
  | "malformed-response"
  | "rejected";

export class SabError extends Error {
  readonly kind: SabErrorKind;

  constructor(kind: SabErrorKind, message: string) {
    super(message);
    this.name = "SabError";
    this.kind = kind;
  }
}

/** What a job is doing, in Seyirlik's words rather than SABnzbd's. */
export type SabJobState =
  | "queued"
  | "downloading"
  | "processing"
  | "completed"
  | "failed"
  | "paused";

export interface SabJob {
  readonly nzoId: string;
  /** The name SABnzbd shows, which is the name it was asked to use. */
  readonly name: string;
  readonly category?: string;
  readonly state: SabJobState;
  /** 0–100 where SABnzbd reports it. */
  readonly percentage?: number;
  readonly sizeBytes?: number;
  /** What is still to come down. Queue entries only. */
  readonly remainingBytes?: number;
  /** SABnzbd's own estimate. Queue entries only, and only while it can tell. */
  readonly timeLeftSeconds?: number;
  /** Place in SABnzbd's queue, from 0. */
  readonly queuePosition?: number;
  /** SABnzbd's own word for what it is doing: "Downloading", "Repairing"… */
  readonly statusText?: string;
  /** The post-processing step in progress, as SABnzbd words it. */
  readonly actionLine?: string;
  /** Where the finished bytes are. Only history entries have one. */
  readonly storagePath?: string;
  /** SABnzbd's own words about a failure. Never a credential. */
  readonly failMessage?: string;
  readonly source: "queue" | "history";
}

/** The queue as a whole: its jobs, and how fast it is moving. */
export interface SabQueueSnapshot {
  readonly jobs: SabJob[];
  /** Across the whole queue; SABnzbd does not split it per job. */
  readonly speedBytesPerSecond?: number;
  readonly paused: boolean;
  /** Still to come down, across the whole queue. */
  readonly remainingBytes?: number;
  /** Free space where SABnzbd downloads to. */
  readonly freeBytes?: number;
}

/** One news server, as SABnzbd's downloader holds it right now. */
export interface SabServerStatus {
  readonly name: string;
  /** False while SABnzbd has set the server aside after a failure. */
  readonly active: boolean;
  /** SABnzbd's last word about it, such as a refused connection. */
  readonly error?: string;
}

export interface SabSubmission {
  readonly bytes: Uint8Array;
  /** Becomes the job name, and is how a lost response is recovered. */
  readonly name: string;
  readonly category: string;
  readonly filename?: string;
}

export interface SabnzbdClient {
  /** Version string, and proof the key works. */
  version(signal?: AbortSignal): Promise<string>;
  listQueue(signal?: AbortSignal): Promise<SabJob[]>;
  /** The queue with its speed and paused state, in the same single call. */
  queueSnapshot(signal?: AbortSignal): Promise<SabQueueSnapshot>;
  listHistory(limit?: number, signal?: AbortSignal): Promise<SabJob[]>;
  /**
   * The news servers and whether SABnzbd can use them. A queue whose slots
   * all say "Downloading" moves nothing when none of these can.
   */
  servers(signal?: AbortSignal): Promise<SabServerStatus[]>;
  /** Returns the job's identifier when SABnzbd reports one. */
  submit(
    submission: SabSubmission,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
  /** Searches the queue then the history for a job by its exact name. */
  findByName(name: string, signal?: AbortSignal): Promise<SabJob | undefined>;
  getJob(nzoId: string, signal?: AbortSignal): Promise<SabJob | undefined>;
  /** Holds one queued job. The caller is responsible for it being Seyirlik's. */
  pauseJob(nzoId: string, signal?: AbortSignal): Promise<void>;
  /** Lets one held job download again. Same responsibility. */
  resumeJob(nzoId: string, signal?: AbortSignal): Promise<void>;
  /**
   * Moves a queued job to a place in the queue, from 0, and returns the place
   * SABnzbd actually gave it — which differs when a priority stands in the
   * way. Same responsibility.
   */
  moveJob(nzoId: string, index: number, signal?: AbortSignal): Promise<number>;
  /** Stops the whole queue, as SABnzbd's own pause button does. */
  pauseQueue(signal?: AbortSignal): Promise<void>;
  resumeQueue(signal?: AbortSignal): Promise<void>;
  /** Removes a job. The caller is responsible for it being Seyirlik's. */
  remove(
    nzoId: string,
    options?: { deleteFiles?: boolean; signal?: AbortSignal },
  ): Promise<void>;
}

export interface SabnzbdClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * SABnzbd's queue statuses, mapped to what Seyirlik does about them.
 *
 * `Grabbing`, `Fetching` and `Verifying` are all "it is working on it"; the
 * distinction matters to SABnzbd's own UI and not to a decision here.
 */
function queueState(status: string): SabJobState {
  const value = status.toLowerCase();
  if (value === "paused") return "paused";
  if (value === "queued" || value === "grabbing") return "queued";
  if (
    value === "verifying" ||
    value === "repairing" ||
    value === "extracting" ||
    value === "running" ||
    value === "moving"
  ) {
    return "processing";
  }
  return "downloading";
}

function historyState(status: string): SabJobState {
  const value = status.toLowerCase();
  if (value === "completed") return "completed";
  if (value === "failed") return "failed";
  // Queued/Running/Extracting appear in history while post-processing runs.
  return "processing";
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * SABnzbd's "H:MM:SS" or "D:HH:MM:SS", in seconds.
 *
 * Undefined for anything else, including the "0:00:00" it shows while it
 * cannot estimate — a zero there means "unknown", not "done".
 */
function durationSeconds(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+(?::\d+){2,3}$/.test(value)) {
    return undefined;
  }
  const units = [1, 60, 3600, 86_400];
  const seconds = value
    .split(":")
    .reverse()
    .reduce((sum, part, index) => sum + Number(part) * units[index]!, 0);
  return seconds > 0 ? seconds : undefined;
}

/** Megabytes as SABnzbd reports them, in bytes. */
function megabytesToBytes(value: unknown): number | undefined {
  const mb = toNumber(value);
  return mb === undefined ? undefined : Math.round(mb * 1024 * 1024);
}

export function createSabnzbdClient({
  baseUrl,
  apiKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
}: SabnzbdClientOptions): SabnzbdClient {
  if (!apiKey.trim()) throw new Error("SABnzbd needs an API key.");
  const endpoint = new URL(
    "api",
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  );

  async function call(
    params: Record<string, string>,
    signal: AbortSignal | undefined,
    body?: FormData,
  ): Promise<unknown> {
    const url = new URL(endpoint);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set("output", "json");
    url.searchParams.set("apikey", apiKey);

    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        ...(body ? { method: "POST", body } : {}),
      });
      if (response.status === 401 || response.status === 403) {
        throw new SabError("auth", "SABnzbd refused the key.");
      }
      if (!response.ok) {
        throw new SabError(
          response.status >= 500 ? "unavailable" : "bad-request",
          `SABnzbd answered ${response.status}.`,
        );
      }
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new SabError(
          "malformed-response",
          "SABnzbd's response is implausibly large.",
        );
      }
      /*
       * A wrong key is reported with HTTP 200 and a plain-text body, so a
       * status check alone would read it as a successful empty queue.
       */
      if (
        /api key incorrect|api key required|access denied/i.test(
          text.slice(0, 200),
        )
      ) {
        throw new SabError("auth", "SABnzbd refused the key.");
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new SabError(
          "malformed-response",
          "SABnzbd did not answer with JSON.",
        );
      }
    } catch (error) {
      if (error instanceof SabError) throw error;
      if (signal?.aborted) {
        throw new SabError("cancelled", "The request was cancelled.");
      }
      if (timedOut || (error instanceof Error && error.name === "AbortError")) {
        throw new SabError("timeout", "SABnzbd did not answer in time.");
      }
      // Deliberately nothing from the original: it contains the URL, and the
      // URL contains the key.
      throw new SabError("unavailable", "SABnzbd could not be reached.");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  function parseQueue(payload: unknown): SabJob[] {
    const slots = (payload as { queue?: { slots?: unknown } })?.queue?.slots;
    if (!Array.isArray(slots)) return [];
    return slots.flatMap((raw): SabJob[] => {
      const slot = raw as Record<string, unknown>;
      const nzoId = typeof slot.nzo_id === "string" ? slot.nzo_id : "";
      if (!nzoId) return [];
      const total = megabytesToBytes(slot.mb);
      const remaining = megabytesToBytes(slot.mbleft);
      const timeLeft = durationSeconds(slot.timeleft);
      const position = toNumber(slot.index);
      const status = typeof slot.status === "string" ? slot.status : "";
      return [
        {
          nzoId,
          name: typeof slot.filename === "string" ? slot.filename : "",
          ...(typeof slot.cat === "string" ? { category: slot.cat } : {}),
          state: queueState(status),
          ...(toNumber(slot.percentage) === undefined
            ? {}
            : { percentage: toNumber(slot.percentage)! }),
          ...(total === undefined ? {} : { sizeBytes: total }),
          ...(remaining === undefined ? {} : { remainingBytes: remaining }),
          ...(timeLeft === undefined ? {} : { timeLeftSeconds: timeLeft }),
          ...(position === undefined ? {} : { queuePosition: position }),
          ...(status ? { statusText: status } : {}),
          source: "queue",
        },
      ];
    });
  }

  function parseQueueSnapshot(payload: unknown): SabQueueSnapshot {
    const queue = (payload as { queue?: Record<string, unknown> })?.queue;
    // KB/s, in SABnzbd's binary kilobytes.
    const kilobytes = toNumber(queue?.kbpersec);
    const remaining = megabytesToBytes(queue?.mbleft);
    // GB, in SABnzbd's binary gigabytes.
    const freeGigabytes = toNumber(queue?.diskspace1);
    return {
      jobs: parseQueue(payload),
      ...(kilobytes === undefined
        ? {}
        : { speedBytesPerSecond: Math.round(kilobytes * 1024) }),
      paused: queue?.paused === true || queue?.paused === "true",
      ...(remaining === undefined ? {} : { remainingBytes: remaining }),
      ...(freeGigabytes === undefined
        ? {}
        : { freeBytes: Math.round(freeGigabytes * 1024 ** 3) }),
    };
  }

  function parseHistory(payload: unknown): SabJob[] {
    const slots = (payload as { history?: { slots?: unknown } })?.history
      ?.slots;
    if (!Array.isArray(slots)) return [];
    return slots.flatMap((raw): SabJob[] => {
      const slot = raw as Record<string, unknown>;
      const nzoId = typeof slot.nzo_id === "string" ? slot.nzo_id : "";
      if (!nzoId) return [];
      const failMessage =
        typeof slot.fail_message === "string" && slot.fail_message.trim()
          ? slot.fail_message.trim()
          : undefined;
      return [
        {
          nzoId,
          name: typeof slot.name === "string" ? slot.name : "",
          ...(typeof slot.category === "string"
            ? { category: slot.category }
            : {}),
          state: historyState(
            typeof slot.status === "string" ? slot.status : "",
          ),
          ...(toNumber(slot.bytes) === undefined
            ? {}
            : { sizeBytes: toNumber(slot.bytes)! }),
          ...(typeof slot.storage === "string" && slot.storage
            ? { storagePath: slot.storage }
            : {}),
          ...(failMessage === undefined ? {} : { failMessage }),
          ...(typeof slot.status === "string" && slot.status
            ? { statusText: slot.status }
            : {}),
          ...(typeof slot.action_line === "string" && slot.action_line.trim()
            ? { actionLine: slot.action_line.trim() }
            : {}),
          source: "history",
        },
      ];
    });
  }

  return {
    async version(signal) {
      const payload = await call({ mode: "version" }, signal);
      const version = (payload as { version?: unknown })?.version;
      if (typeof version !== "string") {
        throw new SabError("malformed-response", "SABnzbd gave no version.");
      }
      return version;
    },

    async listQueue(signal) {
      return parseQueue(await call({ mode: "queue", limit: "500" }, signal));
    },

    async queueSnapshot(signal) {
      return parseQueueSnapshot(
        await call({ mode: "queue", limit: "500" }, signal),
      );
    },

    async listHistory(limit = 200, signal) {
      return parseHistory(
        await call({ mode: "history", limit: String(limit) }, signal),
      );
    },

    async servers(signal) {
      // The dashboard is SABnzbd measuring its own machine; nothing here
      // needs it, and it is the slow part of the answer.
      const payload = await call(
        { mode: "status", skip_dashboard: "1" },
        signal,
      );
      const servers = (payload as { status?: { servers?: unknown } })?.status
        ?.servers;
      if (!Array.isArray(servers)) return [];
      return servers.flatMap((raw): SabServerStatus[] => {
        const server = raw as Record<string, unknown>;
        const name =
          typeof server.servername === "string" ? server.servername : "";
        if (!name) return [];
        const error =
          typeof server.servererror === "string" && server.servererror.trim()
            ? server.servererror.trim()
            : undefined;
        return [
          {
            name,
            active:
              server.serveractive === true || server.serveractive === "true",
            ...(error === undefined ? {} : { error }),
          },
        ];
      });
    },

    async submit(submission, signal) {
      const form = new FormData();
      form.set(
        "nzbfile",
        new Blob([submission.bytes as BlobPart], { type: "application/x-nzb" }),
        submission.filename ?? `${submission.name}.nzb`,
      );
      const payload = await call(
        {
          mode: "addfile",
          // The name is the recovery handle: a response lost after SABnzbd
          // accepted the file leaves a job findable only by this.
          nzbname: submission.name,
          cat: submission.category,
        },
        signal,
        form,
      );
      const result = payload as {
        status?: unknown;
        nzo_ids?: unknown;
        error?: unknown;
      };
      if (result.status === false) {
        const detail =
          typeof result.error === "string"
            ? result.error
            : "SABnzbd refused the NZB.";
        throw new SabError("rejected", detail);
      }
      const ids = Array.isArray(result.nzo_ids) ? result.nzo_ids : [];
      const first = ids.find(
        (value): value is string => typeof value === "string",
      );
      // Undefined is not a failure: SABnzbd accepted it, and the caller
      // recovers the identifier by looking for the name.
      return first;
    },

    async findByName(name, signal) {
      const queued = (await this.listQueue(signal)).find(
        (job) => job.name === name,
      );
      if (queued) return queued;
      return (await this.listHistory(200, signal)).find(
        (job) => job.name === name,
      );
    },

    async getJob(nzoId, signal) {
      const queued = (await this.listQueue(signal)).find(
        (job) => job.nzoId === nzoId,
      );
      if (queued) return queued;
      return (await this.listHistory(200, signal)).find(
        (job) => job.nzoId === nzoId,
      );
    },

    async pauseJob(nzoId, signal) {
      if (!nzoId) throw new SabError("bad-request", "No job was named.");
      await call({ mode: "queue", name: "pause", value: nzoId }, signal);
    },

    async resumeJob(nzoId, signal) {
      if (!nzoId) throw new SabError("bad-request", "No job was named.");
      await call({ mode: "queue", name: "resume", value: nzoId }, signal);
    },

    async moveJob(nzoId, index, signal) {
      if (!nzoId) throw new SabError("bad-request", "No job was named.");
      if (!Number.isInteger(index) || index < 0) {
        throw new SabError("bad-request", "A queue place starts at 0.");
      }
      /*
       * `switch` takes a second job or, as here, a place in the queue. It
       * answers with where the job ended up, or -1 when it found no such job.
       */
      const payload = await call(
        { mode: "switch", value: nzoId, value2: String(index) },
        signal,
      );
      const position = toNumber(
        (payload as { result?: { position?: unknown } })?.result?.position,
      );
      if (position === undefined || position < 0) {
        throw new SabError("rejected", "SABnzbd did not move the job.");
      }
      return position;
    },

    async pauseQueue(signal) {
      await call({ mode: "pause" }, signal);
    },

    async resumeQueue(signal) {
      await call({ mode: "resume" }, signal);
    },

    async remove(nzoId, options = {}) {
      if (!nzoId) throw new SabError("bad-request", "No job was named.");
      // Both lists: a job may have moved to history between the decision to
      // remove it and this call.
      await call(
        {
          mode: "queue",
          name: "delete",
          value: nzoId,
          del_files: options.deleteFiles ? "1" : "0",
        },
        options.signal,
      ).catch((error: unknown) => {
        if (error instanceof SabError && error.kind === "bad-request") return;
        throw error;
      });
      await call(
        {
          mode: "history",
          name: "delete",
          value: nzoId,
          del_files: options.deleteFiles ? "1" : "0",
        },
        options.signal,
      ).catch((error: unknown) => {
        if (error instanceof SabError && error.kind === "bad-request") return;
        throw error;
      });
    },
  };
}

/**
 * What SABnzbd's failure message amounts to.
 *
 * Its wording is not a stable API, so this is a best effort that falls back to
 * "unknown" rather than guessing — and "unknown" is terminal, so a
 * misclassification stops rather than looping.
 */
export function classifySabFailure(
  message: string | undefined,
):
  | "missing-articles"
  | "repair-failed"
  | "unpack-failed"
  | "password-required"
  | "disk-full"
  | "unknown" {
  const value = (message ?? "").toLowerCase();
  if (!value) return "unknown";
  if (value.includes("password")) return "password-required";
  if (value.includes("out of disk") || value.includes("no space"))
    return "disk-full";
  if (value.includes("unpack") || value.includes("extraction"))
    return "unpack-failed";
  if (value.includes("repair") || value.includes("par2"))
    return "repair-failed";
  if (
    value.includes("missing article") ||
    value.includes("not enough") ||
    value.includes("aborted")
  ) {
    return "missing-articles";
  }
  return "unknown";
}
