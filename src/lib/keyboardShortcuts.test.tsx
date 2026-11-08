import { cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useCarouselArrowKeys } from "./keyboardShortcuts";

function Carousel({
  name,
  onStep,
  isDefault = false,
  onScreen = true,
}: {
  name: string;
  onStep: (name: string, direction: string) => void;
  isDefault?: boolean;
  onScreen?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useCarouselArrowKeys(ref, (direction) => onStep(name, direction), {
    isDefault,
  });
  return (
    <div
      ref={(node) => {
        ref.current = node;
        if (node) {
          node.getBoundingClientRect = () =>
            ({
              top: onScreen ? 0 : 5000,
              bottom: onScreen ? 400 : 5400,
              height: 400,
            }) as DOMRect;
        }
      }}
    >
      <button type="button">{name} card</button>
      <input aria-label={`${name} field`} />
    </div>
  );
}

afterEach(cleanup);

it("moves the default carousel while it is on screen", () => {
  const onStep = vi.fn();
  render(
    <>
      <Carousel name="hero" isDefault onStep={onStep} />
      <Carousel name="row" onStep={onStep} />
    </>,
  );

  fireEvent.keyDown(document.body, { key: "ArrowRight" });
  fireEvent.keyDown(document.body, { key: "ArrowLeft" });

  expect(onStep.mock.calls).toEqual([
    ["hero", "next"],
    ["hero", "previous"],
  ]);
});

it("moves the carousel holding the focus over the default one", () => {
  const onStep = vi.fn();
  const { getByText } = render(
    <>
      <Carousel name="hero" isDefault onStep={onStep} />
      <Carousel name="row" onStep={onStep} />
    </>,
  );

  fireEvent.keyDown(getByText("row card"), { key: "ArrowRight" });

  expect(onStep.mock.calls).toEqual([["row", "next"]]);
});

it("leaves the keys alone when the default carousel is off screen", () => {
  const onStep = vi.fn();
  render(<Carousel name="hero" isDefault onScreen={false} onStep={onStep} />);

  const event = new KeyboardEvent("keydown", {
    key: "ArrowRight",
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(event);

  expect(onStep).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(false);
});

it("ignores arrows typed into a field, with a modifier, or held down", () => {
  const onStep = vi.fn();
  const { getByLabelText } = render(
    <Carousel name="hero" isDefault onStep={onStep} />,
  );

  fireEvent.keyDown(getByLabelText("hero field"), { key: "ArrowRight" });
  fireEvent.keyDown(document.body, { key: "ArrowRight", shiftKey: true });
  fireEvent.keyDown(document.body, { key: "ArrowRight", metaKey: true });
  fireEvent.keyDown(document.body, { key: "ArrowRight", repeat: true });

  expect(onStep).not.toHaveBeenCalled();
});

it("leaves arrows to a menu that has the focus", () => {
  const onStep = vi.fn();
  const { getByRole } = render(
    <>
      <Carousel name="hero" isDefault onStep={onStep} />
      <div role="menu">
        <button type="button" role="menuitem">
          Item
        </button>
      </div>
    </>,
  );

  fireEvent.keyDown(getByRole("menuitem"), { key: "ArrowRight" });

  expect(onStep).not.toHaveBeenCalled();
});

it("stops listening once every carousel has gone", () => {
  const onStep = vi.fn();
  const { unmount } = render(
    <Carousel name="hero" isDefault onStep={onStep} />,
  );
  unmount();

  fireEvent.keyDown(document.body, { key: "ArrowRight" });

  expect(onStep).not.toHaveBeenCalled();
});
