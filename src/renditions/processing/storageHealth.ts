/**
 * Whether a volume may be worked against at all, and what it takes to say yes
 * again once the answer has been no.
 *
 * The watchdog beside this file answers a narrow question — is the root there,
 * readable, and still the same device — and that question was enough while the
 * only failure being modelled was a cable pulled out of a healthy disk. It is
 * not enough for the failure that motivated this file.
 *
 * What happened: a USB-attached drive began returning `EIO` from the SCSI block
 * layer. The mount stayed. Every path still resolved. `stat` and `readdir` on
 * the media root answered instantly, because directory metadata was cached and
 * intact. By every test the watchdog knows how to run, the storage was *fine* —
 * so after the machine was force-restarted, a job left `running` by the unclean
 * shutdown was requeued within seconds of login, FFmpeg went back at the same
 * region, and the kernel re-entered a retry sequence that took the whole
 * machine down a second time.
 *
 * The lesson is that availability and health are different questions, and only
 * one of them can be answered by looking. Health has to be *remembered*: it is
 * inferred from what failed, it outlives the process that observed it, and it
 * is cleared by a person rather than by a poll. This file is the memory and the
 * rules; the storage a rule is about is never touched from here.
 *
 * Deliberately pure. Everything that reads a disk, writes a row, or spawns a
 * process lives above it, so the policy can be exercised exhaustively without a
 * volume to exercise it against — which is the only way this could be tested at
 * all, the drive that produced the evidence being the one thing no test may go
 * near.
 */

import type { ProcessingFailureKind } from "../adaptive/epochs/failure";

/**
 * What a root is allowed to be asked to do.
 *
 * Ordered by severity, and the order is load-bearing: an observation may always
 * move a root to a worse state, and only an explicit operator action may move
 * it back. That asymmetry is the whole safety property. A poll that finds the
 * path readable is evidence of nothing, and letting it clear a quarantine is
 * exactly the bug that let a failing drive be attacked twice.
 */
export type StorageHealthState =
  /** Answering, no failure on record. Work may start. */
  | "healthy"
  /**
   * Gone, cleanly. The path does not resolve, or resolves to a different
   * device. Nothing about the storage is suspected — a drive that is unplugged
   * is not a drive that is broken — so the same volume returning and staying
   * put is enough to make it healthy again without anyone being asked.
   */
  | "unavailable"
  /**
   * One genuinely ambiguous signal has been seen and is not yet decisive.
   *
   * Work in flight is stopped and nothing new starts, but the incident may age
   * out because no storage failure has actually been established. `EIO`,
   * `ENXIO`, an FFmpeg input I/O error, active device loss, and a confirmed
   * source-read timeout never enter this state.
   */
  | "suspect"
  /**
   * A storage fault has been established. No work of any kind starts here, no
   * process is spawned against it, and no restart of anything — the worker, the
   * server, the machine — changes that. Only an operator does.
   */
  | "quarantined"
  /**
   * An operator has verified the storage and it has passed. The block on new
   * work stands until they also say "resume", so that reconnecting a drive is
   * never on its own the thing that restarts a 4K encode against it.
   */
  | "recovery-pending";

/** Whether a state permits starting new work against the root. */
export function mayStartWork(state: StorageHealthState): boolean {
  return state === "healthy";
}

/**
 * Whether a state demands that whatever is running be stopped.
 *
 * `unavailable` is included: an encoder whose volume has gone is writing
 * through descriptors that no longer point anywhere useful, and the existing
 * recovery path already handles it. `recovery-pending` is not — nothing is
 * running there by construction, and the operator is mid-flow.
 */
export function demandsStop(state: StorageHealthState): boolean {
  return (
    state === "unavailable" || state === "suspect" || state === "quarantined"
  );
}

/**
 * Whether the same volume returning is enough to start work again.
 *
 * True only for the clean case. Everything else has a fault on record, and a
 * fault on record is cleared by a person.
 */
