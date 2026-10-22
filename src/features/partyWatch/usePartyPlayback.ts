import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { partyLog } from "./partyDiagnostics";
import type { PartySession, PartySessionState } from "./partySession";
import {
  catchUpLeadMs,
  driftCorrection,
  groupTarget,
  nextSeekCostMs,
  PARTY_SYNC_TUNING as tuning,
} from "./partySyncPolicy";
import type {
  PartyCommand,
  PartyParticipantStatus,
  PartySnapshot,
} from "./partyWatchTypes";

/**
 * Keeps one `<video>` element with its party.
 *
 * Ownership is the whole design. The group decides what should be happening
 * (the server's snapshot); this engine is the only thing that makes the
 * element do it; and the viewer's intent reaches the group only through the
 * explicit actions below — never by inferring it from element events. That is
 * what rules out feedback loops: when the engine seeks or pauses the element,
 * the events that follow are not read as anyone's request, because events are
 * never read as requests at all.
 *
 * Changes arrive two ways and are handled differently:
 * - A new revision from the group is applied once, when first seen: pause,
 *   move, schedule a start, or catch up.
 * - Between revisions the engine only measures: while the group plays, it
 *   closes drift gently (rate) or, if too far, catches up (seek ahead, wait,
 *   play). It never re-applies play or pause on its own schedule, so it never
 *   fights the player's own work — a quality switch, an audio-track reload.
 *
 * While this tab has a command in flight, its optimistic local change stands
 * and snapshots are not applied, so rapid presses never flicker through the
 * group's intermediate states. The group's answer is applied the moment the
 * last command settles; a command that failed is undone by that same step.
 */

export type PartyLocalState =
  /** Playing along, or paused with the group. */
  | "in-sync"
  /** Waiting for the group to start, or getting ready at its position. */
  | "syncing"
  /** Seeked ahead of a moving group and waiting for it to arrive. */
  | "catching-up"
  /** The browser refused to start playback until the viewer taps. */
  | "blocked"
  /** The player paused itself while the group plays on. */
  | "paused-locally";

export interface PartyPlayback {
  /**
   * In a party whose state this tab has: controls go to the group. Otherwise
   * the same controls drive the element directly — every player control routes
   * through here, party or not.
   */
  isActive: boolean;
  localState: PartyLocalState;
  /** A start this tab asked for, or a coordinated start, is pending. */
  isStartPending: boolean;
  togglePlay(): void;
  seekTo(seconds: number): void;
  seekBy(seconds: number): void;
  /** Moves the whole party to another title. */
  changeItem(itemId: string): void;
  /** Joins the group's playback after a block or a local pause. */
  resumeWithParty(): void;
}

interface UsePartyPlaybackOptions {
  session: PartySession | null;
  state: PartySessionState | null;
  videoRef: RefObject<HTMLVideoElement>;
  /** Changes when the active element is replaced (quality handoff). */
  elementEpoch: number;
  /** The title this page is showing. */
  itemId: string;
  /**
   * The title of the source actually attached to the element. It trails
   * `itemId` while a new title loads, and until it catches up the element is
   * still showing the old one — whatever its readiness says.
   */
  attachedItemIdRef: RefObject<string | null>;
  refreshProgress: () => void;
  onFollowItem: (itemId: string) => void;
}

interface EngineMemory {
  appliedEpoch: string | null;
  appliedRevision: number;
  /** What the engine last asked the element to do. */
  intent: "play" | "pause" | null;
  playPending: boolean;
  /** When the engine last called `play()`, to learn how long starting takes. */
  playRequestedAt: number | null;
  /** How long this element takes from `play()` to moving. Learned. */
  playStartMs: number;
  blocked: boolean;
  /** Target this tab is waiting at while a moving group catches up to it. */
  catchUpAtMs: number | null;
  correcting: boolean;
  /** How far off this player was when the running correction began. */
  correctionFromMs: number;
  /**
   * A rate correction made the drift worse: this element stalls rather than
   * running fast or slow (seen with HLS in Safari), so it stays at 1×.
   */
  rateUnusable: boolean;
  lastSeekAt: number;
  seekStartedAt: number | null;
  seekCostMs: number;
  stalledSince: number | null;
  pausedSince: number | null;
  unexpectedPauseSince: number | null;
  startTimer: ReturnType<typeof setTimeout> | null;
  wakeTimer: ReturnType<typeof setTimeout> | null;
  /** A seek the viewer made that has not been sent yet (coalescing). */
  queuedSeekMs: number | null;
  seekSendTimer: ReturnType<typeof setTimeout> | null;
  lastSeekSentAt: number;
  followingItemId: string | null;
}

