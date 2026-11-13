import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../../../i18n/LanguageContext";
import type { PartyNotice } from "../../../features/partyWatch/partySession";
import type { PartyLocalState } from "../../../features/partyWatch/usePartyPlayback";
import { SahnePartyStage } from "./SahnePartyStage";
import type { SahneParty } from "./sahneParty";

const ece = { id: "e:1", name: "Ece", initial: "E", color: "#fa9b1d", ink: "#0a0b0c", self: false };
const me = { id: "me:1", name: "Sen", initial: "S", color: "#e8ecef", ink: "#0a0b0c", self: true };

function party(overrides: Partial<SahneParty> = {}): SahneParty {
  return {
    connection: "live",
    discs: [me, ece],
    waitingFor: [],
    notice: null,
    actor: null,
    commandFailed: false,
    ...overrides,
  };
}

function stage(p: SahneParty, localState: PartyLocalState | null, onRejoin = vi.fn()) {
  return render(
    <LanguageProvider>
      <SahnePartyStage
        party={p}
        picture={{ x: 48, y: 72, w: 1344, h: 600 }}
        bar={{ x: 48, y: 700, w: 1344 }}
        currentTime={60}
        duration={3600}
        localState={localState}
        onRejoin={onRejoin}
        onShowControls={() => {}}
      />
    </LanguageProvider>,
  );
}

describe("SahnePartyStage", () => {
  it("asks a viewer who dropped out of the party to rejoin, with one way back", () => {
    const onRejoin = vi.fn();
    stage(party(), "paused-locally", onRejoin);
    const card = screen.getByRole("dialog");
    expect(card.querySelectorAll("button")).toHaveLength(1);
    fireEvent.click(card.querySelector("button")!);
    expect(onRejoin).toHaveBeenCalledTimes(1);
  });

  it("asks the same when the browser blocked playback", () => {
    stage(party(), "blocked");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("stays out of the way while in step, or while reconnecting", () => {
    stage(party(), "in-sync");
    expect(screen.queryByRole("dialog")).toBeNull();
    stage(party({ connection: "reconnecting" }), "paused-locally");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("signs someone else's pause with their disc", () => {
    const notice = {
      id: 1,
      cause: { kind: "pause", participantId: "e:1", displayName: "Ece" },
      snapshot: { positionMs: 60_000 },
    } as unknown as PartyNotice;
    const { container } = stage(party({ notice, actor: ece }), "in-sync");
    const badge = container.querySelector(".sahne-party-badge");
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toContain("E");
  });
});
