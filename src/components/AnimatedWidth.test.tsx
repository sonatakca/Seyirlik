import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnimatedText } from "./AnimatedText";
import { AnimatedWidth } from "./AnimatedWidth";

/**
 * The motion itself needs a real compositor and lives in
 * labelMorph.browser.test.tsx. These pin down what a page without the Web
 * Animations API is left with.
 */
describe("AnimatedWidth", () => {
  const label = (value: string) => (
    <AnimatedWidth value={value}>
      <AnimatedText value={value} />
    </AnimatedWidth>
  );

  it("takes its width from its words, never a measured one", () => {
    const { container } = render(label("Continue Watching"));
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.style.width).toBe("");
    expect(frame.textContent).toBe("Continue Watching");
  });

  it("is left showing only the new words after a change", () => {
    const { container, rerender } = render(label("Home"));
    rerender(label("Ana Sayfa"));
    expect(container.textContent).toBe("Ana Sayfa");
  });
});
