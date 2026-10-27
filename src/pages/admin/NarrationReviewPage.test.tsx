import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NarrationReviewPage } from "./NarrationReviewPage";
import type {
  NarrationReview,
  NarrationReviewLine,
} from "../../lib/narrationReviewApi";

const api = vi.hoisted(() => ({
  getNarratedBooks: vi.fn(),
  getNarrationReview: vi.fn(),
  requestNarrationRetake: vi.fn(),
  approveNarrationLine: vi.fn(),
  unapproveNarrationLine: vi.fn(),
  setNarrationPronunciation: vi.fn(),
  removeNarrationPronunciation: vi.fn(),
}));
const narrationApi = vi.hoisted(() => ({
  getBookNarration: vi.fn(),
  getNarrationAudioUrl: vi.fn(() => "/audio"),
}));

vi.mock("../../lib/narrationReviewApi", () => api);
vi.mock("../../lib/bookNarrationApi", () => narrationApi);
vi.mock("../../components/LoadingRing", () => ({ LoadingRing: () => null }));
vi.mock("../../lib/pageTitle", () => ({ setPageTitle: vi.fn() }));
vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key, language: "tr" }),
}));

const BOOK = "22222222-2222-4222-8222-222222222222";

const line = (
  chunk: string,
  text: string,
  heard: string,
  extra: Partial<NarrationReviewLine> = {},
): NarrationReviewLine => ({
  chunk,
  block: Number(chunk.split("-")[1]),
  start: 0,
  end: text.length,
  text,
  at: 60_000,
  duration: 4_000,
  heard,
  spoken: null,
  match: 0.99,
  lift: null,
  reasons: [],
  unsure: [],
  takes: 1,
  retakes: 0,
  asked: 0,
  approved: false,
  ...extra,
});

const review = (overrides: Partial<NarrationReview> = {}): NarrationReview => ({
  narration: {
    version: 1,
    state: "ready",
    voice: "mk",
    requestedAt: "2026-10-26T21:29:00Z",
    finishedAt: "2026-10-27T03:53:00Z",
    progress: null,
    error: null,
    sections: [],
  },
  sections: [
    {
      section: 0,
      duration: 5236,
      version: "00a9bd2a8b5d7416",
      lines: [
        line(
          "0-3-0",
          "istasyonla Sergievi arasındaki tenha yolda",
          "istasyonla Serciyevi arasındaki tenha yolda",
        ),
        line("0-4-0", "Hâlâ imkân yoktu.", "Hala imkan yoktu."),
      ],
    },
    {
      section: 1,
      duration: 16908,
      version: "c03d1431fffe1db2",
      lines: [
        line(
          "1-31-1",
          "mıhlanıp kaldı: Maria Puder...",
          "mıhlanıp kaldı. Maria Puder!",
          { reasons: ["tone"] },
        ),
      ],
    },
    { section: 2, duration: 100, version: "ce062a237376a2cb", lines: null },
  ],
  pronunciations: [],
  ...overrides,
});

const renderPage = (path = `/admin/narration/${BOOK}`) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/narration" element={<NarrationReviewPage />} />
        <Route
          path="/admin/narration/:itemId"
          element={<NarrationReviewPage />}
        />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  api.getNarratedBooks.mockResolvedValue([
    {
      itemId: BOOK,
      title: "Kürk Mantolu Madonna",
      state: "ready",
      sections: 3,
      duration: 22246,
      requestedAt: "",
    },
  ]);
  api.getNarrationReview.mockResolvedValue(review());
});

afterEach(() => {
  vi.useRealTimers();
});

/** The review with line 1-31-1 changed as given, and the narration as given. */
const withLine = (
  changes: Partial<NarrationReviewLine>,
  narration: Partial<NarrationReview["narration"]> = {},
) =>
  review({
    narration: { ...review().narration, ...narration },
    sections: review().sections.map((section) =>
      section.section === 1
        ? {
            ...section,
            lines: section.lines!.map((row) => ({ ...row, ...changes })),
          }
        : section,
    ),
  });

