import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { LogoLayoutEditor } from "./LogoLayoutEditor";
import type { LogoLayout } from "../../lib/logoLayout";

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

const CARD = { width: 200, height: 300 };

function renderEditor(
  layout: LogoLayout = { x: 0.5, y: 0.5, width: 0.5, shadow: 1 },
) {
  const onChange = vi.fn();
  const view = render(
    <LogoLayoutEditor
      posterUrl="https://media.test/poster.jpg"
      logoUrl="https://media.test/logo.png"
      title="Dune"
      layout={layout}
      onChange={onChange}
    />,
  );

  // jsdom has no layout, so the card reports zero unless it is told otherwise —
  // and a zero-sized card makes every pixel delta meaningless.
  const card = view.container.firstElementChild as HTMLElement;
  vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
    ...CARD,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: CARD.width,
    bottom: CARD.height,
    toJSON: () => ({}),
  });

  return { onChange, handle: screen.getByRole("application") };
}

/** jsdom does not implement pointer capture. */
function stubPointerCapture(element: HTMLElement) {
  element.setPointerCapture = vi.fn();
  element.releasePointerCapture = vi.fn();
  element.hasPointerCapture = vi.fn(() => true);
}

function drag(element: HTMLElement, deltaX: number, deltaY: number) {
  stubPointerCapture(element);
  fireEvent.pointerDown(element, { clientX: 100, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(element, {
    clientX: 100 + deltaX,
    clientY: 100 + deltaY,
    pointerId: 1,
  });
}

describe("logo layout editor", () => {
  it("previews the selected shadow strength, including opaque custom logos", () => {
    const view = render(
      <LogoLayoutEditor
        posterUrl="https://media.test/poster.jpg"
        logoUrl="https://media.test/custom-logo.png"
        title="Dune"
        layout={{ x: 0.5, y: 0.5, width: 0.5, shadow: 0 }}
        onChange={vi.fn()}
      />,
    );

    const preview = screen
      .getByAltText("Dune")
      .closest('[data-logo-shadow="true"]') as HTMLElement;
    expect(preview.style.filter).toBe("");
    expect(
      view.container.querySelector("[data-logo-shadow-backdrop]"),
    ).toBeNull();

    view.rerender(
      <LogoLayoutEditor
        posterUrl="https://media.test/poster.jpg"
        logoUrl="https://media.test/custom-logo.png"
        title="Dune"
        layout={{ x: 0.5, y: 0.5, width: 0.5, shadow: 2 }}
        onChange={vi.fn()}
      />,
    );

    expect(preview.style.filter).toContain(
      "drop-shadow(0 0 2px rgba(0, 0, 0, 0.90))",
    );
    const backdrop = view.container.querySelector<HTMLElement>(
      "[data-logo-shadow-backdrop]",
    );
    expect(backdrop?.style.filter).toBe("");
    expect(backdrop?.style.background).toContain("rgba(0, 0, 0, 0.76) 0%");
  });

  it("moves the logo with the pointer", () => {
    const { onChange, handle } = renderEditor();

    drag(handle, 20, -30);

    // 20px across a 200px card is a tenth; 30px up a 300px card is a tenth.
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        x: expect.closeTo(0.6),
        y: expect.closeTo(0.4),
      }),
    );
  });

  it("builds each move on where the drag started, not where it last landed", () => {
    // The editor is controlled, so each move re-renders it with the position
    // the previous move produced. Measuring against that instead of against the
    // start would compound every event and send the logo flying.
    const seen: LogoLayout[] = [];

    function Controlled() {
      const [layout, setLayout] = useState<LogoLayout>({
        x: 0.5,
        y: 0.5,
        width: 0.5,
        shadow: 1,
      });
      return (
        <LogoLayoutEditor
          posterUrl="https://media.test/poster.jpg"
          logoUrl="https://media.test/logo.png"
          title="Dune"
          layout={layout}
          onChange={(next) => {
            seen.push(next);
            setLayout(next);
          }}
        />
      );
    }

    const view = render(<Controlled />);
    const card = view.container.firstElementChild as HTMLElement;
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
      ...CARD,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: CARD.width,
      bottom: CARD.height,
      toJSON: () => ({}),
    });

    const handle = screen.getByRole("application");
    stubPointerCapture(handle);
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 110, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 120, clientY: 100, pointerId: 1 });

    // 20px total across a 200px card is a tenth, however many events it took.
    expect(seen.at(-1)?.x).toBeCloseTo(0.6);
  });

  it("resizes from a corner without moving the centre", () => {
    const { onChange, handle } = renderEditor();
    const corner = handle.querySelectorAll<HTMLElement>(
      '[role="presentation"]',
    )[3] as HTMLElement;

    drag(corner, 20, 0);

    expect(onChange).toHaveBeenLastCalledWith({
      x: 0.5,
      y: 0.5,
      width: expect.closeTo(0.7),
      shadow: 1,
    });
  });

  it("ignores pointer movement that did not start on a handle", () => {
    const { onChange, handle } = renderEditor();

    fireEvent.pointerMove(handle, { clientX: 200, clientY: 200, pointerId: 1 });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("stops changing once the pointer is released", () => {
    const { onChange, handle } = renderEditor();

    drag(handle, 20, 0);
    onChange.mockClear();
    fireEvent.pointerUp(handle, { clientX: 120, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 180, clientY: 100, pointerId: 1 });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("nudges with the arrow keys so a pointer is not required", () => {
    const { onChange, handle } = renderEditor();

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ x: expect.closeTo(0.51) }),
    );

    fireEvent.keyDown(handle, { key: "ArrowUp", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: expect.closeTo(0.45) }),
    );
  });

  it("resizes with the plus and minus keys", () => {
    const { onChange, handle } = renderEditor();

    fireEvent.keyDown(handle, { key: "+" });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ width: expect.closeTo(0.52) }),
    );

    fireEvent.keyDown(handle, { key: "-" });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ width: expect.closeTo(0.48) }),
    );
  });

  it("does not respond while a save is in flight", () => {
    const onChange = vi.fn();
    render(
      <LogoLayoutEditor
        posterUrl="https://media.test/poster.jpg"
        logoUrl="https://media.test/logo.png"
        title="Dune"
        layout={{ x: 0.5, y: 0.5, width: 0.5, shadow: 1 }}
        onChange={onChange}
        disabled
      />,
    );

    const handle = screen.getByRole("application");
    stubPointerCapture(handle);
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 160, clientY: 100, pointerId: 1 });
    fireEvent.keyDown(handle, { key: "ArrowRight" });

    expect(onChange).not.toHaveBeenCalled();
    // The corner handles are gone too, so there is nothing to grab.
    expect(handle.querySelectorAll('[role="presentation"]')).toHaveLength(0);
  });

  it("keeps guides out of the picture until a gesture starts, when switched off", () => {
    render(
      <LogoLayoutEditor
        posterUrl="https://media.test/poster.jpg"
        logoUrl="https://media.test/logo.png"
        title="Dune"
        layout={{ x: 0.5, y: 0.5, width: 0.5, shadow: 1 }}
        onChange={vi.fn()}
        showGuides={false}
      />,
    );

    const handle = screen.getByRole("application");
    const corners = handle.querySelectorAll<HTMLElement>(
      '[data-logo-guide="corner"]',
    );
    // Still there to grab, just not drawn.
    expect(corners).toHaveLength(4);
    corners.forEach((corner) => expect(corner).toHaveClass("opacity-0"));
    expect(handle).not.toHaveClass("ring-1");

    stubPointerCapture(handle);
    corners.forEach(stubPointerCapture);
    fireEvent.pointerDown(corners[3], {
      clientX: 100,
      clientY: 100,
      pointerId: 1,
    });

    corners.forEach((corner) => expect(corner).not.toHaveClass("opacity-0"));
    expect(handle).toHaveClass("ring-2");

    fireEvent.pointerUp(corners[3], { pointerId: 1 });
    corners.forEach((corner) => expect(corner).toHaveClass("opacity-0"));
  });
});