export function resumesAutomatically(state: StorageHealthState): boolean {
  return state === "unavailable";
}

/**
 * What was observed, in the vocabulary the observer actually has.
 *
 * Each of these is something a caller can genuinely tell without inventing a
 * diagnosis: an errno it caught, a verdict the existing classifier reached, a
 * timeout its own clock measured. The mapping from these to a state is this
 * file's job and nobody else's, so no caller has to know that `ENXIO` is worse
 * than `ENOENT`.
 */
export type StorageObservation =
  /** Every root answered. */
  | { kind: "ok" }
  /**
   * A root is not there, or is a different device. Names them, for the page.
   *
   * The *clean* case, and deliberately the only failure observation that keeps
   * automatic recovery. It is what the watchdog reports when it finds a mount
   * point empty — an ejected drive, a volume not mounted yet at login — and
   * nothing about it says the storage is faulty. A drive that is unplugged is
   * not a drive that is broken.
   */
  | { kind: "absent"; roots: readonly string[] }
  /**
   * The storage path itself failed a transfer: `EIO`, `ESTALE`, or FFmpeg
   * reporting `Input/output error`.
   *
   * **Established, not suspected.** This is the observation that quarantines on
   * its first occurrence, and the reason is the incident: one of these means the
   * kernel has already been through its retry sequence and given up, which on
   * the drive that motivated this took 35–37 seconds *per sector* and ended in
   * a machine that had to be powered off. Asking for a second one before acting
   * is asking to pay that cost again in order to learn something already known.
   */
  | { kind: "hard-io-fault"; detail: string }
  /**
   * The device went away underneath work that was in flight: `ENXIO`,
   * `ENODEV`, `Device not configured`.
   *
   * Distinct from `absent`, and hard rather than clean, because of *when* it is
   * observed. A volume found missing by a poll has probably been ejected; a
   * volume that vanishes out from under an active read has not been ejected,
   * something failed — a bridge, a cable, a port, a power rail — and that is
   * precisely the fault chain this system cannot diagnose and must not retry.
   */
  | { kind: "device-lost"; detail: string }
  /**
   * A bounded, targeted read of the source did not answer inside its window.
   *
   * Hard. A probe that never returned did not fail to establish anything — it
   * entered the same kernel recovery as the encode it was diagnosing, which is
   * the evidence, arrived at a second time.
   */
  | { kind: "read-timeout"; detail: string }
  /**
   * Something went wrong that *might* be the storage, and might not.
   *
   * This is the only channel that corroborates and the only one that lapses.
   * It exists for signals where a storage fault has genuinely not been
   * established — not as a softer landing for ones that have. Nothing that
   * names an errno from the sets above may arrive here.
   */
  | { kind: "soft-fault"; detail: string }
  /**
   * The encoder stopped producing while the source read perfectly.
   *
   * Present so that callers can report it without having to know that it is
   * *not* storage evidence. Preserving that distinction is a hard requirement:
   * a deadlocked filter graph must never quarantine a healthy disk, and a
   * healthy disk must never be blamed for one.
   */
  | { kind: "encoder-stall"; detail: string }
  /**
   * The process or the host went down while an encode was running here, and
   * came back to find the job still marked running.
   *
   * On its own this is not proof of a storage fault — a power cut is not a bad
   * sector — but it is proof that nothing observed how the last attempt ended,
   * and "nobody knows" is not a state in which to start a 4K encode against an
   * external drive. It parks rather than quarantining.
   */
  | { kind: "unclean-restart"; detail: string };

/**
 * Whether an observation establishes a storage fault by itself.
 *
 * The whole hard/soft distinction reduces to this predicate, so there is one
 * place to read and one place to change. An earlier version of this file
 * required two faults of *any* kind before quarantining, which meant a
 * confirmed `EIO` bought a second trip into the kernel retry path in order to
 * corroborate something the first one had already proved.
 */