describe("the narration review page", () => {
  it("lists the narrated books", async () => {
    renderPage("/admin/narration");
    const link = await screen.findByRole("link", {
      name: /Kürk Mantolu Madonna/,
    });
    expect(link.getAttribute("href")).toBe(`/admin/narration/${BOOK}`);
  });

  it("puts the narrator's doubts first and leaves lines heard as written out", async () => {
    renderPage();
    const items = await screen.findAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(
      within(items[0]!).getByText("admin.narration.reason.tone"),
    ).toBeTruthy();
    expect(
      within(items[1]!).getByText("admin.narration.reason.heard-otherwise"),
    ).toBeTruthy();
    // "Hâlâ" heard as "Hala" is how Whisper writes, not a slip.
    expect(screen.queryByText(/Hâlâ imkân/)).toBeNull();
    // A section whose lines are still to come says so.
    expect(screen.getByText(/admin.narration.noLines/)).toBeTruthy();

    fireEvent.click(
      screen.getByRole("radio", { name: "admin.narration.filter.all" }),
    );
    expect(await screen.findByText(/Hâlâ imkân/)).toBeTruthy();
  });

  it("asks for a line to be read again, follows it back, and shows what is heard now", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.requestNarrationRetake.mockResolvedValue({ chunk: "1-31-1", count: 1 });
    renderPage();
    const first = (await screen.findAllByRole("listitem"))[0]!;
    expect(first.textContent).toContain("mıhlanıp kaldı");
    api.getNarrationReview.mockResolvedValue(
      withLine(
        { asked: 1 },
        { state: "queued", narratorSeenAt: new Date().toISOString() },
      ),
    );
    fireEvent.click(
      within(first).getByRole("button", { name: "admin.narration.retake" }),
    );
    await waitFor(() =>
      expect(api.requestNarrationRetake).toHaveBeenCalledWith(BOOK, "1-31-1"),
    );
    const status = await within(first).findByRole("status");
    expect(status.textContent).toContain("admin.narration.step.waiting");
    // Nothing to approve or ask for again while the new reading is on its way.
    expect(
      within(first).queryByRole("button", { name: "admin.narration.approve" }),
    ).toBeNull();

    // The narrator reads it: the small report says so, without the whole review.
    const narrating = {
      ...review().narration,
      state: "narrating" as const,
      progress: {
        fraction: 0.99,
        sectionsDone: 1,
        sectionsTotal: 3,
        etaSeconds: null,
        activity: "uploading",
        section: 1,
        reading: [],
        sent: 0.5,
      },
      sections: [],
    };
    narrationApi.getBookNarration.mockResolvedValue(narrating);
    api.getNarrationReview.mockResolvedValue(withLine({ asked: 1 }, narrating));
    await vi.advanceTimersByTimeAsync(3_000);
    await waitFor(() =>
      expect(within(first).getByRole("status").textContent).toContain(
        "admin.narration.step.sending",
      ),
    );
    expect(within(first).getByRole("status").textContent).toContain("50%");

    // Its part is sent; its lines are not there yet. Nothing leaves the list.
    const sent = {
      ...narrating,
      progress: {
        ...narrating.progress,
        activity: "reading",
        section: 2,
        sent: null,
      },
      sections: [
        { section: 1, duration: 16908, version: "new", checked: false },
      ],
    };
    narrationApi.getBookNarration.mockResolvedValue(sent);
    api.getNarrationReview.mockResolvedValue(
      review({
        narration: sent,
        sections: review().sections.map((section) =>
          section.section === 1
            ? { ...section, version: "new", lines: null }
            : section,
        ),
      }),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await waitFor(() =>
      expect(within(first).getByRole("status").textContent).toContain(
        "admin.narration.step.checking",
      ),
    );
    expect(screen.getAllByRole("listitem")[0]).toBe(first);
    // Only section 2's lines, as before, are said to be on their way.
    expect(screen.getAllByText(/admin.narration.noLines/)).toHaveLength(1);

    // Its part comes back with its lines: the review is read again, and the
    // line shows what is heard in it now beside what was before.
    narrationApi.getBookNarration.mockResolvedValue({
      ...narrating,
      state: "ready",
      progress: null,
      sections: [
        { section: 1, duration: 16908, version: "new", checked: true },
      ],
    });
    api.getNarrationReview.mockResolvedValue(
      withLine(
        {
          asked: 1,
          retakes: 1,
          heard: "mıhlanıp kaldı. Maria Puder.",
          reasons: [],
        },
        { state: "ready" },
      ),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(
      await within(first).findByText("admin.narration.newReading"),
    ).toBeTruthy();
    expect(
      within(first).getByText("mıhlanıp kaldı. Maria Puder."),
    ).toBeTruthy();
    expect(
      within(first).getByText("mıhlanıp kaldı. Maria Puder!"),
    ).toBeTruthy();
    expect(within(first).queryByRole("status")).toBeNull();
    // It stays in its place, to be approved or asked for again.
    expect((await screen.findAllByRole("listitem"))[0]).toBe(first);
    expect(
      within(first).getByRole("button", { name: "admin.narration.approve" }),
    ).toBeTruthy();
  });

  it("approves a line, keeps it in sight until the list is chosen again, and takes it back", async () => {
    api.approveNarrationLine.mockResolvedValue({
      chunk: "1-31-1",
      approved: true,
    });
    api.unapproveNarrationLine.mockResolvedValue({
      chunk: "1-31-1",
      approved: false,
    });
    renderPage();
    const first = (await screen.findAllByRole("listitem"))[0]!;
    fireEvent.click(
      within(first).getByRole("button", { name: "admin.narration.approve" }),
    );
    await waitFor(() =>
      expect(api.approveNarrationLine).toHaveBeenCalledWith(BOOK, "1-31-1"),
    );
    const undo = await within(first).findByRole("button", {
      name: "admin.narration.unapprove",
    });
    expect(undo.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/admin.narration.summaryApproved/)).toBeTruthy();
    // No longer one to listen to, but it does not vanish under the hand.
    expect(screen.getAllByRole("listitem")[0]).toBe(first);
    expect(api.getNarrationReview).toHaveBeenCalledTimes(1);

    fireEvent.click(undo);
    await waitFor(() =>
      expect(api.unapproveNarrationLine).toHaveBeenCalledWith(BOOK, "1-31-1"),
    );
    expect(
      await within(first).findByRole("button", {
        name: "admin.narration.approve",
      }),
    ).toBeTruthy();
  });

  it("leaves approved lines out of those to listen to", async () => {
    api.getNarrationReview.mockResolvedValue(withLine({ approved: true }));
    renderPage();
    const items = await screen.findAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain("Sergievi");
    fireEvent.click(
      screen.getByRole("radio", { name: "admin.narration.filter.all" }),
    );
    expect(
      await screen.findByRole("button", { name: "admin.narration.unapprove" }),
    ).toBeTruthy();
  });

  it("sets how a word heard otherwise is said, from the word itself", async () => {
    api.setNarrationPronunciation.mockResolvedValue({
      word: "sergievi",
      spoken: "sergi evi",
      books: 1,
    });
    renderPage();
    const word = await screen.findByRole("button", { name: /^Sergievi:/ });
    fireEvent.click(word);
    const input = screen.getByLabelText("admin.narration.howSaid");
    fireEvent.change(input, { target: { value: "sergi evi" } });
    fireEvent.click(
      screen.getAllByRole("button", { name: "admin.narration.save" })[1]!,
    );
    await waitFor(() =>
      expect(api.setNarrationPronunciation).toHaveBeenCalledWith(
        "Sergievi",
        "sergi evi",
      ),
    );
    expect(await screen.findByText("admin.narration.savedOne")).toBeTruthy();
  });

  it("takes a pronunciation off the list", async () => {
    api.getNarrationReview.mockResolvedValue(
      review({
        pronunciations: [{ word: "serciyevi", spoken: "x", updatedAt: "" }],
      }),
    );
    api.removeNarrationPronunciation.mockResolvedValue({
      word: "serciyevi",
      books: 0,
    });
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "admin.narration.remove" }),
    );
    await waitFor(() =>
      expect(api.removeNarrationPronunciation).toHaveBeenCalledWith(
        "serciyevi",
      ),
    );
  });
});
