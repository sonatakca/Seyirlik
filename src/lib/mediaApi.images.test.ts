import { describe, expect, it } from "vitest";
import { getCardLogoOverlayImageUrl, getPrimaryImageUrl } from "./mediaApi";

describe("artwork URLs", () => {
  it("requests the optimized image generation so old full-size cache entries are bypassed", () => {
    const url = new URL(
      getPrimaryImageUrl("book-1", "cover-hash", 440),
      "https://www.seyirlik.org",
    );

    expect(url.pathname).toBe("/ownAPI/v1/items/book-1/images/cover");
    expect(url.searchParams.get("tag")).toBe("cover-hash");
    expect(url.searchParams.get("maxWidth")).toBe("440");
    expect(url.searchParams.get("variant")).toBe("webp-v1");
  });

  it("turns an own-API logo into a cache-busted card overlay", () => {
    const result = getCardLogoOverlayImageUrl(
      "https://playback.seyirlik.org/ownAPI/v1/items/logo-item/images/logo?tag=logo-hash&maxWidth=420&variant=webp-v1",
      "layout-item",
      { x: 0.5, y: 0.8, width: 0.74, shadow: 1 },
      440,
    );
    const url = new URL(result!);

    expect(url.searchParams.get("tag")).toBe("logo-hash");
    expect(url.searchParams.get("variant")).toBe("card-logo-overlay-v1");
    expect(url.searchParams.get("maxWidth")).toBe("440");
    expect(url.searchParams.get("layoutItemId")).toBe("layout-item");
    expect(url.searchParams.get("layout")).toBe(
      "0.500000,0.800000,0.740000,1.000000",
    );
  });

  it("leaves a non-own-API logo to the caller's CSS fallback", () => {
    expect(
      getCardLogoOverlayImageUrl(
        "https://images.example/logo.png",
        "layout-item",
        { x: 0.5, y: 0.8, width: 0.74, shadow: 1 },
        440,
      ),
    ).toBeNull();
  });
});