export function establishesStorageFault(
  observation: StorageObservation,
): observation is
  | { kind: "hard-io-fault"; detail: string }
  | { kind: "device-lost"; detail: string }
  | { kind: "read-timeout"; detail: string } {
  return (
    observation.kind === "hard-io-fault" ||
    observation.kind === "device-lost" ||
    observation.kind === "read-timeout"
  );
}

/**
 * How long an *unestablished* fault keeps a root suspect before it lapses.
 *
 * Applies to `soft-fault` and to nothing else. A hard fault does not use this
 * window, does not wait for a second opinion, and does not lapse — it already
 * *is* the second opinion, the kernel having exhausted its own retries before
 * returning the error at all.
 */
export const SUSPECT_WINDOW_MS = 10 * 60_000;

/**
 * Soft faults inside the window that turn a suspicion into a finding.
 *
 * Two, and only for the ambiguous channel. Hard evidence quarantines at one.
 */
export const QUARANTINE_AFTER_SOFT_FAULTS = 2;

const HARD_FAULT_PREFIX: Readonly<
  Record<"hard-io-fault" | "device-lost" | "read-timeout", string>
> = {
  "hard-io-fault": "The storage reported a hard I/O failure.",
  "device-lost": "The storage device disappeared during active work.",
  "read-timeout": "A bounded source read did not answer.",
};

/**
 * How long the same volume must be continuously present before an
 * `unavailable` root is called healthy again.
 *
 * A drive that is coming and going under a failing cable presents as a rapid
 * series of clean disappearances, and treating each return as a recovery is how
 * a queue ends up starting an encode into a volume that is about to leave
 * again. It has to stay.
 */
export const STABILITY_SETTLE_MS = 60_000;

export interface StorageHealthRecord {
  /** The root this is about, as configured. */
  root: string;
  state: StorageHealthState;
  /** Why it is in this state, in one clause, safe to show. */
  reason: string;
  /** Consecutive I/O faults inside the suspect window. */
  faultCount: number;
  firstFaultAtMs: number | null;
  lastFaultAtMs: number | null;
  /** When it entered the current state. */
  changedAtMs: number;
  /** When an operator's verification passed, if one has. */
  verifiedAtMs: number | null;
  /** Roots that failed their last availability check. */
  missingRoots: readonly string[];
  /**
   * Set when the last transition was *away* from a state a person had to clear.
   *
   * Kept so the audit trail can distinguish "never had a problem" from "had one
   * and it was cleared", which is the difference between a drive to trust and a
   * drive to watch.
   */
  clearedAtMs: number | null;
}

export function initialStorageHealth(
  root: string,
  nowMs: number,
): StorageHealthRecord {
  return {
    root,
    state: "healthy",
    reason: "No storage fault has been recorded.",
    faultCount: 0,
    firstFaultAtMs: null,
    lastFaultAtMs: null,
    changedAtMs: nowMs,
    verifiedAtMs: null,
    missingRoots: [],
    clearedAtMs: null,
  };
}

/**
 * An operator action. The only thing that can improve a root's state.
 *
 * `verify` is deliberately separate from `resume`. Verification is cheap and
 * safe — a stat, a directory listing, a device identity, nothing that reads
 * media — and passing it does not mean anyone has decided the hardware is
 * fixed. That decision is `resume`, and it is a second, explicit press.
 */
export type StorageOperatorAction =
  | { kind: "verify-passed"; detail: string }
  | { kind: "verify-failed"; detail: string }
  | { kind: "resume"; detail: string };

/**
 * Folds one observation into a root's health.
 *
 * Total, deterministic, and monotone downwards: given the same record and the
 * same observation it returns the same record, and it never returns a better
 * state than it was given. Improvement goes through `applyOperatorAction`.
 */
