import { describe, expect, it } from "vitest";
import { afterLoginPath, loginPathFor } from "./loginRedirect";

describe("loginRedirect", () => {
  it("returns a shared link after sign-in", () => {
    const login = loginPathFor({
      pathname: "/read/e514d26a-9a54-4fcc-b7a9-db7b199fed6d",
      search: "?page=3",
      hash: "#top",
    });
    expect(login).toBe(
      "/login?next=%2Fread%2Fe514d26a-9a54-4fcc-b7a9-db7b199fed6d%3Fpage%3D3%23top",
    );
    expect(afterLoginPath(login.slice("/login".length))).toBe(
      "/read/e514d26a-9a54-4fcc-b7a9-db7b199fed6d?page=3#top",
    );
  });

  it("falls back home when there is nowhere to return to", () => {
    expect(afterLoginPath("")).toBe("/home");
    expect(afterLoginPath("?next=%2Flogin")).toBe("/home");
    expect(loginPathFor({ pathname: "/" })).toBe("/login");
  });

  it("never leaves the site", () => {
    for (const next of [
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example/",
      "javascript:alert(1)",
      "home",
    ]) {
      expect(afterLoginPath(`?next=${encodeURIComponent(next)}`)).toBe("/home");
    }
  });
});
