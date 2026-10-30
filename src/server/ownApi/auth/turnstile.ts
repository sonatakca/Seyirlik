/**
 * Cloudflare Turnstile, the check that a sign-up came from a person in a
 * browser. The widget hands the page a one-use token; only the server can ask
 * Cloudflare whether it is genuine, with the secret key.
 */
const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 8_000;
// Cloudflare's own bound on a token.
const MAX_TOKEN_LENGTH = 2_048;

export const TURNSTILE_SIGNUP_ACTION = "signup";

export type TurnstileOutcome =
  | { status: "passed" }
  | { status: "failed" }
  /** Cloudflare could not be asked. Sign-up fails closed. */
  | { status: "unavailable" };

export interface TurnstileVerifier {
  verify(
    token: string,
    remoteIp: string | undefined,
  ): Promise<TurnstileOutcome>;
}

export function createTurnstileVerifier({
  secretKey,
  fetchImpl = fetch,
}: {
  secretKey: string;
  fetchImpl?: typeof fetch;
}): TurnstileVerifier {
  return {
    async verify(token, remoteIp) {
      if (!token || token.length > MAX_TOKEN_LENGTH) {
        return { status: "failed" };
      }

      const form = new URLSearchParams({ secret: secretKey, response: token });
      if (remoteIp && remoteIp !== "unknown") form.set("remoteip", remoteIp);

      let body: unknown;
      try {
        const response = await fetchImpl(SITEVERIFY_URL, {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
        });
        if (!response.ok) return { status: "unavailable" };
        body = await response.json();
      } catch {
        return { status: "unavailable" };
      }

      const result = body as {
        success?: unknown;
        action?: unknown;
        metadata?: { result_with_testing_key?: unknown };
      };
      if (result.success !== true) return { status: "failed" };
      // A token minted for another action on the same site key is not a
      // sign-up, whatever else it proves. Cloudflare's published test keys
      // pass every token and report no action, so they are taken as they
      // are: a test secret is no protection wherever it is used.
      if (result.metadata?.result_with_testing_key === true) {
        return { status: "passed" };
      }
      return result.action === TURNSTILE_SIGNUP_ACTION
        ? { status: "passed" }
        : { status: "failed" };
    },
  };
}
