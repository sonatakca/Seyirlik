import { describe, expect, it, vi } from "vitest";
import {
  lookUpCard,
  renderSharePreview,
  sitePath,
  titleIdFromPath,
} from "../../../../api/share-preview";

const ID = "5067a585-9b54-25ed-c8a0-2f32a05c8bc6";
const API = "https://playback.seyirlik.org";

describe("the link preview's page", () => {
  it("finds the title in each address the site gives one", () => {
    for (const path of [
      `/movies/${ID}`,
      `/shows/${ID}`,
      `/shows/11111111-1111-4111-8111-111111111111/season/${ID}`,
      `/shows/season/${ID}`,
      `/series/${ID}`,
      `/season/${ID}`,
      `/library/${ID}`,
      `/watch/${ID}`,
      `/read/${ID.replace(/-/g, "")}`,
    ]) {
      expect(titleIdFromPath(path), path).toBe(ID);
    }
    expect(titleIdFromPath("/home")).toBeNull();
    expect(titleIdFromPath("/movies")).toBeNull();
    expect(titleIdFromPath(`/dev/${ID}`)).toBeNull();
  });

  it("keeps the address on the site", () => {
    expect(sitePath(`/movies/${ID}`)).toBe(`/movies/${ID}`);
    expect(sitePath("//evil.example/x")).toBe("/x");
    expect(sitePath("https://evil.example/movies")).toBe(
      "/https://evil.example/movies",
    );
    expect(sitePath(null)).toBe("/");
  });

  it("names the title and shows its card", () => {
    const html = renderSharePreview(
      `/movies/${ID}`,
      {
        kind: "movie",
        title: `Dune: Part Two (2024) <script>`,
        description: `Paul "Muad'Dib" Atreides`,
        image: {
          path: `/ownAPI/v1/share/items/${ID}/image?v=abc`,
          width: 2000,
          height: 3000,
          type: "image/jpeg",
        },
      },
      API,
    );
    expect(html).toContain(
      `<meta property="og:title" content="Dune: Part Two (2024) &lt;script&gt;" />`,
    );
    expect(html).toContain(`content="Paul &quot;Muad&#39;Dib&quot; Atreides"`);
    expect(html).toContain(
      `<meta property="og:image" content="${API}/ownAPI/v1/share/items/${ID}/image?v=abc" />`,
    );
    expect(html).toContain(`content="video.movie"`);
    expect(html).toContain(`content="https://www.seyirlik.org/movies/${ID}"`);
    expect(html).not.toContain("<script>");
  });

  it("keeps the rainbow preview for a title with no card", () => {
    const html = renderSharePreview(
      `/read/${ID}`,
      {
        kind: "book",
        title: "Kürk Mantolu Madonna",
        description: null,
        image: null,
      },
      API,
    );
    expect(html).toContain(
      `content="https://www.seyirlik.org/seyirlik-preview.png"`,
    );
    expect(html).toContain(`content="Kürk Mantolu Madonna"`);
    expect(html).not.toContain(`name="description"`);
  });

  it("falls back to the site's own preview when the server cannot say", async () => {
    const down = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await lookUpCard(ID, API, down)).toBeNull();
    const missing = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 404 }));
    expect(await lookUpCard(ID, API, missing)).toBeNull();
    // An image the server did not serve itself is never put in a preview.
    const foreign = vi.fn().mockResolvedValue(
      Response.json({
        data: {
          kind: "movie",
          title: "x",
          description: null,
          image: {
            path: "https://evil.example/a.jpg",
            width: 1,
            height: 1,
            type: "image/jpeg",
          },
        },
      }),
    );
    expect(await lookUpCard(ID, API, foreign)).toBeNull();

    const html = renderSharePreview(`/movies/${ID}`, null, API);
    expect(html).toContain("<title>Seyirlik</title>");
    expect(html).toContain("seyirlik-preview.png");
  });
});
