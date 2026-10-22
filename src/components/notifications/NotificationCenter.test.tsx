import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationCenter } from "./NotificationCenter";
import {
  NOTIFICATION_LIFETIMES_MS,
  dismissNotification,
  getNotifications,
  notify,
  resetNotificationsForTests,
} from "../../lib/notifications/notificationStore";

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key, language: "en" }),
}));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetNotificationsForTests();
});

const renderCentre = () =>
  render(
    <MemoryRouter>
      <NotificationCenter />
    </MemoryRouter>,
  );
const bell = () => screen.getByRole("button", { name: /nav\.notifications/ });

describe("NotificationCenter", () => {
  it("puts nothing on the page until the bell is pressed", () => {
    renderCentre();
    act(() => {
      notify({ title: "Saved", tone: "success" });
    });

    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(bell());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("counts what is going on, and marks what arrived unseen", () => {
    const { container } = renderCentre();
    const count = () => container.querySelector("[data-notification-count]");
    const dot = () => container.querySelector("[data-notification-new]");

    act(() => {
      notify({ title: "Encoding", tone: "progress", progress: 10 });
    });
    expect(count()).toHaveTextContent("1");

    // Seen, then gone: no count, nothing new.
    fireEvent.click(bell());
    fireEvent.click(bell());
    act(() => {
      getNotifications().forEach((entry) => dismissNotification(entry.id));
    });
    expect(count()).toBeNull();
    expect(dot()).toBeNull();

    // Something arrives and expires before it is looked at: a dot, no count.
    act(() => {
      vi.advanceTimersByTime(10);
      notify({ title: "Saved", tone: "success" });
      vi.advanceTimersByTime(NOTIFICATION_LIFETIMES_MS.short + 10);
    });
    expect(count()).toBeNull();
    expect(dot()).not.toBeNull();

    fireEvent.click(bell());
    expect(dot()).toBeNull();
  });

  it("shows what is happening now apart from what happened before", () => {
    renderCentre();
    act(() => {
      notify({ title: "Old news", tone: "success" });
      vi.advanceTimersByTime(NOTIFICATION_LIFETIMES_MS.short + 10);
      notify({ title: "Encoding", tone: "progress", progress: 40 });
    });
    fireEvent.click(bell());

    const now = screen.getByText("notifications.now").closest("section")!;
    const earlier = screen
      .getByText("notifications.earlier")
      .closest("section")!;
    expect(now).toHaveTextContent("Encoding");
    expect(now).not.toHaveTextContent("Old news");
    expect(earlier).toHaveTextContent("Old news");
  });

  it("dismisses one notice, or everything going on", () => {
    renderCentre();
    act(() => {
      notify({ title: "First", tone: "error" });
      notify({ title: "Second", tone: "error" });
    });
    fireEvent.click(bell());

    fireEvent.click(
      screen.getAllByRole("button", { name: "notifications.dismiss" })[0]!,
    );
    expect(getNotifications()).toHaveLength(1);

    fireEvent.click(screen.getByText("notifications.dismissAll"));
    expect(getNotifications()).toHaveLength(0);
  });

  it("closes with Escape and hands focus back to the bell", () => {
    renderCentre();
    fireEvent.click(bell());
    expect(bell()).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(bell()).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(bell());
  });
});

describe("notification lifetimes", () => {
  it("expires a short notice on its own, with nothing on screen", () => {
    act(() => {
      notify({ title: "Saved", tone: "success" });
    });
    vi.advanceTimersByTime(NOTIFICATION_LIFETIMES_MS.short - 1);
    expect(getNotifications()).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(getNotifications()).toHaveLength(0);
  });

  it("keeps a long notice well past a short one's life", () => {
    notify({ title: "Careful", tone: "warning" });
    vi.advanceTimersByTime(NOTIFICATION_LIFETIMES_MS.short + 10);
    expect(getNotifications()).toHaveLength(1);
    vi.advanceTimersByTime(NOTIFICATION_LIFETIMES_MS.long);
    expect(getNotifications()).toHaveLength(0);
  });

  it("never expires a persistent notice", () => {
    notify({ title: "Failed", tone: "error" });
    vi.advanceTimersByTime(NOTIFICATION_LIFETIMES_MS.long * 10);
    expect(getNotifications()).toHaveLength(1);
  });

  it("gives a replaced notice its full life again", () => {
    notify({ title: "Saved", tone: "success", key: "save" });
    vi.advanceTimersByTime(NOTIFICATION_LIFETIMES_MS.short - 100);
    notify({ title: "Saved again", tone: "success", key: "save" });
    vi.advanceTimersByTime(NOTIFICATION_LIFETIMES_MS.short - 100);
    expect(getNotifications()).toHaveLength(1);
    vi.advanceTimersByTime(200);
    expect(getNotifications()).toHaveLength(0);
  });

  it("holds every clock while the centre is open, and lets them go", () => {
    renderCentre();
    act(() => {
      notify({ title: "Saved", tone: "success" });
    });
    fireEvent.click(bell());
    act(() => {
      vi.advanceTimersByTime(NOTIFICATION_LIFETIMES_MS.short * 3);
    });
    expect(getNotifications()).toHaveLength(1);

    fireEvent.click(bell());
    act(() => {
      vi.advanceTimersByTime(NOTIFICATION_LIFETIMES_MS.short + 10);
    });
    expect(getNotifications()).toHaveLength(0);
  });
});
