import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NarrationReviewPage } from "./NarrationReviewPage";
import type {
  NarrationReview,
  NarrationReviewLine,
} from "../../lib/narrationReviewApi";

const api = vi.hoisted(() => ({
  getNarratedBooks: vi.fn(),
  getNarrationReview: vi.fn(),
  requestNarrationRetake: vi.fn(),
  setNarrationPronunciation: vi.fn(),
  removeNarrationPronunciation: vi.fn(),
}));

vi.mock("../../lib/narrationReviewApi", () => api);
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

  it("asks for a line to be read again, and shows it on its way", async () => {
    api.requestNarrationRetake.mockResolvedValue({ chunk: "1-31-1", count: 1 });
    renderPage();
    const [first] = await screen.findAllByRole("listitem");
    api.getNarrationReview.mockResolvedValue(
      review({
        sections: review().sections.map((section) =>
          section.section === 1
            ? {
                ...section,
                lines: section.lines!.map((row) => ({ ...row, asked: 1 })),
              }
            : section,
        ),
      }),
    );
    fireEvent.click(
      within(first!).getByRole("button", { name: /admin.narration.retake/ }),
    );
    await waitFor(() =>
      expect(api.requestNarrationRetake).toHaveBeenCalledWith(BOOK, "1-31-1"),
    );
    expect(
      await within(first!).findByText("admin.narration.retakeWaiting"),
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