function freshMemory(): EngineMemory {
  return {
    appliedEpoch: null,
    appliedRevision: -1,
    intent: null,
    playPending: false,
    playRequestedAt: null,
    playStartMs: tuning.initialPlayStartMs,
    blocked: false,
    catchUpAtMs: null,
    correcting: false,
    correctionFromMs: 0,
    rateUnusable: false,
    lastSeekAt: 0,
    seekStartedAt: null,
    seekCostMs: tuning.initialSeekCostMs,
    stalledSince: null,
    pausedSince: null,
    unexpectedPauseSince: null,
    startTimer: null,
    wakeTimer: null,
    queuedSeekMs: null,
    seekSendTimer: null,
    lastSeekSentAt: 0,
    followingItemId: null,
  };
}

const HAVE_CURRENT_DATA = 2;
const HAVE_FUTURE_DATA = 3;

function durationMsOf(video: HTMLVideoElement): number | null {
  return Number.isFinite(video.duration) && video.duration > 0
    ? video.duration * 1_000
    : null;
}

function clampToMedia(video: HTMLVideoElement, positionMs: number): number {
  const duration = durationMsOf(video);
  const upper = duration === null ? positionMs : duration - 250;
  return Math.max(0, Math.min(positionMs, upper));
}

export function usePartyPlayback({
  session,
  state,
  videoRef,
  elementEpoch,
  itemId,
  attachedItemIdRef,
  refreshProgress,
  onFollowItem,
}: UsePartyPlaybackOptions): PartyPlayback {
  const memory = useRef<EngineMemory>(freshMemory());
  const [localState, setLocalState] = useState<PartyLocalState>("syncing");
  const snapshot = state?.snapshot ?? null;
  const isActive =
    session !== null &&
    state !== null &&
    state.connection !== "ended" &&
    snapshot !== null;

  const latest = useRef({
    session,
    state,
    itemId,
    onFollowItem,
    refreshProgress,
  });
  latest.current = {
    session,
    state,
    itemId,
    onFollowItem,
    refreshProgress,
  };

  const setLocal = useCallback((next: PartyLocalState) => {
    setLocalState((current) => (current === next ? current : next));
  }, []);

  const report = useCallback((status: PartyParticipantStatus) => {
    const { session: current } = latest.current;
    current?.setStatus(status, Math.max(0, memory.current.appliedRevision));
  }, []);

  const clearTimer = (key: "startTimer" | "wakeTimer") => {
    const timer = memory.current[key];
    if (timer) clearTimeout(timer);
    memory.current[key] = null;
  };

  const setRate = (video: HTMLVideoElement, rate: number) => {
    if (Math.abs(video.playbackRate - rate) > 0.001) video.playbackRate = rate;
  };

  // `reconcile` is referenced by timers it schedules itself; the ref keeps the
  // newest closure reachable without re-creating those timers.
  const reconcileRef = useRef<() => void>(() => undefined);

  const enginePlay = useCallback((video: HTMLVideoElement) => {
    const m = memory.current;
    m.intent = "play";
    if (!video.paused) return;
    m.playPending = true;
    m.playRequestedAt = performance.now();
    video
      .play()
      .then(() => {
        m.playPending = false;
        m.blocked = false;
      })
      .catch((error: unknown) => {
        m.playPending = false;
        if (error instanceof DOMException && error.name === "NotAllowedError") {
          m.blocked = true;
          partyLog("engine.autoplay-blocked", {});
          reconcileRef.current();
        } else if (
          error instanceof DOMException &&
          error.name === "AbortError" &&
          m.intent === "play"
        ) {
          // A pause() or a load elsewhere interrupted this start. The element
          // is paused, but nobody chose that: left as it is, the pause would
          // read as the viewer's and the tab would sit out the party.
          partyLog("engine.play-interrupted", {});
          m.intent = null;
          reconcileRef.current();
        }
      });
  }, []);

  const enginePause = useCallback((video: HTMLVideoElement) => {
    memory.current.intent = "pause";
    if (!video.paused) video.pause();
  }, []);

  const engineSeek = useCallback(
    (video: HTMLVideoElement, positionMs: number) => {
      const m = memory.current;
      m.lastSeekAt = Date.now();
      m.seekStartedAt = performance.now();
      m.correcting = false;
      setRate(video, 1);
      video.currentTime = clampToMedia(video, positionMs) / 1_000;
      latest.current.refreshProgress();
    },
    [],
  );

  const scheduleWake = useCallback((delayMs: number) => {
    clearTimer("wakeTimer");
    memory.current.wakeTimer = setTimeout(
      () => {
        memory.current.wakeTimer = null;
        reconcileRef.current();
      },
      Math.max(0, delayMs),
    );
  }, []);

  /**
   * Readiness while the group is not advancing: able to play from here at
   * once. A paused element with only its current frame counts after a grace,
   * because some browsers never buffer further until asked to play.
   */
  const stationaryStatus = (
    video: HTMLVideoElement,
  ): PartyParticipantStatus => {
    const m = memory.current;
    if (video.seeking || video.readyState < HAVE_CURRENT_DATA) return "loading";
    if (video.readyState >= HAVE_FUTURE_DATA) return "ready";
    const pausedFor = m.pausedSince === null ? 0 : Date.now() - m.pausedSince;
    return pausedFor >= tuning.pausedReadyGraceMs ? "ready" : "loading";
  };

  const reconcile = useCallback(() => {
    const video = videoRef.current;
    const {
      session: current,
      state: sessionState,
      itemId: localItemId,
    } = latest.current;
    const snap: PartySnapshot | null = sessionState?.snapshot ?? null;
    if (!video || !current || !sessionState || !snap) return;
    if (sessionState.connection === "ended") return;
    const m = memory.current;

    // The group is watching something else: this page follows it.
    if (snap.itemId && snap.itemId !== localItemId) {
      if (m.followingItemId !== snap.itemId) {
        m.followingItemId = snap.itemId;
        enginePause(video);
        report("loading");
        latest.current.onFollowItem(snap.itemId);
      }
      return;
    }
    m.followingItemId = null;

    // The page is on the group's title but the element is not yet: it still
    // holds the previous title's source, fully buffered, and would claim to be
    // ready for a title it has not started loading.
    if (attachedItemIdRef.current !== snap.itemId && snap.itemId !== null) {
      setLocal("syncing");
      report("loading");
      return;
    }

    // This tab's own change is on its way; it stands until the group answers.
    if (sessionState.pendingCommands > 0 || m.queuedSeekMs !== null) return;

    const serverNow = current.clock.serverNow();
    const target = groupTarget(snap, serverNow);
    const localMs = video.currentTime * 1_000;
    const durationMs = durationMsOf(video);
    const isNewRevision =
      snap.revision !== m.appliedRevision || snap.epoch !== m.appliedEpoch;

    if (isNewRevision) {
      partyLog("engine.revision", {
        revision: snap.revision,
        intent: snap.intent,
        hold: snap.hold?.reason ?? null,
        startsInMs: Math.round(target.startsInMs),
        driftMs: Math.round(localMs - target.positionMs),
        readyState: video.readyState,
      });
      m.appliedRevision = snap.revision;
      m.appliedEpoch = snap.epoch;
      m.catchUpAtMs = null;
      m.stalledSince = null;
      m.unexpectedPauseSince = null;
      clearTimer("startTimer");
    }

    const groupAtEnd =
      durationMs !== null &&
      target.positionMs >= durationMs - tuning.endToleranceMs;

    // Paused, holding, or counting down to a start: the element waits.
    if (!target.advancing || target.startsInMs > 0 || groupAtEnd) {
      const startPending =
        target.advancing && target.startsInMs > 0 && !groupAtEnd;
      setRate(video, 1);
      m.correcting = false;
      if (
        isNewRevision &&
        !video.seeking &&
        Math.abs(localMs - target.positionMs) > tuning.pausedSnapToleranceMs
      ) {
        engineSeek(video, target.positionMs);
      }

      if (startPending) {
        // Started early on purpose (below); nothing to do until the group
        // catches up with this player's head start.
        if (!isNewRevision && !video.paused && m.intent === "play") {
          setLocal("in-sync");
          report("ready");
          return;
        }
        // Align by timing, not by seeking: a player slightly ahead starts
        // slightly later, one slightly behind slightly earlier. Seeking here
        // would make this player late by however long decoding from the
        // previous keyframe takes.
        const offsetMs = video.seeking ? 0 : localMs - target.positionMs;
        const delayMs = target.startsInMs + offsetMs - m.playStartMs;
        if (delayMs <= 0) {
          clearTimer("startTimer");
          enginePlay(video);
          setLocal("in-sync");
          report("ready");
          return;
        }
        if (!video.paused) enginePause(video);
        if (!m.startTimer) {
          m.startTimer = setTimeout(() => {
            m.startTimer = null;
            reconcileRef.current();
          }, delayMs);
        }
        setLocal("syncing");
        report(stationaryStatus(video));
        return;
      }

      if (!video.paused) enginePause(video);
      if (m.pausedSince === null) m.pausedSince = Date.now();
      setLocal(stationaryStatus(video) === "ready" ? "in-sync" : "syncing");
      report(stationaryStatus(video));
      return;
    }

    // From here on the group is playing, now.
    m.pausedSince = null;

    if (m.blocked) {
      setLocal("blocked");
      report("away");
      return;
    }

    if (m.catchUpAtMs !== null) {
      const waitMs = m.catchUpAtMs - target.positionMs;
      if (video.seeking || video.readyState < HAVE_FUTURE_DATA) {
        if (waitMs <= 0) {
          // The group overtook this tab while it was still loading: the seek
          // cost more than the lead allowed. Aim further ahead.
          startCatchUp(video, target.positionMs);
        }
        setLocal("catching-up");
        report("loading");
        return;
      }
      if (waitMs > m.playStartMs) {
        if (!video.paused) enginePause(video);
        scheduleWake(waitMs - m.playStartMs);
        setLocal("catching-up");
        report("loading");
        return;
      }
      m.catchUpAtMs = null;
      enginePlay(video);
    }

    const driftMs = localMs - target.positionMs;

    if (isNewRevision) {
      // The wide seek threshold spares a moving picture a visible freeze. A
      // player that has not started — joining, reloaded, or handed a start
      // that arrived late — has no picture to interrupt, and rate would take
      // a minute to close what one landing closes now.
      const landingToleranceMs = video.paused
        ? tuning.pausedSnapToleranceMs
        : tuning.seekThresholdMs;
      if (Math.abs(driftMs) >= landingToleranceMs) {
        startCatchUp(video, target.positionMs);
        return;
      }
      enginePlay(video);
    }

    if (video.paused && !video.ended) {
      if (m.intent === "play" && !m.playPending) {
        // Paused, and not by the engine. Nothing is sent to the group: the
        // viewer is offered a way back instead.
        m.unexpectedPauseSince ??= Date.now();
        if (
          Date.now() - m.unexpectedPauseSince >=
          tuning.unexpectedPauseNoticeMs
        ) {
          setLocal("paused-locally");
          report("away");
        } else {
          scheduleWake(tuning.unexpectedPauseNoticeMs);
        }
        return;
      }
      if (m.intent !== "play") enginePlay(video);
      setLocal("syncing");
      report("loading");
      return;
    }
    m.unexpectedPauseSince = null;

    if (video.ended) {
      setLocal("in-sync");
      report("ready");
      return;
    }

    // Stall detection: the element wants to play but has nothing to play.
    if (video.readyState < HAVE_FUTURE_DATA && !video.seeking) {
      m.stalledSince ??= Date.now();
      const stalledFor = Date.now() - m.stalledSince;
      setLocal("syncing");
      report(stalledFor >= tuning.stallGraceMs ? "stalled" : "ready");
      if (stalledFor < tuning.stallGraceMs) {
        scheduleWake(tuning.stallGraceMs - stalledFor);
      }
      return;
    }
    m.stalledSince = null;

    if (video.seeking || Date.now() - m.lastSeekAt < tuning.postSeekSettleMs) {
      setLocal("syncing");
      report("ready");
      return;
    }

    const correction = driftCorrection(driftMs, m.correcting);
    switch (correction.kind) {
      case "none":
        if (m.correcting) {
          partyLog("engine.drift-closed", { driftMs: Math.round(driftMs) });
        }
        m.correcting = false;
        setRate(video, 1);
        break;
      case "rate":
        if (m.rateUnusable) {
          // Left alone: within the seek threshold, being a little apart is
          // better than a player that freezes whenever it changes speed.
          setRate(video, 1);
          break;
        }
        if (!m.correcting) {
          partyLog("engine.drift-correcting", {
            driftMs: Math.round(driftMs),
            rate: correction.rate,
          });
          m.correctionFromMs = Math.abs(driftMs);
        } else if (
          Math.abs(driftMs) >
          m.correctionFromMs + tuning.rateFailureMarginMs
        ) {
          partyLog("engine.rate-unusable", {
            fromMs: Math.round(m.correctionFromMs),
            driftMs: Math.round(driftMs),
          });
          m.rateUnusable = true;
          m.correcting = false;
          setRate(video, 1);
          break;
        }
        m.correcting = true;
        setRate(video, correction.rate);
        break;
      case "seek":
        startCatchUp(video, target.positionMs);
        return;
    }
    setLocal("in-sync");
    report("ready");

    function startCatchUp(element: HTMLVideoElement, groupPositionMs: number) {
      const lead = catchUpLeadMs(memory.current.seekCostMs);
      const at = groupPositionMs + lead;
      partyLog("engine.catch-up", {
        driftMs: Math.round(element.currentTime * 1_000 - groupPositionMs),
        leadMs: lead,
      });
      memory.current.catchUpAtMs = at;
      enginePause(element);
      engineSeek(element, at);
      setLocal("catching-up");
      report("loading");
    }
  }, [
    attachedItemIdRef,
    enginePause,
    enginePlay,
    engineSeek,
    report,
    scheduleWake,
    setLocal,
    videoRef,
  ]);

  reconcileRef.current = reconcile;

  // Apply whatever the session says, whenever it says something new.
  useEffect(() => {
    if (!isActive) return;
    reconcile();
  }, [
    isActive,
    reconcile,
    snapshot,
    state?.pendingCommands,
    state?.connection,
  ]);

  // Measure drift on a steady cadence, and react to the element as it moves.
  useEffect(() => {
    const video = videoRef.current;
    if (!isActive || !video) return undefined;

    const onSeeked = () => {
      const m = memory.current;
      if (m.seekStartedAt !== null && video.readyState >= HAVE_FUTURE_DATA) {
        m.seekCostMs = nextSeekCostMs(
          m.seekCostMs,
          performance.now() - m.seekStartedAt,
        );
        m.seekStartedAt = null;
      }
      reconcileRef.current();
    };
    const onCanPlay = () => {
      const m = memory.current;
      if (m.seekStartedAt !== null) {
        m.seekCostMs = nextSeekCostMs(
          m.seekCostMs,
          performance.now() - m.seekStartedAt,
        );
        m.seekStartedAt = null;
      }
      reconcileRef.current();
    };
    const onChange = () => reconcileRef.current();
    /**
     * The element dropped its source — a new title, or the player replacing
     * the source for a quality or audio change. What the engine had applied
     * belongs to the old one; the group's state is applied afresh, and a pause
     * during the reload is not the viewer's.
     */
    const onEmptied = () => {
      const m = memory.current;
      m.appliedRevision = -1;
      m.appliedEpoch = null;
      m.intent = null;
      m.playPending = false;
      m.playRequestedAt = null;
      m.catchUpAtMs = null;
      m.unexpectedPauseSince = null;
      m.stalledSince = null;
      clearTimer("startTimer");
      reconcileRef.current();
    };
    const onPlaying = () => {
      const m = memory.current;
      if (m.playRequestedAt !== null) {
        const measured = performance.now() - m.playRequestedAt;
        m.playRequestedAt = null;
        if (measured < tuning.maxPlayStartMs) {
          m.playStartMs = Math.round(m.playStartMs * 0.5 + measured * 0.5);
        }
      }
      reconcileRef.current();
    };

    video.addEventListener("emptied", onEmptied);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("waiting", onChange);
    video.addEventListener("pause", onChange);
    video.addEventListener("ended", onChange);
    video.addEventListener("loadedmetadata", onChange);

    const loop = setInterval(
      () => reconcileRef.current(),
      tuning.loopIntervalMs,
    );
    reconcileRef.current();

    return () => {
      clearInterval(loop);
      video.removeEventListener("emptied", onEmptied);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onChange);
      video.removeEventListener("pause", onChange);
      video.removeEventListener("ended", onChange);
      video.removeEventListener("loadedmetadata", onChange);
    };
  }, [elementEpoch, isActive, videoRef]);

  // Leaving the party (or the page) hands the element back, at normal speed.
  useEffect(() => {
    if (isActive) return undefined;
    const video = videoRef.current;
    if (video && Math.abs(video.playbackRate - 1) > 0.001)
      video.playbackRate = 1;
    const m = memory.current;
    if (m.startTimer) clearTimeout(m.startTimer);
    if (m.wakeTimer) clearTimeout(m.wakeTimer);
    if (m.seekSendTimer) clearTimeout(m.seekSendTimer);
    memory.current = freshMemory();
    setLocal("syncing");
    return undefined;
  }, [isActive, setLocal, videoRef]);

  useEffect(
    () => () => {
      const m = memory.current;
      if (m.startTimer) clearTimeout(m.startTimer);
      if (m.wakeTimer) clearTimeout(m.wakeTimer);
      if (m.seekSendTimer) clearTimeout(m.seekSendTimer);
    },
    [],
  );

  const send = useCallback((command: PartyCommand) => {
    const { session: current } = latest.current;
    if (!current) return;
    void current.command(command).then((outcome) => {
      if (outcome !== "applied") reconcileRef.current();
    });
  }, []);

  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  /** The viewer's intent, at the viewer's own position. */
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const snap = latest.current.state?.snapshot;
    if (!isActiveRef.current || !snap) {
      if (video.paused || video.ended) void video.play().catch(() => undefined);
      else video.pause();
      return;
    }
    const m = memory.current;

    if (m.blocked || localState === "paused-locally") {
      resumeWithPartyImpl(video);
      return;
    }

    // Past the end the group's intent may still say "playing" — nobody paused
    // it, the film simply ran out — so the end is checked before the intent:
    // from there, play means from the start.
    const durationMs = durationMsOf(video);
    const groupPositionMs = groupTarget(
      snap,
      latest.current.session?.clock.serverNow() ?? Date.now(),
    ).positionMs;
    if (
      durationMs !== null &&
      groupPositionMs >= durationMs - tuning.endToleranceMs
    ) {
      engineSeek(video, 0);
      send({ type: "seek", positionMs: 0 });
      send({ type: "play" });
      return;
    }

    if (snap.intent === "playing") {
      enginePause(video);
      send({
        type: "pause",
        positionMs: Math.round(video.currentTime * 1_000),
      });
      return;
    }

    send({ type: "play" });

    function resumeWithPartyImpl(element: HTMLVideoElement) {
      // Called from the viewer's gesture, so the browser allows it; from here
      // the engine may start and stop this element freely.
      m.blocked = false;
      m.unexpectedPauseSince = null;
      m.intent = "play";
      m.playPending = true;
      void element
        .play()
        .catch(() => undefined)
        .finally(() => {
          m.playPending = false;
          reconcileRef.current();
        });
    }
  }, [enginePause, engineSeek, localState, send, videoRef]);

  const resumeWithParty = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const m = memory.current;
    m.blocked = false;
    m.unexpectedPauseSince = null;
    m.intent = "play";
    m.playPending = true;
    void video
      .play()
      .catch(() => undefined)
      .finally(() => {
        m.playPending = false;
        reconcileRef.current();
      });
  }, [videoRef]);

  const flushSeek = useCallback(() => {
    const m = memory.current;
    if (m.seekSendTimer) clearTimeout(m.seekSendTimer);
    m.seekSendTimer = null;
    const positionMs = m.queuedSeekMs;
    m.queuedSeekMs = null;
    if (positionMs === null) return;
    m.lastSeekSentAt = Date.now();
    send({ type: "seek", positionMs: Math.round(positionMs) });
  }, [send]);

  const seekTo = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (!video) return;
      const m = memory.current;
      const positionMs = clampToMedia(video, seconds * 1_000);
      const snap = latest.current.state?.snapshot;
      if (!isActiveRef.current || !snap) {
        video.currentTime = positionMs / 1_000;
        latest.current.refreshProgress();
        return;
      }

      // The viewer sees their seek at once. While the group plays, everyone
      // is about to pause at the new position until all are ready there, so
      // this player pauses too rather than running ahead of them.
      engineSeek(video, positionMs);
      if (snap.intent === "playing") enginePause(video);

      m.queuedSeekMs = positionMs;
      const sinceLast = Date.now() - m.lastSeekSentAt;
      if (sinceLast >= tuning.seekCoalesceMs && !m.seekSendTimer) {
        flushSeek();
      } else if (!m.seekSendTimer) {
        m.seekSendTimer = setTimeout(
          flushSeek,
          tuning.seekCoalesceMs - Math.max(0, sinceLast),
        );
      }
    },
    [enginePause, engineSeek, flushSeek, videoRef],
  );

  const seekBy = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (!video) return;
      const base =
        memory.current.queuedSeekMs !== null
          ? memory.current.queuedSeekMs / 1_000
          : video.currentTime;
      seekTo(base + seconds);
    },
    [seekTo, videoRef],
  );

  const changeItem = useCallback(
    (nextItemId: string) => {
      const snap = latest.current.state?.snapshot;
      if (!snap || snap.itemId === nextItemId) return;
      send({ type: "setItem", itemId: nextItemId, fromItemId: snap.itemId });
    },
    [send],
  );

  // Media keys, headset buttons and the lock screen are the viewer asking too.
  // Left to the browser they would play or pause this element alone and the
  // tab would quietly leave the group.
  const actionsRef = useRef({ togglePlay, seekTo, seekBy });
  actionsRef.current = { togglePlay, seekTo, seekBy };
  useEffect(() => {
    const mediaSession =
      typeof navigator === "undefined" ? undefined : navigator.mediaSession;
    if (!isActive || !mediaSession) return undefined;
    const intent = () => latest.current.state?.snapshot?.intent;
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ["play", () => intent() === "paused" && actionsRef.current.togglePlay()],
      [
        "pause",
        () => intent() === "playing" && actionsRef.current.togglePlay(),
      ],
      [
        "seekto",
        (details) => {
          if (typeof details.seekTime === "number") {
            actionsRef.current.seekTo(details.seekTime);
          }
        },
      ],
      [
        "seekbackward",
        (details) => actionsRef.current.seekBy(-(details.seekOffset ?? 10)),
      ],
      [
        "seekforward",
        (details) => actionsRef.current.seekBy(details.seekOffset ?? 10),
      ],
    ];
    for (const [action, handler] of handlers) {
      try {
        mediaSession.setActionHandler(action, handler);
      } catch {
        // Not every browser supports every action.
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          mediaSession.setActionHandler(action, null);
        } catch {
          // As above.
        }
      }
    };
  }, [isActive]);

  const pendingPlay =
    (state?.pendingCommands ?? 0) > 0 && snapshot?.intent === "paused";
  const isStartPending =
    isActive &&
    (pendingPlay ||
      (snapshot?.intent === "playing" &&
        (snapshot.hold !== null ||
          localState === "syncing" ||
          localState === "catching-up")));

  return {
    isActive,
    localState,
    isStartPending,
    togglePlay,
    seekTo,
    seekBy,
    changeItem,
    resumeWithParty,
  };
}
