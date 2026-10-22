import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationHost } from "./NotificationHost";
import {
  NOTIFICATION_LIFETIMES_MS,
  getNotifications,
  notify,
  resetNotificationsForTests,
} from "../../lib/notifications/notificationStore";

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

let reducedMotion = true;
const presenceModes: Array<string | undefined> = [];
/** A transform keyframe, or the last of a list of them. */
const lastTransform = (target: unknown) => {
  const transform = (target as { transform?: string | string[] })?.transform;
  return String(Array.isArray(transform) ? transform.at(-1) : transform);
};
vi.mock("framer-motion", () => ({
  AnimatePresence: ({
    children,
    mode,
  }: {
    children: React.ReactNode;
    mode?: string;
  }) => {
    presenceModes.push(mode);
    return children;
  },
  animate: () => ({ stop: () => {} }),
  motion: {
    div: ({
      children,
      // Motion-only props must not reach the DOM or React warns about each one.
      // They are surfaced as data attributes instead, so a test can assert that
      // a fade was actually asked for rather than trusting that it was.
      layout: _layout,
      initial,
      animate,
      exit,
      transition: _transition,
      style,
      ...props
    }: Record<string, unknown> & { children?: React.ReactNode }) => (
      <div
        // `y` on the host is a motion value, not a CSS length, and React
        // rejects it as one.
        style={
          Object.fromEntries(
            Object.entries((style ?? {}) as Record<string, unknown>).filter(
              ([property]) => property !== "y",
            ),
          ) as React.CSSProperties
        }
        data-initial-transform={lastTransform(initial)}
        data-exit-transform={lastTransform(exit)}
        data-initial-opacity={String(
          (initial as { opacity?: number })?.opacity,
        )}
        data-animate-opacity={String(
          (animate as { opacity?: number })?.opacity,
        )}
        data-exit-opacity={String((exit as { opacity?: number })?.opacity)}
        {...(props as object)}
      >
        {children}
      </div>
    ),
  },
  useReducedMotion: () => reducedMotion,
}));

beforeEach(() => {
  reducedMotion = true;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetNotificationsForTests();
});

