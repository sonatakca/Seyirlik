import { describe, expect, it } from "vitest";
import { stageLogoReach } from "./logoShadowStyle";

describe("the stage logo's halo reach", () => {
  it("covers the whole halo chain, whatever the presence", () => {
    // 3px and 22px halos, then the 6px-down, 30px drop shadow.
    expect(stageLogoReach({ strength: 0.4 })).toBe(
      Math.ceil(1.5 * 3 + 1.5 * 22 + 6 + 1.5 * 30),
    );
  });

  it("covers only the drop shadow when the artwork needs no halo", () => {
    expect(stageLogoReach({ strength: 0 })).toBe(6 + 1.5 * 30);
  });
});
