import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HandDrawnLoadingMark } from "./HandDrawnLoadingMark";

describe("HandDrawnLoadingMark", () => {
  it("keeps the animated brush circle with a reduced-motion still", () => {
    const view = render(<HandDrawnLoadingMark />);

    const images = view.container.querySelectorAll("img");
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute(
      "src",
      "/artwork/seyirlik/animations/seyirlik-loading.webp",
    );
    expect(images[0]).toHaveClass("motion-reduce:hidden");
    expect(images[0]?.parentElement).toHaveClass(
      "aspect-square",
      "w-[min(10rem,36vw)]",
    );
    expect(images[1]).toHaveAttribute(
      "src",
      "/artwork/seyirlik/animations/seyirlik-loading-still.webp",
    );
    expect(images[1]).toHaveClass("motion-reduce:block");
  });
});
