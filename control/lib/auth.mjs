/**
 * Who may use the dashboard.
 *
 * Three independent locks, any one of which refuses a request:
 *
 * 1. The network. The service listens on the Tailscale address (and
 *    loopback) only, and additionally refuses any peer outside Tailscale's
 *    address ranges, so a misconfigured listen address cannot expose it.
 * 2. The Host header. A page on the internet can resolve its own name to a
 *    tailnet address (DNS rebinding); it cannot make the browser send a Host
 *    this service recognises.
 * 3. A password, checked against an scrypt hash, with failed attempts
 *    throttled. The session is an HttpOnly, SameSite=Strict cookie, and every
 *    request that changes something must also carry a custom header, which a
 *    cross-site form cannot send.
 *
 * This deliberately does not reuse the site's admin login: that lives in
 * PostgreSQL, and the moment this dashboard is most needed is the moment the
 * database may not be running.
 */
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";
import os from "node:os";
import { promisify } from "node:util";

const scrypt =
  /** @type {(password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>} */ (
    promisify(scryptCallback)
  );

const COST = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 32;
export const SESSION_COOKIE = "seyirlik_control";
export const CSRF_HEADER = "x-seyirlik-control";
const SESSION_MS = 12 * 60 * 60 * 1000;
const IDLE_MS = 2 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const FAILURES_PER_PEER = 5;
const FAILURES_TOTAL = 20;
export const MIN_PASSWORD_LENGTH = 12;

/** @param {string} password @returns {Promise<string>} */
export async function hashPassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH, COST);
  return [
    "scrypt",
    COST.N,
    COST.r,
    COST.p,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

/** @param {string} password @param {string | undefined} stored @returns {Promise<boolean>} */
export async function verifyPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isInteger)) return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await scrypt(password, salt, KEY_LENGTH, {
    N,
    r,
    p,
    maxmem: COST.maxmem,
  });
  return timingSafeEqual(actual, expected);
}

/**
 * Tailscale's IPv4 range (100.64.0.0/10), its IPv6 range (fd7a:115c:a1e0::/48)
 * and loopback. Everything else is refused.
 *
 * @param {string | undefined} address
 */
export function isAllowedPeer(address) {
  if (!address) return false;
  const ip = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 127 || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    return lower === "::1" || lower.startsWith("fd7a:115c:a1e0:");
  }
  return false;
}

/**
 * @param {string | undefined} hostHeader
 * @param {{ listen: string[], allowedHosts?: string[] }} config
 */
export function isAllowedHost(hostHeader, config) {
  if (!hostHeader) return false;
  const host = hostHeader
    .replace(/:\d+$/, "")
    .replace(/^\[(.*)\]$/, "$1")
    .toLowerCase();
  const machine = os.hostname().toLowerCase();
  const allowed = new Set(
    [
      "localhost",
      "127.0.0.1",
      "::1",
      machine,
      ...config.listen,
      ...(config.allowedHosts ?? []),
    ].map((h) => h.toLowerCase()),
  );
  if (allowed.has(host)) return true;
  // MagicDNS: <machine>.<tailnet>.ts.net
  return host.startsWith(machine + ".") && host.endsWith(".ts.net");
}

/** @param {{ now?: () => number }} [options] */
export function createSessions({ now = Date.now } = {}) {
  /** @type {Map<string, { created: number, seen: number, ip: string }>} */
  const sessions = new Map();
  /** @type {{ at: number, ip: string }[]} */
  let failures = [];

  function prune() {
    const t = now();
    failures = failures.filter((f) => t - f.at < FAILURE_WINDOW_MS);
    for (const [token, s] of sessions) {
      if (t - s.created > SESSION_MS || t - s.seen > IDLE_MS)
        sessions.delete(token);
    }
  }

  return {
    /** Whether a login from this peer may be attempted now. @param {string} ip */
    canAttempt(ip) {
      prune();
      const mine = failures.filter((f) => f.ip === ip).length;
      return mine < FAILURES_PER_PEER && failures.length < FAILURES_TOTAL;
    },
    /** @param {string} ip */
    recordFailure(ip) {
      failures.push({ at: now(), ip });
    },
    /** @param {string} ip */
    create(ip) {
      prune();
      const token = randomBytes(32).toString("base64url");
      const t = now();
      sessions.set(token, { created: t, seen: t, ip });
      return token;
    },
    /** @param {string | undefined} token */
    check(token) {
      if (!token) return null;
      prune();
      const session = sessions.get(token);
      if (!session) return null;
      session.seen = now();
      return session;
    },
    /** @param {string | undefined} token */
    destroy(token) {
      if (token) sessions.delete(token);
    },
    /** Every session ends, for example after the password changes. */
    clear() {
      sessions.clear();
    },
  };
}

/** @param {string | undefined} header */
export function readCookie(header, name = SESSION_COOKIE) {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

/** @param {string} token */
export function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`;
}

export function clearedCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}
