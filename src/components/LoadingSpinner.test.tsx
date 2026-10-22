import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LanguageProvider } from "../i18n/LanguageContext";
import { LoadingSpinner } from "./LoadingSpinner";

describe("LoadingSpinner", () => {
  it("uses the thin Material ring with a reduced-motion still", () => {
    const view = render(
      <LanguageProvider>
        <LoadingSpinner label="" />
      </LanguageProvider>,
    );

    expect(screen.getByRole("status")).toHaveAccessibleName();
    expect(view.container.querySelector("img")).toBeNull();

    const rings = view.container.querySelectorAll("md-circular-progress");
    expect(rings).toHaveLength(2);
    expect(rings[0]).toHaveAttribute("indeterminate");
    expect(rings[0]).toHaveClass("motion-reduce:hidden");
    expect(rings[1]).not.toHaveAttribute("indeterminate");
    expect(rings[1]).toHaveClass("hidden", "motion-reduce:inline-flex");
    for (const ring of rings) {
      expect(ring).toHaveAttribute("aria-hidden", "true");
      expect(
        (ring as HTMLElement).style.getPropertyValue(
          "--md-circular-progress-active-indicator-color",
        ),
      ).toBe("currentColor");
    }
  });
});
