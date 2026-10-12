/**
 * Party Watch in a real browser: real `<video>` elements, each driven by its
 * own session and playback engine, against the real group state machine.
 *
 * The server here is the production state machine (`syncplayState.ts`) with a
 * thin in-page transport in place of HTTP, so what is under test is exactly
 * what ships on both ends — the rules that decide what the group does, and the
 * engine that makes each element follow. Each client gets its own latency and
 * its own wrong wall clock. jsdom has no decoder, so none of this — start
 * alignment, seek landing, drift — could be observed there.
 */

import { act, cleanup, render } from "@testing-library/react";
import { useRef, useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyCommand,
  createGroupState,
  joinParticipant,
  participantKey,
  removeParticipant,
  reportStatus,
  setStreamOpen,
  tick,
  waitingFor,
  type GroupState,
  type Transition,
} from "../../server/ownApi/syncplay/syncplayState";
import { createPartySession, type PartySession } from "./partySession";
import type { PartyStreamHandlers, PartyTransport } from "./partyWatchApi";
import type { PartySnapshot } from "./partyWatchTypes";
import { usePartyPlayback, type PartyPlayback } from "./usePartyPlayback";

const MEDIA = "/test-media/720p.mp4";
const ITEM = "item-1";
const GROUP = "group-1";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The group state machine behind a transport per client, in this page. */
class GroupServer {
  state: GroupState;
  version = 0;
  private streams = new Map<
    string,
    { handlers: PartyStreamHandlers; latencyMs: number }
  >();
  private timer: ReturnType<typeof setInterval>;

  constructor() {
    this.state = createGroupState({
      id: GROUP,
      name: "Party",
      ownerUserId: "user-a",
      itemId: ITEM,
      now: Date.now(),
    });
    this.timer = setInterval(
      () => this.commit(tick(this.state, Date.now())),
      250,
    );
  }

  stop() {
    clearInterval(this.timer);
  }

  private snapshot(): PartySnapshot {
    const { timeline } = this.state;
    return {
      id: GROUP,
      name: "Party",
      ownerUserId: "user-a",
      itemId: timeline.itemId,
      epoch: "epoch",
      version: this.version,
      revision: timeline.revision,
      intent: timeline.intent,
      positionMs: timeline.positionMs,
      anchorMs: timeline.anchorMs,
      serverTimeMs: Date.now(),
      hold: timeline.hold
        ? {
            reason: timeline.hold.reason,
            waitingFor: waitingFor(this.state).map((p) => p.key),
          }
        : null,
      participants: this.state.participants.map((p) => ({
        id: p.key,
        userId: p.userId,
        displayName: p.displayName,
        isOwner: false,
        presence: p.presence,
        status: p.status,
      })),
      cause: null,
    };
  }

  private commit(transition: Transition) {
    this.state = transition.state;
    if (!transition.timelineChanged && !transition.participantsChanged) return;
    this.version += 1;
    const snapshot = this.snapshot();
    for (const { handlers, latencyMs } of this.streams.values()) {
      setTimeout(() => handlers.onSnapshot(snapshot), latencyMs);
    }
  }

  transportFor(userId: string, latencyMs: number): PartyTransport {
    const later = <T,>(work: () => T): Promise<T> =>
      sleep(latencyMs).then(() => {
        const result = work();
        return sleep(latencyMs).then(() => result);
      });
    const keyOf = (clientId: string) => participantKey(userId, clientId);

    return {
      create: () => Promise.reject(new Error("unused")),
      join: (_group, clientId) =>
        later(() => {
          this.commit(
            joinParticipant(
              this.state,
              { userId, clientId, displayName: userId },
              Date.now(),
            ),
          );
          return this.snapshot();
        }),
      leave: (_group, clientId) =>
        later(() => {
          this.commit(
            removeParticipant(this.state, keyOf(clientId), "left", Date.now()),
          );
        }),
      end: () => Promise.resolve(),
      command: (_group, { clientId, sequence, ...command }) =>
        later(() => {
          const transition = applyCommand(
            this.state,
            keyOf(clientId),
            sequence,
            command,
            Date.now(),
          );
          const accepted = !transition.events.some(
            (e) => e.type === "command-ignored",
          );
          this.commit(transition);
          return {
            accepted,
            snapshot: this.snapshot(),
            lastSequence: sequence,
          };
        }),
      status: (_group, { clientId, status, revision, latencyMs: reported }) =>
        later(() => {
          this.commit(
            reportStatus(
              this.state,
              keyOf(clientId),
              {
                status,
                revision,
                ...(reported === undefined ? {} : { latencyMs: reported }),
              },
              Date.now(),
            ),
          );
          return { serverTimeMs: Date.now() };
        }),
      openStream: (_group, clientId, handlers) => {
        const key = keyOf(clientId);
        setTimeout(() => {
          this.streams.set(key, { handlers, latencyMs });
          this.commit(setStreamOpen(this.state, key, true, Date.now()));
          const snapshot = this.snapshot();
          setTimeout(() => handlers.onSnapshot(snapshot), latencyMs);
        }, latencyMs);
        return {
          close: () => {
            this.streams.delete(key);
          },
        };
      },
    };
  }
}