describe("notification host", () => {
  it("shows a notification raised from anywhere, without a provider", () => {
    render(<NotificationHost />);

    act(() => {
      notify({ title: "Library scan", description: "Reading disc" });
    });

    const row = screen.getByRole("button", { name: "Library scan" });
    expect(row).toBeInTheDocument();
    act(() => {
      row.click();
    });
    expect(screen.getByText("Reading disc")).toBeInTheDocument();
  });

  it("uses a visually balanced glyph for spinning progress", () => {
    render(<NotificationHost />);
    act(() => {
      notify({ title: "Encoding", tone: "progress" });
    });

    const spinner = screen
      .getByRole("button", { name: "Encoding" })
      .querySelector("[data-notification-spinner]");
    expect(spinner).not.toHaveClass("animate-spin");
    const ring = spinner?.querySelector("circle");
    expect(ring).toHaveClass("notification-spinner-ring");
    expect(ring).toHaveAttribute("stroke-dasharray", "140 40 140 40");
  });

  it("expires a short notification on its own", () => {
    render(<NotificationHost />);
    act(() => {
      notify({ title: "Saved", tone: "success" });
    });

    act(() => {
      vi.advanceTimersByTime(4_100);
    });

    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("keeps a long notification well past a short one's life", () => {
    render(<NotificationHost />);
    act(() => {
      notify({ title: "Careful", tone: "warning" });
    });

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText("Careful")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.queryByText("Careful")).toBeNull();
  });

  it("never expires a persistent notification", () => {
    render(<NotificationHost />);
    act(() => {
      notify({ title: "Broken", tone: "error" });
    });

    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });

    expect(screen.getByText("Broken")).toBeInTheDocument();
  });

  it("closes a notification when its dismiss control is used", () => {
    render(<NotificationHost />);
    act(() => {
      notify({ title: "Broken", tone: "error" });
    });

    act(() => {
      screen.getByRole("button", { name: "notifications.dismiss" }).click();
    });

    expect(screen.queryByText("Broken")).toBeNull();
    expect(getNotifications()).toHaveLength(0);
  });

  it("gives a replaced notification its full life again", () => {
    // A scan that ran for a minute would otherwise show its result for no time
    // at all, because the card would already be older than its lifetime.
    render(<NotificationHost />);
    act(() => {
      notify({ key: "scan", title: "Scanning", tone: "progress" });
    });

    act(() => {
      vi.advanceTimersByTime(60_000);
      notify({ key: "scan", title: "Scan finished", tone: "success" });
    });

    expect(screen.getByText("Scan finished")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByText("Scan finished")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.queryByText("Scan finished")).toBeNull();
  });

  it("restarts the timer when a card is replaced without changing its life", () => {
    // The expiry effect keys off `createdAt`. If it only watched the id and the
    // life, a replacement of the same kind would silently inherit the previous
    // card's deadline — so this replaces short with short, where nothing else
    // about the card changes.
    render(<NotificationHost />);
    act(() => {
      notify({ key: "save", title: "Saved once", tone: "success" });
    });

    act(() => {
      vi.advanceTimersByTime(3_000);
      notify({ key: "save", title: "Saved again", tone: "success" });
    });

    // Under the old schedule this would already be a second from expiry.
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByText("Saved again")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2_500);
    });
    expect(screen.queryByText("Saved again")).toBeNull();
  });

  it("fades in and out rather than appearing and vanishing", () => {
    render(<NotificationHost />);
    act(() => {
      notify({ title: "Saved", tone: "success" });
    });

    const card = screen.getByText("Saved").closest("[data-initial-opacity]");
    expect(card?.getAttribute("data-initial-opacity")).toBe("0");
    expect(card?.getAttribute("data-animate-opacity")).toBe("1");
    // Without an exit the card would be gone the instant the store drops it.
    expect(card?.getAttribute("data-exit-opacity")).toBe("0");
  });

  it("shows how many are hidden once the pile is deep", () => {
    render(<NotificationHost />);
    act(() => {
      for (let index = 0; index < 9; index += 1) {
        notify({ title: `Entry ${index}`, tone: "error" });
      }
    });

    expect(screen.getByText("notifications.more")).toBeInTheDocument();
  });

  it("opens the pile so the buried ones can actually be read", () => {
    render(<NotificationHost />);
    act(() => {
      for (let index = 0; index < 9; index += 1) {
        notify({ title: `Entry ${index}`, tone: "error" });
      }
    });

    // The oldest holds the front and the next two peek out behind it; the
    // newest are the deepest, and are not in the page at all until it opens.
    expect(screen.getByText("Entry 0")).toBeInTheDocument();
    expect(screen.queryByText("Entry 8")).toBeNull();

    act(() => {
      screen.getByText("notifications.more").click();
    });

    expect(screen.getByText("Entry 0")).toBeInTheDocument();
    expect(screen.getByText("Entry 8")).toBeInTheDocument();
  });

  it("opens the pile when a collapsed card itself is clicked", () => {
    render(<NotificationHost />);
    act(() => {
      for (let index = 0; index < 6; index += 1) {
        notify({ title: `Entry ${index}`, tone: "error" });
      }
    });

    // The oldest is the only card laid out; the next two peek out behind it.
    act(() => {
      screen.getByText("Entry 1").click();
    });

    expect(screen.getByText("Entry 5")).toBeInTheDocument();
  });

  it("closes again", () => {
    render(<NotificationHost />);
    act(() => {
      for (let index = 0; index < 9; index += 1) {
        notify({ title: `Entry ${index}`, tone: "error" });
      }
    });

    act(() => {
      screen.getByText("notifications.more").click();
    });
    act(() => {
      screen.getByText("notifications.showLess").click();
    });
    // The rows fold before they are taken away: they are still mounted, at no
    // height, until the fold has finished.
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(screen.queryByText("Entry 8")).toBeNull();
  });

  it("stops the clock while the pile is open", () => {
    // Reading takes longer than four seconds, and cards disappearing from under
    // the cursor would make the pile unreadable exactly when it is being read.
    render(<NotificationHost />);
    act(() => {
      for (let index = 0; index < 6; index += 1) {
        notify({ title: `Entry ${index}`, tone: "success" });
      }
    });

    act(() => {
      screen.getByText("notifications.more").click();
    });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(screen.getByText("Entry 5")).toBeInTheDocument();
  });

  it("clears everything at once when asked", () => {
    render(<NotificationHost />);
    act(() => {
      for (let index = 0; index < 6; index += 1) {
        notify({ title: `Entry ${index}`, tone: "error" });
      }
    });

    act(() => {
      screen.getByText("notifications.more").click();
    });
    act(() => {
      screen.getByText("notifications.dismissAll").click();
    });

    expect(getNotifications()).toHaveLength(0);
  });

  it("dismissing one card does not open the pile underneath it", () => {
    render(<NotificationHost />);
    act(() => {
      for (let index = 0; index < 6; index += 1) {
        notify({ title: `Entry ${index}`, tone: "error" });
      }
    });

    act(() => {
      // The dismiss control of a collapsed card sits inside its clickable body.
      const collapsed = screen.getByText("Entry 1").closest("div")
        ?.parentElement as HTMLElement;
      collapsed
        .querySelector<HTMLButtonElement>(
          'button[aria-label="notifications.dismiss"]',
        )
        ?.click();
    });

    // Asserting on visibility would prove nothing: the pile shrinks by one, so
    // the next card surfaces either way. Whether it opened is the question.
    expect(
      screen.getByText("notifications.more").closest("button"),
    ).toHaveAttribute("aria-expanded", "false");
    expect(getNotifications()).toHaveLength(5);
  });

  it("keeps a card in the pile shut, because it is a depth cue and not a card", () => {
    render(<NotificationHost />);
    act(() => {
      notify({ title: "Oldest", tone: "error" });
      notify({ title: "Newest", description: "Buried", tone: "error" });
    });

    // Pressing it reaches for the pile it belongs to, not for its own detail.
    act(() => {
      screen.getByText("Newest").click();
    });

    expect(screen.getByText("Newest")).toBeInTheDocument();
    expect(screen.queryByText("Buried")).toBeNull();
  });

  it("opens a card's detail when it is pressed, and shuts it again", () => {
    render(<NotificationHost />);
    act(() => {
      notify({ title: "Library scan", description: "Reading disc" });
    });

    // A line until it is asked to be more: the detail is one press away and
    // nothing about a passing cursor counts as asking.
    expect(screen.queryByText("Reading disc")).toBeNull();

    const row = screen.getByRole("button", { name: "Library scan" });
    act(() => {
      row.click();
    });
    expect(screen.getByText("Reading disc")).toBeInTheDocument();
    expect(row).toHaveAttribute("aria-expanded", "true");

    act(() => {
      row.click();
    });
    expect(screen.queryByText("Reading disc")).toBeNull();
  });

  it("never opens a card by being passed over", () => {
    render(<NotificationHost />);
    act(() => {
      notify({ title: "Library scan", description: "Reading disc" });
    });

    const row = screen.getByRole("button", { name: "Library scan" });
    act(() => {
      row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      row.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });

    expect(screen.queryByText("Reading disc")).toBeNull();
  });

  it("holds a card open past its own lifetime", () => {
    // Opening one is reading it, and four seconds is not long enough to read
    // an encode's figures — least of all if it disappears mid-sentence.
    render(<NotificationHost />);
    act(() => {
      notify({ title: "Saved", tone: "success" });
    });
    act(() => {
      screen.getByRole("button", { name: "Saved" }).click();
    });

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("gives its row back on the way out rather than at the end of it", () => {
    // A card that fades in place and only then stops taking up space is what
    // left the controls above the column sitting still and then jumping. A
    // leaving card steps out of the flow at once and fades where it stood.
    presenceModes.length = 0;
    render(<NotificationHost />);
    act(() => {
      notify({ title: "Saved", tone: "success" });
    });

    expect(screen.getByText("Saved").closest("[data-card]")).toBeTruthy();
    expect(presenceModes).toContain("popLayout");
  });
});

