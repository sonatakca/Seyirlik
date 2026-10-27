import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { DevToolsLayout } from "./DevToolsLayout";
import { WorkflowSteps } from "./WorkflowSteps";
import { ADMIN_SECTIONS, visibleGroups } from "../../lib/adminSections";

const mobile = vi.hoisted(() => ({ value: false }));

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));
vi.mock("../../hooks/useIsMobileView", () => ({
  useIsMobileView: () => mobile.value,
}));

/** Everything the production build lists, which is the set a nav must reach. */
const SHIPPED = visibleGroups({ includeDevOnly: false }).flatMap(
  (entry) => entry.sections,
);

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<DevToolsLayout />}>
          {ADMIN_SECTIONS.map((section) => (
            <Route
              key={section.id}
              path={section.path}
              element={<p>{section.id} body</p>}
            />
          ))}
          <Route path="/dev/home-curation" element={<p>curation body</p>} />
          <Route path="/admin" element={<p>overview body</p>} />
          <Route path="/dev" element={<p>overview body</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function navLinks(container: HTMLElement): HTMLAnchorElement[] {
  return Array.from(container.querySelectorAll("a"));
}

describe("the administration navigation", () => {
  it("reaches every shipped tool from any tool, without going back to the index", () => {
    mobile.value = false;
    renderAt("/admin/subtitles");

    const nav = screen.getByRole("navigation", { name: "admin.nav.label" });
    const hrefs = new Set(
      navLinks(nav).map((link) => link.getAttribute("href")),
    );

    for (const section of SHIPPED) {
      expect(
        hrefs.has(section.path),
        `${section.id} cannot be reached from the navigation`,
      ).toBe(true);
    }
    expect(hrefs.has("/admin")).toBe(true);
  });

  it("links every entry at a route the registry actually defines", () => {
    // Guards against a navigation entry that points at a neighbouring tool:
    // the label would be right and the destination wrong.
    mobile.value = false;
    renderAt("/admin");

    const nav = screen.getByRole("navigation", { name: "admin.nav.label" });
    const known = new Set([...ADMIN_SECTIONS.map((s) => s.path), "/admin"]);

    for (const link of navLinks(nav)) {
      expect(known.has(link.getAttribute("href") ?? "")).toBe(true);
    }
  });

  it("lists each tool exactly once", () => {
    mobile.value = false;
    renderAt("/admin");

    const nav = screen.getByRole("navigation", { name: "admin.nav.label" });
    const hrefs = navLinks(nav).map((link) => link.getAttribute("href"));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("marks the tool you are looking at", () => {
    mobile.value = false;
    renderAt("/admin/subtitles");

    const nav = screen.getByRole("navigation", { name: "admin.nav.label" });
    const current = navLinks(nav).filter(
      (link) => link.getAttribute("aria-current") === "page",
    );

    expect(current).toHaveLength(1);
    expect(current[0]?.getAttribute("href")).toBe("/admin/subtitles");
  });

  it("marks Curation when the old home-curation link is opened", () => {
    // The alias renders the curation editor, so it must not leave the
    // navigation showing nothing as current.
    mobile.value = false;
    renderAt("/dev/home-curation");

    const nav = screen.getByRole("navigation", { name: "admin.nav.label" });
    const current = navLinks(nav).find(
      (link) => link.getAttribute("aria-current") === "page",
    );
    expect(current?.getAttribute("href")).toBe("/dev/curation");
  });

  it("says where you are: DevTools, then the group, then the tool", () => {
    mobile.value = false;
    renderAt("/admin/acquisitions");

    const crumb = screen.getByRole("navigation", {
      name: "admin.shell.breadcrumb",
    });
    expect(
      within(crumb).getByRole("link", { name: "admin.shell.root" }),
    ).toHaveAttribute("href", "/admin");
    expect(crumb.textContent).toContain("admin.group.downloads.title");
    expect(crumb.textContent).toContain("admin.acquisitions.title");
  });

  it("treats /dev as the index, exactly like /admin", () => {
    mobile.value = false;
    renderAt("/dev");

    expect(screen.getByText("overview body")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "admin.nav.label" });
    const current = navLinks(nav).find(
      (link) => link.getAttribute("aria-current") === "page",
    );
    expect(current?.getAttribute("href")).toBe("/admin");
  });

  it("switches the player's playback details from the menu", async () => {
    mobile.value = false;
    window.localStorage.removeItem("seyirlik-player-playback-details");
    renderAt("/admin");

    const nav = screen.getByRole("navigation", { name: "admin.nav.label" });
    const toggle = within(nav).getByRole("switch", {
      name: "admin.nav.playbackDetails",
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(
      window.localStorage.getItem("seyirlik-player-playback-details"),
    ).toBe("false");
    window.localStorage.removeItem("seyirlik-player-playback-details");
  });

  it("adds no page heading of its own, so a tool keeps exactly one", () => {
    // Every tool already renders its own h1. A second one from the shell would
    // be the duplicate page header this work exists to remove.
    mobile.value = false;
    renderAt("/admin/subtitles");

    expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
  });
});

describe("the administration navigation on a narrow window", () => {
  it("is behind a disclosure rather than a sidebar", () => {
    mobile.value = true;
    renderAt("/admin/subtitles");

    expect(
      screen.queryByRole("navigation", { name: "admin.nav.label" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "admin.nav.open" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("exposes exactly the tools the sidebar does", async () => {
    mobile.value = false;
    const desktop = renderAt("/admin");
    const desktopHrefs = navLinks(
      screen.getByRole("navigation", { name: "admin.nav.label" }),
    ).map((link) => link.getAttribute("href"));
    desktop.unmount();

    mobile.value = true;
    renderAt("/admin");
    await userEvent.click(
      screen.getByRole("button", { name: "admin.nav.open" }),
    );

    const mobileHrefs = navLinks(
      screen.getByRole("navigation", { name: "admin.nav.label" }),
    ).map((link) => link.getAttribute("href"));

    expect(mobileHrefs).toEqual(desktopHrefs);
  });

  it("closes itself once a destination is chosen", async () => {
    mobile.value = true;
    renderAt("/admin");

    const toggle = screen.getByRole("button", { name: "admin.nav.open" });
    await userEvent.click(toggle);
    expect(
      screen.getByRole("navigation", { name: "admin.nav.label" }),
    ).toBeTruthy();

    await userEvent.click(
      screen.getByRole("link", { name: /admin\.subtitles\.title/ }),
    );

    expect(
      screen.queryByRole("navigation", { name: "admin.nav.label" }),
    ).toBeNull();
  });
});

describe("the route from wanting a film to having it", () => {
  it("shows all four stops, in order, from any one of them", () => {
    render(
      <MemoryRouter>
        <WorkflowSteps current="/admin/decisions" />
      </MemoryRouter>,
    );

    const strip = screen.getByRole("list", {
      name: "admin.overview.workflow.heading",
    });
    const stops = Array.from(strip.querySelectorAll("a, [aria-current]")).map(
      (node) => node.getAttribute("href") ?? "current",
    );

    expect(stops).toEqual([
      "/admin/library",
      "current",
      "/admin/acquisitions",
      "/admin/imports",
    ]);
  });

  it("marks the stop you are standing on rather than linking to it", () => {
    render(
      <MemoryRouter>
        <WorkflowSteps current="/admin/acquisitions" />
      </MemoryRouter>,
    );

    const here = screen.getByText("admin.workflow.downloads");
    expect(here.getAttribute("aria-current")).toBe("step");
    expect(here.tagName).not.toBe("A");
  });
});
