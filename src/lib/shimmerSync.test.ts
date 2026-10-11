import { afterEach, describe, expect, it } from "vitest";
import { SHIMMER_ANIMATION_NAME, syncShimmerSweeps } from "./shimmerSync";

function fakeAnimation(animationName: string) {
  return { animationName, startTime: 1234 as number | null };
}

function startAnimation(element: Element, animationName: string) {
  const event = new Event("animationstart", { bubbles: true });
  Object.defineProperty(event, "animationName", { value: animationName });
  element.dispatchEvent(event);
}

describe("syncShimmerSweeps", () => {
  let stop = () => {};
  afterEach(() => {
    stop();
    document.body.innerHTML = "";
  });

  it("starts a shimmer's sweep from the timeline's origin", () => {
    stop = syncShimmerSweeps();
    const element = document.createElement("div");
    document.body.append(element);
    const sweep = fakeAnimation(SHIMMER_ANIMATION_NAME);
    const other = fakeAnimation("fade-in");
    Object.assign(element, { getAnimations: () => [sweep, other] });

    startAnimation(element, SHIMMER_ANIMATION_NAME);

    expect(sweep.startTime).toBe(0);
    expect(other.startTime).toBe(1234);
  });

  it("leaves every other animation alone", () => {
    stop = syncShimmerSweeps();
    const element = document.createElement("div");
    document.body.append(element);
    const sweep = fakeAnimation(SHIMMER_ANIMATION_NAME);
    Object.assign(element, { getAnimations: () => [sweep] });

    startAnimation(element, "fade-in");

    expect(sweep.startTime).toBe(1234);
  });
});
