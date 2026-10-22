import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenSubtitlesAccounts } from "./OpenSubtitlesAccounts";
import type { OpenSubtitlesStatus } from "../../lib/subtitlesApi";

const api = vi.hoisted(() => ({
  getOpenSubtitlesStatus: vi.fn(),
  saveOpenSubtitlesApiKey: vi.fn(),
  clearOpenSubtitlesApiKey: vi.fn(),
  saveOpenSubtitlesAccount: vi.fn(),
  clearOpenSubtitlesAccount: vi.fn(),
}));

vi.mock("../../lib/subtitlesApi", () => api);
vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

function status(over: Partial<OpenSubtitlesStatus> = {}): OpenSubtitlesStatus {
  return {
    apiKey: { state: "active", updatedAt: null },
    accounts: [
      {
        slot: 1,
        state: "active",
        username: "first",
        reason:
          "Today's downloads are used up; they renew at 2026-10-23T03:00:00.000Z.",
        updatedAt: null,
      },
      {
        slot: 2,
        state: "signed-out",
        username: null,
        reason: null,
        updatedAt: null,
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getOpenSubtitlesStatus.mockResolvedValue(status());
});

describe("OpenSubtitles accounts", () => {
  it("names each signed-in account and says when a spent one renews", async () => {
    render(<OpenSubtitlesAccounts />);
    expect(await screen.findByText("first")).toBeTruthy();
    expect(
      screen.getByText(/admin.integrations.opensubtitles.quotaUsed/),
    ).toBeTruthy();
    expect(
      screen.getAllByText("admin.integrations.session.state.active"),
    ).toHaveLength(1);
    expect(
      screen.getByText("admin.integrations.session.state.signed-out"),
    ).toBeTruthy();
  });

  it("signs the second account in and clears the password", async () => {
    api.saveOpenSubtitlesAccount.mockResolvedValue({
      ...status(),
      allowedDownloads: 20,
      resumed: 1,
    });
    render(<OpenSubtitlesAccounts />);
    const signIns = await screen.findAllByRole("button", {
      name: "admin.integrations.session.signIn",
    });
    fireEvent.click(signIns[1]!);
    fireEvent.change(
      screen.getByLabelText("admin.integrations.opensubtitles.username"),
      { target: { value: "second" } },
    );
    fireEvent.change(
      screen.getByLabelText("admin.integrations.opensubtitles.password"),
      { target: { value: "pw" } },
    );
    const submit = screen
      .getAllByRole("button", { name: "admin.integrations.session.signIn" })
      .find((button) => button.getAttribute("type") === "submit")!;
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.saveOpenSubtitlesAccount).toHaveBeenCalledWith(2, {
        username: "second",
        password: "pw",
      }),
    );
    expect(
      await screen.findByText(
        "admin.integrations.opensubtitles.signedIn 20 admin.integrations.opensubtitles.perDay",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByLabelText("admin.integrations.opensubtitles.password"),
    ).toBeNull();
  });

  it("says plainly when OpenSubtitles refuses the password", async () => {
    api.saveOpenSubtitlesAccount.mockRejectedValue({
      status: 400,
      code: "OPENSUBTITLES_SIGN_IN_REFUSED",
    });
    render(<OpenSubtitlesAccounts />);
    const signIns = await screen.findAllByRole("button", {
      name: "admin.integrations.session.signIn",
    });
    fireEvent.click(signIns[0]!);
    fireEvent.change(
      screen.getByLabelText("admin.integrations.opensubtitles.username"),
      { target: { value: "first" } },
    );
    fireEvent.change(
      screen.getByLabelText("admin.integrations.opensubtitles.password"),
      { target: { value: "wrong" } },
    );
    fireEvent.submit(
      screen
        .getByLabelText("admin.integrations.opensubtitles.password")
        .closest("form")!,
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "admin.integrations.opensubtitles.refused",
    );
  });

  it("cannot sign an account in before the API key is saved", async () => {
    api.getOpenSubtitlesStatus.mockResolvedValue(
      status({ apiKey: { state: "signed-out", updatedAt: null } }),
    );
    render(<OpenSubtitlesAccounts />);
    const signIns = await screen.findAllByRole("button", {
      name: "admin.integrations.session.signIn",
    });
    expect(
      signIns.every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
  });
});