interface Viewer {
  name: string;
  session: PartySession;
  video: () => HTMLVideoElement;
  playback: () => PartyPlayback;
}

function ViewerPlayer({
  session,
  onReady,
}: {
  session: PartySession;
  onReady: (video: HTMLVideoElement, playback: PartyPlayback) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const attachedItemIdRef = useRef<string | null>(ITEM);
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const playback = usePartyPlayback({
    session,
    state,
    videoRef,
    elementEpoch: 0,
    itemId: ITEM,
    attachedItemIdRef,
    refreshProgress: () => undefined,
    onFollowItem: () => undefined,
  });
  return (
    <video
      ref={(element) => {
        (videoRef as { current: HTMLVideoElement | null }).current = element;
        if (element) onReady(element, playback);
      }}
      src={MEDIA}
      muted
      playsInline
      preload="auto"
      width={160}
      height={90}
    />
  );
}

const servers: GroupServer[] = [];
const sessions: PartySession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.leave();
  for (const server of servers.splice(0)) server.stop();
  cleanup();
});

async function viewer(
  server: GroupServer,
  name: string,
  { latencyMs = 0, clockSkewMs = 0 } = {},
): Promise<Viewer> {
  const session = createPartySession({
    groupId: GROUP,
    userId: name,
    clientId: `${name}-tab`,
    transport: server.transportFor(name, latencyMs),
    replaceClientId: () => `${name}-tab-2`,
    // This viewer's device clock is wrong by `clockSkewMs`.
    now: () => Date.now() + clockSkewMs,
  });
  sessions.push(session);
  let element: HTMLVideoElement | null = null;
  let controls: PartyPlayback | null = null;
  const host = document.createElement("div");
  document.body.append(host);
  render(
    <ViewerPlayer
      session={session}
      onReady={(video, playback) => {
        element = video;
        controls = playback;
      }}
    />,
    { container: host },
  );
  await act(async () => {
    session.start();
  });
  await waitFor(() => (element?.readyState ?? 0) >= 2, 15_000);
  return {
    name,
    session,
    video: () => element!,
    playback: () => controls!,
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("Timed out waiting.");
    await sleep(50);
  }
}

/** The largest gap between any two players' positions, in milliseconds. */
function spreadMs(viewers: Viewer[]): number {
  const positions = viewers.map((v) => v.video().currentTime * 1_000);
  return Math.max(...positions) - Math.min(...positions);
}

const allPlaying = (viewers: Viewer[]) =>
  viewers.every((v) => !v.video().paused && v.video().readyState >= 3);
const allPaused = (viewers: Viewer[]) => viewers.every((v) => v.video().paused);

