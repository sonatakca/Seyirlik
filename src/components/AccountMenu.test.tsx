import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AccountMenu } from "./AccountMenu";

const { setLanguage } = vi.hoisted(() => ({
  setLanguage: vi.fn(),
}));

vi.mock("../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key, language: "tr", setLanguage }),
}));

vi.mock("../lib/authStorage", () => ({
  getCachedSession: () => ({ username: "sonat", isAdministrator: true }),
  clearAuthSession: vi.fn(),
}));

function GoBack() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      back
    </button>
  );
}

describe("account menu", () => {
  it("stays closed on returning to the page it was left open on", () => {
    render(
      <MemoryRouter initialEntries={["/dev/tmdb-artwork"]}>
        <AccountMenu />
        <Routes>
          <Route path="/admin" element={<GoBack />} />
          <Route path="*" element={null} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /nav\.account/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "admin.entry" }));
    expect(
      screen.getByRole("button", { name: /nav\.account/ }),
    ).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "back" }));

    expect(
      screen.getByRole("button", { name: /nav\.account/ }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("switches language in place, naming both in their own words", () => {
    render(
      <MemoryRouter>
        <AccountMenu />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /nav\.account/ }));
    const turkish = screen.getByRole("menuitemradio", { name: "Türkçe" });
    const english = screen.getByRole("menuitemradio", { name: "English" });
    expect(turkish).toHaveAttribute("aria-checked", "true");
    expect(english).toHaveAttribute("aria-checked", "false");

    fireEvent.click(english);

    expect(setLanguage).toHaveBeenCalledWith("en");
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("leaves notifications to their own bell", () => {
    render(
      <MemoryRouter>
        <AccountMenu />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /nav\.account/ }));

    expect(
      screen.queryByRole("menuitem", { name: "nav.notifications" }),
    ).toBeNull();
  });
});