export function applyStorageObservation(
  record: StorageHealthRecord,
  observation: StorageObservation,
  nowMs: number,
): StorageHealthRecord {
  /*
   * A quarantine is final until a person lifts it. Nothing observed can make it
   * better, and there is nothing worse for it to become, so every observation
   * short of a fresh fault leaves it exactly as it is — including, importantly,
   * an `ok` from a poll that found the path readable. That poll is what a
   * failing drive looks like between retry storms.
   */
  if (record.state === "quarantined") {
    if (
      establishesStorageFault(observation) ||
      observation.kind === "soft-fault"
    ) {
      return {
        ...record,
        faultCount: record.faultCount + 1,
        lastFaultAtMs: nowMs,
      };
    }
    return record;
  }

  /*
   * Established evidence, acted on at once and before every other branch.
   *
   * Placed above the switch rather than inside it so that no future case
   * ordering can accidentally route a hard fault through the corroboration
   * path. That is not a hypothetical: the first version of this file put hard
   * and ambiguous evidence through one counter, so a confirmed `EIO` was
   * *required to happen twice* before anything stopped — which on the drive
   * this exists for means a second forty-second kernel retry sequence bought
   * purely to re-learn what the first one had proved.
   *
   * It also deliberately ignores the current state. A hard fault quarantines a
   * healthy root, a suspect root, and a root an operator verified thirty
   * seconds ago, because none of those are evidence against an error the kernel
   * has already given up on.
   */
  if (establishesStorageFault(observation)) {
    return {
      ...record,
      state: "quarantined",
      reason: `${HARD_FAULT_PREFIX[observation.kind]} ${observation.detail}`,
      faultCount: record.faultCount + 1,
      firstFaultAtMs: record.firstFaultAtMs ?? nowMs,
      lastFaultAtMs: nowMs,
      changedAtMs: nowMs,
      /*
       * Any earlier verification is void. It attested to a volume that has
       * since failed a transfer, so leaving it set would let the operator's
       * next press be `resume` without a fresh check.
       */
      verifiedAtMs: null,
    };
  }

  switch (observation.kind) {
    case "encoder-stall":
      /*
       * Not storage evidence, and saying so is the point. The encoder is the
       * suspect here; the disk answered every read it was given. Turning this
       * into a quarantine would take a library offline over a filter-graph bug,
       * and — worse — would teach an operator that quarantines mean nothing.
       */
      return record;

    case "ok": {
      if (record.state === "healthy") return record;
      if (record.state === "unavailable") {
        /*
         * The clean case, and the only automatic recovery in this file. The
         * volume has to have been continuously present for the settling period
         * before it counts, which is what stops a flapping cable from being
         * read as a series of recoveries.
         */
        if (nowMs - record.changedAtMs < STABILITY_SETTLE_MS) return record;
        return {
          ...record,
          state: "healthy",
          reason: "The volume returned and has stayed present.",
          missingRoots: [],
          changedAtMs: nowMs,
          faultCount: 0,
          firstFaultAtMs: null,
          lastFaultAtMs: null,
        };
      }
      if (record.state === "suspect") {
        /*
         * A lone fault lapses. It has to: a suspect state that only ever
         * escalated would accumulate one blip a month into a quarantine, and an
         * operator who has watched that happen stops believing the mechanism.
         */
        const since = record.lastFaultAtMs ?? record.changedAtMs;
        if (nowMs - since < SUSPECT_WINDOW_MS) return record;
        return {
          ...record,
          state: "healthy",
          reason:
            "The volume has answered normally since the ambiguous signal, which has lapsed.",
          faultCount: 0,
          firstFaultAtMs: null,
          lastFaultAtMs: null,
          changedAtMs: nowMs,
        };
      }
      // `recovery-pending` waits for the operator's second press, not for a poll.
      return record;
    }

    case "absent": {
      /*
       * A root that is merely gone while a fault is on record does not get to
       * *downgrade* the record to the gentler state — a suspect drive that is
       * unplugged is still a suspect drive when it comes back.
       */
      if (record.state === "suspect" || record.state === "recovery-pending") {
        return { ...record, missingRoots: [...observation.roots] };
      }
      if (record.state === "unavailable") {
        // Still gone. The settling clock must not be restarted by every poll.
        return { ...record, missingRoots: [...observation.roots] };
      }
      return {
        ...record,
        state: "unavailable",
        reason:
          observation.roots.length > 0
            ? `${observation.roots.join(", ")} is not available.`
            : "The storage is not available.",
        missingRoots: [...observation.roots],
        changedAtMs: nowMs,
      };
    }

    case "soft-fault": {
      const faultCount = record.faultCount + 1;
      const firstFaultAtMs = record.firstFaultAtMs ?? nowMs;
      /*
       * A fault that arrives long after the previous one is a first fault, not
       * a second. Without this the counter is a lifetime total and any drive
       * eventually reaches two.
       */
      const withinWindow =
        record.lastFaultAtMs !== null &&
        nowMs - record.lastFaultAtMs <= SUSPECT_WINDOW_MS;
      const effectiveCount = withinWindow ? faultCount : 1;

      if (effectiveCount >= QUARANTINE_AFTER_SOFT_FAULTS) {
        return {
          ...record,
          state: "quarantined",
          reason: `The storage reported repeated ambiguous failures. ${observation.detail}`,
          faultCount: effectiveCount,
          firstFaultAtMs: withinWindow ? firstFaultAtMs : nowMs,
          lastFaultAtMs: nowMs,
          changedAtMs: nowMs,
          verifiedAtMs: null,
        };
      }
      return {
        ...record,
        state: "suspect",
        reason: `The storage reported an ambiguous failure. ${observation.detail}`,
        faultCount: effectiveCount,
        firstFaultAtMs: withinWindow ? firstFaultAtMs : nowMs,
        lastFaultAtMs: nowMs,
        changedAtMs: nowMs,
      };
    }

    case "unclean-restart": {
      /*
       * Parks rather than condemns. There is no evidence of a bad disk here —
       * only evidence that nothing watched the last attempt end — and the right
       * response to "nobody knows" is to ask, not to guess in either direction.
       */
      if (record.state === "suspect") return record;
      return {
        ...record,
        state: "recovery-pending",
        reason: `Work was interrupted by an unclean shutdown. ${observation.detail}`,
        changedAtMs: nowMs,
        verifiedAtMs: null,
      };
    }
  }
}

