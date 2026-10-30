import { describe, expect, it, vi } from "vitest";
import { createTurnstileVerifier } from "./turnstile";

function answering(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("the Turnstile check", () => {
  it("passes a genuine sign-up token, and sends the secret and address", async () => {
    const fetchImpl = answering({ success: true, action: "signup" });
    const verifier = createTurnstileVerifier({
      secretKey: "secret",
      fetchImpl,
    });
    expect(await verifier.verify("token", "203.0.113.9")).toEqual({
      status: "passed",
    });
    const form = (
      fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    )[1].body as URLSearchParams;
    expect(form.get("secret")).toBe("secret");
    expect(form.get("response")).toBe("token");
    expect(form.get("remoteip")).toBe("203.0.113.9");
  });

  it("refuses a token Cloudflare rejects, or one minted for another action", async () => {
    for (const body of [
      { success: false, action: "signup" },
      { success: true, action: "login" },
      { success: true },
    ]) {
      const verifier = createTurnstileVerifier({
        secretKey: "secret",
        fetchImpl: answering(body),
      });
      expect(await verifier.verify("token", undefined)).toEqual({
        status: "failed",
      });
    }
  });

  it("takes Cloudflare's test keys as they are", async () => {
    const verifier = createTurnstileVerifier({
      secretKey: "1x0000000000000000000000000000000AA",
      fetchImpl: answering({
        success: true,
        metadata: { result_with_testing_key: true },
      }),
    });
    expect(await verifier.verify("token", undefined)).toEqual({
      status: "passed",
    });
  });

  it("fails closed when Cloudflare cannot be asked", async () => {
    const down = createTurnstileVerifier({
      secretKey: "secret",
      fetchImpl: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    expect(await down.verify("token", undefined)).toEqual({
      status: "unavailable",
    });
    const erroring = createTurnstileVerifier({
      secretKey: "secret",
      fetchImpl: answering({}, 500),
    });
    expect(await erroring.verify("token", undefined)).toEqual({
      status: "unavailable",
    });
  });

  it("never asks about an empty or oversized token", async () => {
    const fetchImpl = answering({ success: true, action: "signup" });
    const verifier = createTurnstileVerifier({
      secretKey: "secret",
      fetchImpl,
    });
    expect((await verifier.verify("", undefined)).status).toBe("failed");
    expect((await verifier.verify("x".repeat(3_000), undefined)).status).toBe(
      "failed",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
