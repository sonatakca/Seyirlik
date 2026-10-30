export interface NativeAuthConfig {
  sessionHashSecret: string;
  csrfSecret: string;
  secureCookies: boolean;
  sessionCookieName: string;
  csrfCookieName: string;
  /**
   * Set when the app and the API are served from different hosts under one
   * registrable domain. Widening the cookie to the parent domain is what lets
   * the app read the CSRF token the API issued.
   */
  cookieDomain?: string;
  /**
   * Cloudflare Turnstile keys. Creating your own account is open only when
   * both are set: without the check a bot could spend every invite it guesses
   * at, so sign-up fails closed rather than running unguarded.
   */
  turnstile?: { siteKey: string; secretKey: string };
}

type Environment = Record<string, string | undefined>;

function requiredSecret(
  environment: Environment,
  name: "SEYIRLIK_SESSION_HASH_SECRET" | "SEYIRLIK_CSRF_SECRET",
): string {
  const value = environment[name];

  if (!value) {
    throw new Error(`${name} is required when native identity is enabled.`);
  }
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`${name} must be at least 32 bytes.`);
  }
  return value;
}

export function parseNativeAuthConfig(
  environment: Environment = process.env,
): NativeAuthConfig {
  const secureCookies = environment.NODE_ENV === "production";
  const cookieDomain = parseCookieDomain(environment.SEYIRLIK_COOKIE_DOMAIN);
  const sessionHashSecret = requiredSecret(
    environment,
    "SEYIRLIK_SESSION_HASH_SECRET",
  );
  const csrfSecret = requiredSecret(environment, "SEYIRLIK_CSRF_SECRET");
  const turnstile = parseTurnstile(environment);
  if (sessionHashSecret === csrfSecret) {
    throw new Error(
      "SEYIRLIK_SESSION_HASH_SECRET and SEYIRLIK_CSRF_SECRET must be different.",
    );
  }

  return {
    sessionHashSecret,
    csrfSecret,
    secureCookies,
    sessionCookieName: secureCookies
      ? "__Secure-seyirlik_session"
      : "seyirlik_session",
    csrfCookieName: secureCookies ? "__Secure-seyirlik_csrf" : "seyirlik_csrf",
    ...(cookieDomain ? { cookieDomain } : {}),
    ...(turnstile ? { turnstile } : {}),
  };
}

function parseTurnstile(
  environment: Environment,
): { siteKey: string; secretKey: string } | undefined {
  const siteKey = environment.SEYIRLIK_TURNSTILE_SITE_KEY?.trim();
  const secretKey = environment.SEYIRLIK_TURNSTILE_SECRET_KEY?.trim();
  if (!siteKey && !secretKey) return undefined;
  if (!siteKey || !secretKey) {
    throw new Error(
      "SEYIRLIK_TURNSTILE_SITE_KEY and SEYIRLIK_TURNSTILE_SECRET_KEY must be set together.",
    );
  }
  return { siteKey, secretKey };
}

/**
 * A cookie domain widens which hosts receive the session, so it is validated
 * rather than passed through: a public suffix or a bare label here would either
 * be rejected by the browser or scope the session far wider than intended.
 */
export function parseCookieDomain(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;

  const domain = trimmed.startsWith(".") ? trimmed.slice(1) : trimmed;
  const labels = domain.split(".");

  if (
    labels.length < 2 ||
    labels.some((label) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label))
  ) {
    throw new Error(
      "SEYIRLIK_COOKIE_DOMAIN must be a domain with at least two labels.",
    );
  }

  return domain;
}