/**
 * Folds an operator action in. The only path back to `healthy`.
 *
 * A failed verification is worth recording rather than ignoring: it is the
 * operator telling the system that the hardware is still bad, which is stronger
 * evidence than any poll, and it must not leave a `recovery-pending` root
 * looking one press away from running a 4K encode.
 */
export function applyOperatorAction(
  record: StorageHealthRecord,
  action: StorageOperatorAction,
  nowMs: number,
): StorageHealthRecord {
  switch (action.kind) {
    case "verify-failed":
      return {
        ...record,
        state: "quarantined",
        reason: `Verification failed. ${action.detail}`,
        changedAtMs: nowMs,
        verifiedAtMs: null,
      };
    case "verify-passed":
      if (record.state === "healthy") return record;
      return {
        ...record,
        state: "recovery-pending",
        reason: `Verified by an operator. ${action.detail}`,
        changedAtMs:
          record.state === "recovery-pending" ? record.changedAtMs : nowMs,
        verifiedAtMs: nowMs,
      };
    case "resume":
      /*
       * Resume only ever follows a passing verification. Allowing a quarantined
       * root to be resumed directly would make the verify step decorative, and
       * the whole value of the two-press flow is that the cheap safe check has
       * definitely been run against the hardware as it is *now*.
       */
      if (record.state !== "recovery-pending") return record;
      return {
        ...record,
        state: "healthy",
        reason: `Resumed by an operator. ${action.detail}`,
        faultCount: 0,
        firstFaultAtMs: null,
        lastFaultAtMs: null,
        changedAtMs: nowMs,
        clearedAtMs: nowMs,
      };
  }
}

