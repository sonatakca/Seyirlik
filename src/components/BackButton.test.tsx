import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Link,
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { BackButton, NonPlayerHistoryTracker } from "./BackButton";

vi.mock("../i18n/LanguageContext", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("./AnimatedText", () => ({
  AnimatedText: ({ value }: { value: string }) => <>{value}</>,
}));

vi.mock("./AnimatedWidth", () => ({
  AnimatedWidth: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

function LocationOutput() {
  const location = useLocation();

  return <output data-testid="path">{location.pathname}</output>;
}

function TestRoutes() {
  return (
    <>
      <NonPlayerHistoryTracker />
      <LocationOutput />
      <Routes>
        <Route
          path="/home"
          element={<Link to="/library/movie-1">Movie details</Link>}
        />
        <Route
          path="/library/:itemId"
          element={
            <>
              <BackButton />
              <Link to="/watch/movie-1">Play</Link>
            </>
          }
        />
        <Route
          path="/watch/:itemId"
          element={
            <Link to="/library/movie-1" replace>
              Player back
            </Link>
          }
        />
      </Routes>
    </>
  );
}

describe("BackButton route history", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("returns library pages to the previous in-app page", async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={["/home"]}>
        <TestRoutes />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("link", { name: "Movie details" }));
    expect(screen.getByTestId("path")).toHaveTextContent("/library/movie-1");

    await user.click(screen.getByRole("button", { name: "common.back" }));
    expect(screen.getByTestId("path")).toHaveTextContent("/home");
  });

  it("keeps player back fixed to details without trapping the library back button", async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={["/home"]}>
        <TestRoutes />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("link", { name: "Movie details" }));
    await user.click(screen.getByRole("link", { name: "Play" }));
    expect(screen.getByTestId("path")).toHaveTextContent("/watch/movie-1");

    await user.click(screen.getByRole("link", { name: "Player back" }));
    expect(screen.getByTestId("path")).toHaveTextContent("/library/movie-1");

    await user.click(screen.getByRole("button", { name: "common.back" }));
    expect(screen.getByTestId("path")).toHaveTextContent("/home");
  });

  it("goes to a fixed page when there is no in-app history to go back to", async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={["/alerts"]}>
        <NonPlayerHistoryTracker />
        <LocationOutput />
        <Routes>
          <Route
            path="/alerts"
            element={<BackButton to="/home" label="Home" />}
          />
          <Route path="/home" element={<p>Home page</p>} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "Home" }));
    expect(screen.getByTestId("path")).toHaveTextContent("/home");
  });
});