it.each([true, false])(
  "uses bottom/right motion, respecting reduced motion = %s",
  (reduce) => {
    reducedMotion = reduce;
    render(<NotificationHost />);
    act(() => {
      notify({ title: "Motion" });
    });
    const card = screen.getByText("Motion").closest("[data-card]");
    expect(card).toHaveAttribute(
      "data-initial-transform",
      reduce
        ? "translate(0px, 0px) scale(1)"
        : "translate(16px, 16px) scale(0.94)",
    );
    expect(card).toHaveAttribute(
      "data-exit-transform",
      reduce
        ? "translate(0px, 0px) scale(1)"
        : "translate(24px, 10px) scale(0.94)",
    );
  },
);

it("moves keyboard focus onto the card behind when a focused one disappears", () => {
  render(<NotificationHost />);
  act(() => {
    notify({ title: "First", tone: "error" });
    notify({ title: "Second", tone: "error" });
  });
  const dismiss = screen.getAllByRole("button", {
    name: "notifications.dismiss",
  });
  act(() => {
    dismiss[0]!.focus();
    dismiss[0]!.click();
  });
  // Focus lands on the next card's own control rather than falling back to the
  // document, which is where a keyboard would otherwise have to start again.
  // "First" holds the front of the pile, so dismissing it surfaces "Second".
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Second" }),
  );
});

it("lets cards expire after a tap, as they do after a mouse leaves", () => {
  // A tap sends an emulated mouseenter with no mouseleave, and "Dismiss all"
  // leaves focus on the host with nothing to move it on. Either one used to
  // hold every card's clock for good, so a phone collected every card raised
  // after the first touch.
  render(<NotificationHost />);
  act(() => {
    notify({ title: "First", tone: "success" });
  });
  const host = document.querySelector<HTMLElement>("[data-notification-host]")!;
  act(() => {
    fireEvent.pointerEnter(host, { pointerType: "touch" });
    fireEvent.mouseEnter(host);
    screen.getByRole("button", { name: "notifications.dismissAll" }).click();
  });
  expect(document.activeElement).toBe(host);

  act(() => {
    notify({ title: "Later", tone: "success" });
  });
  act(() => {
    vi.advanceTimersByTime(NOTIFICATION_LIFETIMES_MS.short + 500);
  });
  expect(screen.queryByText("Later")).toBeNull();
});

it("still holds the cards while a mouse rests on them", () => {
  render(<NotificationHost />);
  act(() => {
    notify({ title: "Saved", tone: "success" });
  });
  const host = document.querySelector<HTMLElement>("[data-notification-host]")!;
  act(() => {
    fireEvent.pointerEnter(host, { pointerType: "mouse" });
  });
  act(() => {
    vi.advanceTimersByTime(NOTIFICATION_LIFETIMES_MS.short + 500);
  });
  expect(screen.getByText("Saved")).toBeInTheDocument();
});