/**
 * Turns the existing failure classification into an observation.
 *
 * The classifier above this is already good at deciding *what* failed; this
 * only decides what that means for the volume. Kept as its own function so the
 * two vocabularies stay independent — a new failure kind should be a compile
 * error here, not a silent `unknown` that quietly fails to quarantine anything.
 */
export function observationForFailure(
  kind: ProcessingFailureKind,
  detail: string,
): StorageObservation {
  switch (kind) {
    case "storage-device-lost":
      return { kind: "device-lost", detail };
    case "storage-io":
      return { kind: "hard-io-fault", detail };
    case "storage-soft-fault":
      return { kind: "soft-fault", detail };
    case "storage-unavailable":
      /*
       * Ambiguous by nature, and resolved by the errno rather than the kind. The
       * classifier uses this one label for both "the volume left" and "the
       * volume is here and returning EIO", because from the encoder's seat they
       * are the same event. They are not the same event to this file.
       */
      return looksLikeHardIoFault(detail)
        ? { kind: "hard-io-fault", detail }
        : { kind: "absent", roots: [] };
    case "source-io":
      return /(?:timed? out|did not answer|watchdog)/i.test(detail)
        ? { kind: "read-timeout", detail }
        : { kind: "hard-io-fault", detail };
    case "media-progress-timeout":
      return { kind: "encoder-stall", detail };
    case "network-read-stall":
      /*
       * A cloud mount that was slow to fetch. Counting it as a fault, even a
       * soft one, would let two busy evenings quarantine a library whose
       * storage never lost a byte.
       */
      return { kind: "ok" };
    case "source-missing":
      return { kind: "absent", roots: [] };
    case "out-of-space":
    case "encoder":
    case "unknown":
      /*
       * None of these say anything about the storage. A full disk is a full
       * disk, a crashed encoder is a crashed encoder, and quarantining a healthy
       * volume for either would stop a library over a bug.
       */
      return { kind: "ok" };
  }
}

/**
 * Errno spellings that mean a transfer physically failed, as opposed to a path
 * that is simply not there.
 *
 * Narrower than the classifier's list on purpose: `ENOENT` is absent from it,
 * because a missing path is the ordinary shape of a clean unmount and must stay
 * automatically recoverable.
 */
const HARD_IO_PATTERNS: readonly RegExp[] = [
  /\bEIO\b/,
  /Input\/output error/i,
  /\bENXIO\b/,
  /\bENODEV\b/,
  /\bESTALE\b/,
  /Stale file handle/i,
  /Device not configured/i,
  /Transport endpoint is not connected/i,
  /I\/O error/i,
];

export function looksLikeHardIoFault(message: string): boolean {
  return HARD_IO_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * The sentence shown where the state is displayed.
 *
 * Written here rather than at each call site so that an operator meets the same
 * words on the processing page, in the job history and in the log, and so that
 * no caller can accidentally describe a quarantine as something that will clear
 * itself.
 */
export function describeStorageHealth(record: StorageHealthRecord): string {
  switch (record.state) {
    case "healthy":
      return "The storage is answering normally.";
    case "unavailable":
      return record.missingRoots.length > 0
        ? `Waiting for ${record.missingRoots.join(", ")} to return. Work resumes on its own once it is back and has stayed.`
        : "Waiting for the storage to return. Work resumes on its own once it is back and has stayed.";
    case "suspect":
      return "An ambiguous storage signal was reported, so work here has stopped while it is corroborated.";
    case "quarantined":
      return "Storage was quarantined after an I/O failure to protect the server. Processing will not resume automatically.";
    case "recovery-pending":
      return "Verified, and waiting for an operator to resume. Nothing runs here until they do.";
  }
}
