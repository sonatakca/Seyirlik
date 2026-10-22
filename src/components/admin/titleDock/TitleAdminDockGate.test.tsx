import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_DOCK_HIDDEN_STORAGE_KEY,
  setAdminDockHidden,
} from "../../../lib/adminDockPreference";
import { AdminDockSwitch } from "./AdminDockSwitch";
import { TitleAdminDockGate } from "./TitleAdminDockGate";

const session = vi.hoisted(() => ({
  value: null as null | { isAdministrator: boolean },
}));

vi.mock("../../../lib/authStorage", () => ({
  getCachedSession: () => session.value,
}));
vi.mock("../../../lib/mediaApi", () => ({
  getItem: vi.fn(async () => ({ SeriesId: "show-1" })),
}));
vi.mock("../../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));
// The dock itself reads the server; the gate only decides whether it loads.
vi.mock("./TitleAdminDock", () => ({
  default: ({ scope }: { scope: unknown }) => (
    <p data-testid="dock">{JSON.stringify(scope)}</p>
  ),
}));

function renderAt(path: string, routePath: string, props: object) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path={routePath}
          element={<TitleAdminDockGate place={null} {...props} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

const FILM_ROUTE = [
  "/movies/film-1",
  "/movies/:libraryId",
  { mode: "library", libraryRouteKind: "movie" },
] as const;

describe("the title admin dock gate", () => {
  beforeEach(() => {
    window.localStorage.clear();
    session.value = { isAdministrator: true };
  });
  afterEach(() => window.localStorage.clear());

  it("shows an administrator the dock for the film they are looking at", async () => {
    renderAt(...FILM_ROUTE);
    expect(await screen.findByTestId("dock")).toHaveTextContent(
      '{"kind":"movie","itemId":"film-1"}',
    );
  });

  it("never shows it to anybody else", async () => {
    session.value = { isAdministrator: false };
    renderAt(...FILM_ROUTE);
    await act(async () => {});
    expect(screen.queryByTestId("dock")).not.toBeInTheDocument();
  });

  it("stays out of sight on a device where the administrator switched it off", async () => {
    window.localStorage.setItem(ADMIN_DOCK_HIDDEN_STORAGE_KEY, "true");
    renderAt(...FILM_ROUTE);
    await act(async () => {});
    expect(screen.queryByTestId("dock")).not.toBeInTheDocument();

    act(() => setAdminDockHidden(false));
    expect(await screen.findByTestId("dock")).toBeInTheDocument();
  });

  it("is not offered on a library's own page, which is no one title", async () => {
    renderAt("/movies/lib", "/movies/:libraryId", { mode: "library" });
    await act(async () => {});
    expect(screen.queryByTestId("dock")).not.toBeInTheDocument();
  });

  it("finds the show a season belongs to when the address does not name it", async () => {
    renderAt("/shows/season/season-2", "/shows/season/:seasonId", {
      mode: "season",
      libraryRouteKind: "show",
    });
    expect(await screen.findByTestId("dock")).toHaveTextContent(
      '{"kind":"series","seriesId":"show-1","seasonId":"season-2"}',
    );
  });
});

describe("the DevTools switch", () => {
  beforeEach(() => window.localStorage.clear());

  it("hides the dock on this device, and brings it back", async () => {
    render(<AdminDockSwitch />);
    const toggle = screen.getByRole("switch", {
      name: "titleDock.setting.label",
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(window.localStorage.getItem(ADMIN_DOCK_HIDDEN_STORAGE_KEY)).toBe(
      "true",
    );

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(
      window.localStorage.getItem(ADMIN_DOCK_HIDDEN_STORAGE_KEY),
    ).toBeNull();
  });
});
