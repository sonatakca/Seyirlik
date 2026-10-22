import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "../../i18n/LanguageContext";
import { LANGUAGE_STORAGE_KEY } from "../../i18n/translations";
import type { BookSearchHit, BookSearchOutcome } from "../../lib/bookSearchApi";
import { ReaderSearch } from "./ReaderSearch";

const searchBook =
  vi.fn<(itemId: string, query: string) => Promise<BookSearchOutcome>>();

vi.mock("../../lib/bookSearchApi", () => ({
  searchBook: (itemId: string, query: string) => searchBook(itemId, query),
}));

const HIT: BookSearchHit = {
  section: 18,
  block: 42,
  anchor: "Vahşi kırbacı kaldırdı",
  text: "Vahşi kırbacı kaldırdı ve kendine vurdu.",
  score: 0.61,
};

function renderSearch(active = true, hidden = false) {
  const onShow = vi.fn();
  const view = render(
    <LanguageProvider>
      <ReaderSearch
        itemId="book-1"
        active={active}
        hidden={hidden}
        chapterOf={(section) => (section === 18 ? "On Sekizinci Bölüm" : null)}
        onShow={onShow}
      />
    </LanguageProvider>,
  );
  return { onShow, view };
}

beforeEach(() => {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
  searchBook.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("searching inside the reader", () => {
  it("asks nothing while the tab is off screen", () => {
    renderSearch(false);
    expect(searchBook).not.toHaveBeenCalled();
  });

  it("prepares the book when the tab opens, and asks again until it is ready", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    searchBook
      .mockResolvedValueOnce({ state: "preparing", progress: null })
      .mockResolvedValueOnce({ state: "preparing", progress: 0.4 })
      .mockResolvedValueOnce({ state: "ready", hits: [] });

    renderSearch();
    await act(async () => undefined);
    expect(searchBook).toHaveBeenLastCalledWith("book-1", "");
    expect(
      screen.getByText("Getting this book ready to search"),
    ).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "40",
    );
    // Slid in, never widened.
    expect(
      screen.getByRole("progressbar").querySelector("span")!.style.transform,
    ).toBe("translateX(-60%)");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(searchBook).toHaveBeenCalledTimes(3);
    expect(
      screen.getByText(/describe a moment in your own words/),
    ).toBeInTheDocument();
  });

  it("searches on Enter and opens the book at the passage chosen", async () => {
    searchBook.mockImplementation(async (_id, query) =>
      query ? { state: "ready", hits: [HIT] } : { state: "ready", hits: [] },
    );
    const { onShow } = renderSearch();
    const user = userEvent.setup();

    await user.type(
      screen.getByRole("searchbox", { name: "Search this book" }),
      "  the savage whips himself {Enter}",
    );
    expect(searchBook).toHaveBeenLastCalledWith(
      "book-1",
      "the savage whips himself",
    );

    const result = await screen.findByRole("button", {
      name: /Vahşi kırbacı kaldırdı/,
    });
    expect(result).toHaveTextContent("On Sekizinci Bölüm");
    await user.click(result);
    expect(onShow).toHaveBeenCalledWith(HIT, {
      terms: [],
      phrase: [],
      exact: false,
    });
  });

  it("shows each passage from the words it was found by, marked", async () => {
    const long: BookSearchHit = {
      section: 18,
      block: 40,
      anchor: "Uzun bir gün",
      text:
        "Uzun bir gün geçti. Herkes evine döndü, sokaklar boşaldı, " +
        "ışıklar birer birer söndü.\n" +
        "Sonra Vahşi kırbacı kaldırdı ve kendine vurdu.",
      score: 1.4,
    };
    searchBook.mockImplementation(async (_id, query) =>
      query
        ? { state: "ready", hits: [long], terms: ["kirbaç"], phrase: [] }
        : { state: "ready", hits: [] },
    );
    const { onShow } = renderSearch();
    const user = userEvent.setup();

    await user.type(screen.getByRole("searchbox"), "kirbac{Enter}");
    const result = await screen.findByRole("button", { name: /kırbacı/ });
    // From the paragraph the word is in, not from the passage's start.
    expect(result).not.toHaveTextContent("Uzun bir gün");
    expect(result).toHaveTextContent(/^…Sonra Vahşi kırbacı kaldırdı/);
    expect(result.querySelector("mark")).toHaveTextContent("kırbacı");

    await user.click(result);
    expect(onShow).toHaveBeenCalledWith(long, {
      terms: ["kirbaç"],
      phrase: [],
      exact: false,
    });
  });

  it("says it is searching until the answer comes, never that nothing matched", async () => {
    let answer: (outcome: BookSearchOutcome) => void = () => undefined;
    searchBook.mockImplementation((_id, query) =>
      query
        ? new Promise((resolve) => {
            answer = resolve;
          })
        : Promise.resolve({ state: "ready", hits: [] }),
    );
    const user = userEvent.setup();
    renderSearch();

    await user.type(screen.getByRole("searchbox"), "the savage{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent("Searching…");
    expect(
      screen.queryByText("Nothing in this book matches that."),
    ).not.toBeInTheDocument();

    expect(
      await screen.findByText(
        /first search can take a few seconds/,
        undefined,
        {
          timeout: 3000,
        },
      ),
    ).toBeInTheDocument();

    await act(async () => answer({ state: "ready", hits: [HIT] }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Vahşi kırbacı kaldırdı/ }),
    ).toBeInTheDocument();
  });

  it("says so when nothing matches, when the book cannot be searched, and when the server is away", async () => {
    searchBook.mockResolvedValue({ state: "ready", hits: [] });
    const user = userEvent.setup();
    const first = renderSearch();
    await user.type(screen.getByRole("searchbox"), "nothing{Enter}");
    expect(
      await screen.findByText("Nothing in this book matches that."),
    ).toBeInTheDocument();
    first.view.unmount();

    searchBook.mockResolvedValue({ state: "unavailable", reason: "DRM" });
    const second = renderSearch();
    expect(
      await screen.findByText("This book can't be searched."),
    ).toBeInTheDocument();
    second.view.unmount();

    searchBook.mockRejectedValue(new Error("offline"));
    renderSearch();
    expect(
      await screen.findByText(
        "Search isn't answering right now. Try again in a moment.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the search and its results while another tab is shown, and does not ask again", async () => {
    searchBook.mockImplementation(async (_id, query) =>
      query ? { state: "ready", hits: [HIT] } : { state: "ready", hits: [] },
    );
    const user = userEvent.setup();
    const { view } = renderSearch();
    await user.type(screen.getByRole("searchbox"), "kırbaç{Enter}");
    await screen.findByRole("button", { name: /Vahşi kırbacı kaldırdı/ });
    const asked = searchBook.mock.calls.length;

    const again = (active: boolean, hidden: boolean) => (
      <LanguageProvider>
        <ReaderSearch
          itemId="book-1"
          active={active}
          hidden={hidden}
          chapterOf={() => null}
          onShow={vi.fn()}
        />
      </LanguageProvider>
    );
    view.rerender(again(false, true));
    expect(screen.getByRole("tabpanel", { hidden: true })).not.toBeVisible();
    view.rerender(again(true, false));
    await act(async () => undefined);
    expect(screen.getByRole("searchbox")).toHaveValue("kırbaç");
    expect(
      screen.getByRole("button", { name: /Vahşi kırbacı kaldırdı/ }),
    ).toBeInTheDocument();
    expect(searchBook).toHaveBeenCalledTimes(asked);
  });

  it("says where in the book each passage is, once the reader has measured it", async () => {
    searchBook.mockImplementation(async (_id, query) =>
      query
        ? { state: "ready", hits: [{ ...HIT, place: 0.5 }] }
        : { state: "ready", hits: [] },
    );
    const bookPlaceOf = vi.fn((section: number, place: number) =>
      section === 18 ? 0.4 + place * 0.04 : null,
    );
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <ReaderSearch
          itemId="book-1"
          active
          chapterOf={() => "On Sekizinci Bölüm"}
          bookPlaceOf={bookPlaceOf}
          onShow={vi.fn()}
        />
      </LanguageProvider>,
    );
    await user.type(screen.getByRole("searchbox"), "kırbaç{Enter}");
    const result = await screen.findByRole("button", { name: /Vahşi/ });
    expect(bookPlaceOf).toHaveBeenCalledWith(18, 0.5);
    expect(result).toHaveTextContent("On Sekizinci Bölüm42%");
  });
});
