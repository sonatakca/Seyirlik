import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportsPage } from "./ImportsPage";
import type { ImportRow } from "../../lib/importsApi";

const api = vi.hoisted(() => ({
  listImports: vi.fn(),
  retryImport: vi.fn(),
  reconcileImport: vi.fn(),
}));

vi.mock("../../lib/importsApi", () => api);
vi.mock("../../lib/pageTitle", () => ({ setPageTitle: vi.fn() }));
vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

function row(over: Partial<ImportRow> = {}): ImportRow {
  return {
    id: "i1",
    state: "complete",
    strategy: "hardlink",
    target: { kind: "movie", title: "Dune" },
    attempt: 1,
    isUpgrade: false,
    files: [
      {
        role: "media",
        state: "committed",
        destination: "Dune (2021)/src/Dune (2021).mkv",
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <ImportsPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  api.listImports.mockResolvedValue([row()]);
});

describe("the storage gate", () => {
  it("says storage is not authorised when the importer is not configured", async () => {
    /*
     * The routes are mounted only when a download root is configured, so a 404
     * is the answer to whether importing is set up — not a failure.
     */
    api.listImports.mockRejectedValue(
      Object.assign(new Error("nope"), { status: 404 }),
    );
    renderPage();

    expect(await screen.findByText("admin.imports.gate.title")).toBeTruthy();
    expect(screen.getByText("admin.imports.gate.notConfigured")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers nothing that would open the gate", async () => {
    // The gate is derived from the server's own configuration. A control that
    // overrode it here would disagree with the thing that enforces it.
    api.listImports.mockRejectedValue(
      Object.assign(new Error("nope"), { status: 404 }),
    );
    renderPage();
    await screen.findByText("admin.imports.gate.title");

    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual(["admin.imports.refresh"]);
  });

  it("replays the recorded drive facts rather than measuring them", async () => {
    /*
     * The expansion drive is out of scope until it has been imaged, so the
     * page shows a dated note and never asks the volume anything.
     */
    api.listImports.mockRejectedValue(
      Object.assign(new Error("nope"), { status: 404 }),
    );
    renderPage();

    const note = await screen.findByText(/exFAT/);
    expect(note.textContent).toContain("admin.imports.gate.hardlinksNo");
    expect(note.textContent).toContain("admin.imports.strategy.move");
    expect(note.textContent).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("does not show the gate when the importer is configured", async () => {
    renderPage();
    await screen.findByText("Dune");
    expect(screen.queryByText("admin.imports.gate.title")).toBeNull();
  });
});

describe("the import list", () => {
  it("shows the operation actually used, and the library-relative destination", async () => {
    renderPage();
    await screen.findByText("Dune");
    expect(screen.getByText(/admin\.imports\.strategy\.hardlink/)).toBeTruthy();
    expect(
      screen.getByText(/Dune \(2021\)\/src\/Dune \(2021\)\.mkv/),
    ).toBeTruthy();
  });

  it("carries no absolute path into the page", async () => {
    // The server sends library-relative destinations only.
    renderPage();
    await screen.findByText("Dune");
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/[A-Z]:\\\\/);
    expect(html).not.toMatch(/SeyirlikDownloads/);
  });

  it("offers reconciliation exactly where the outcome is unknown", async () => {
    api.listImports.mockResolvedValue([row({ state: "uncertain" })]);
    renderPage();
    expect(await screen.findByText("admin.imports.reconcile")).toBeTruthy();
    expect(screen.queryByText("admin.imports.retry")).toBeNull();
  });

  it("offers a retry where a person can resolve it", async () => {
    api.listImports.mockResolvedValue([row({ state: "needs_attention" })]);
    renderPage();
    expect(await screen.findByText("admin.imports.retry")).toBeTruthy();
  });

  it("offers neither on an import that finished", async () => {
    renderPage();
    await screen.findByText("Dune");
    expect(screen.queryByText("admin.imports.retry")).toBeNull();
    expect(screen.queryByText("admin.imports.reconcile")).toBeNull();
  });

  it("shows the imported file's way to Google Drive, and follows it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const now = Date.now();
      api.listImports.mockResolvedValue([
        row({
          driveUpload: {
            state: "uploading",
            totalBytes: 7_603_618_701,
            uploadedBytes: 3_497_664_602,
            filesPending: 1,
            filesUploading: 1,
            bytesPerSecond: 2_800_000,
            etaSeconds: 1_466,
            startedAtMs: now - 600_000,
            updatedAtMs: now,
          },
        }),
      ]);
      renderPage();
      expect(await screen.findByText("processing.upload.heading")).toBeTruthy();
      expect(screen.getByText("46.0%")).toBeTruthy();
      expect(api.listImports).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(api.listImports).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops reading again once nothing is uploading", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.listImports.mockResolvedValue([
        row({
          driveUpload: {
            state: "uploaded",
            totalBytes: 100,
            uploadedBytes: 100,
            filesPending: 0,
            filesUploading: 0,
            startedAtMs: 0,
            updatedAtMs: 60_000,
            finishedAtMs: 60_000,
          },
        }),
      ]);
      renderPage();
      expect(await screen.findByText("processing.upload.done")).toBeTruthy();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(api.listImports).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a real failure without repeating what was thrown", async () => {
    api.listImports.mockRejectedValue(
      Object.assign(new Error("fetch http://127.0.0.1:43111 failed"), {
        status: 500,
      }),
    );
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("admin.imports.loadFailed");
    expect(alert.textContent).not.toContain("127.0.0.1");
  });
});