describe("watching together in a real browser", () => {
  it("starts everyone together and keeps them together, whatever their clocks say", async () => {
    const server = new GroupServer();
    servers.push(server);
    const ada = await viewer(server, "ada");
    const bora = await viewer(server, "bora", {
      latencyMs: 60,
      clockSkewMs: 2_500,
    });
    const cem = await viewer(server, "cem", {
      latencyMs: 120,
      clockSkewMs: -1_800,
    });
    const everyone = [ada, bora, cem];
    await sleep(800);

    act(() => bora.playback().togglePlay());
    await waitFor(() => allPlaying(everyone), 10_000);
    await sleep(1_500);

    let worst = 0;
    for (let i = 0; i < 8; i += 1) {
      worst = Math.max(worst, spreadMs(everyone));
      await sleep(250);
    }
    expect(worst).toBeLessThan(150);
  });

  it("lands a seek from anyone on the same frame, then resumes everyone together", async () => {
    const server = new GroupServer();
    servers.push(server);
    const ada = await viewer(server, "ada");
    const bora = await viewer(server, "bora", {
      latencyMs: 80,
      clockSkewMs: 900,
    });
    const everyone = [ada, bora];
    await sleep(800);

    act(() => ada.playback().togglePlay());
    await waitFor(() => allPlaying(everyone));

    act(() => bora.playback().seekTo(6));
    await sleep(200);
    // While the group settles, nobody runs ahead of the others.
    expect(spreadMs(everyone)).toBeLessThan(400);

    await waitFor(
      () => allPlaying(everyone) && ada.video().currentTime > 6.1,
      10_000,
    );
    await sleep(600);
    expect(spreadMs(everyone)).toBeLessThan(150);
    expect(ada.video().currentTime).toBeGreaterThan(6);
    expect(ada.video().currentTime).toBeLessThan(8.5);
  });

  it("pauses everyone on one frame, and ignores a press that was overtaken", async () => {
    const server = new GroupServer();
    servers.push(server);
    const ada = await viewer(server, "ada");
    const bora = await viewer(server, "bora", { latencyMs: 50 });
    const everyone = [ada, bora];
    await sleep(800);

    act(() => ada.playback().togglePlay());
    await waitFor(() => allPlaying(everyone));
    await sleep(700);

    // Four quick presses: pause, play, pause, play. The last one wins, for all.
    for (let i = 0; i < 4; i += 1) {
      act(() => bora.playback().togglePlay());
      await sleep(60);
    }
    await sleep(2_500);
    expect(allPlaying(everyone)).toBe(true);
    expect(spreadMs(everyone)).toBeLessThan(150);

    act(() => bora.playback().togglePlay());
    await waitFor(() => allPaused(everyone), 5_000);
    await sleep(500);
    expect(spreadMs(everyone)).toBeLessThan(120);
  });

  it("brings someone who arrives mid-film to where everyone is", async () => {
    const server = new GroupServer();
    servers.push(server);
    const ada = await viewer(server, "ada");
    await sleep(500);
    act(() => ada.playback().togglePlay());
    await waitFor(() => allPlaying([ada]));
    await sleep(2_000);

    const late = await viewer(server, "late", {
      latencyMs: 90,
      clockSkewMs: 3_000,
    });
    const everyone = [ada, late];
    await waitFor(() => allPlaying(everyone), 12_000);
    // The newcomer never stopped the group to wait for it.
    expect(ada.video().paused).toBe(false);
    await sleep(2_000);
    expect(spreadMs(everyone)).toBeLessThan(200);
  });

  it("starts a joiner whose first start something else interrupted", async () => {
    const server = new GroupServer();
    servers.push(server);
    const ada = await viewer(server, "ada");
    await sleep(500);
    act(() => ada.playback().togglePlay());
    await waitFor(() => allPlaying([ada]));
    await sleep(1_000);

    // Something else pauses the element while the engine's start is still
    // pending — as the player's own source restore once did on
    // `loadedmetadata`. The element stays paused and the start is rejected.
    const realPlay = HTMLMediaElement.prototype.play;
    let interrupted = 0;
    HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
      if (interrupted > 0) return realPlay.call(this);
      interrupted += 1;
      return Promise.reject(
        new DOMException(
          "The play() request was interrupted by a call to pause().",
          "AbortError",
        ),
      );
    };
    try {
      const late = await viewer(server, "late", { latencyMs: 40 });
      const everyone = [ada, late];
      await waitFor(() => interrupted > 0, 10_000);
      await waitFor(() => allPlaying(everyone), 10_000);
      await sleep(1_000);
      expect(late.playback().localState).toBe("in-sync");
      expect(spreadMs(everyone)).toBeLessThan(200);
    } finally {
      HTMLMediaElement.prototype.play = realPlay;
    }
  });
});
