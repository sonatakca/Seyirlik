import { randomUuid } from "../../lib/randomId";
import { trackLoadingActivity } from "../../lib/loadingActivity";

export const OWN_API_V1_BASE_PATH = "/ownAPI/v1";

/**
 * Where the API lives.
 *
 * Same-origin by default. A deployment that serves the app from one host and
 * the API from another — a static host in front, this server behind — sets
 * `VITE_OWN_API_BASE_URL` to the API origin. Both hosts must share a
 * registrable domain, so requests between them stay same-site and the session
 * cookie is still sent.
 */
export const OWN_API_ORIGIN = (
  (import.meta.env?.VITE_OWN_API_BASE_URL as string | undefined)?.trim() ?? ""
).replace(/\/+$/, "");

/** Absolute URL for an own-API path, for `<img>`, `<video>` and EventSource. */
export function ownApiUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${OWN_API_ORIGIN}${suffix}`;
}

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface OwnApiClientOptions {
  basePath?: string;
  fetchImpl?: FetchLike;
  requestIdFactory?: () => string;
  onUnauthorized?: () => void;
  csrfTokenProvider?: () => string | undefined;
}

export interface OwnApiRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Sends original file bytes instead of serializing them as JSON. */
  binaryBody?: Blob;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  csrf?: boolean;
  /** A poll or other unprompted read, which should not count as the page loading. */
  background?: boolean;
  /** Lets the request outlive the page, for a save sent as the page is left. */
  keepalive?: boolean;
}

export interface OwnApiNativeUser {
  id: string;
  username: string;
  displayName: string;
  isAdministrator: boolean;
}

export interface OwnApiPagination {
  limit: number;
  nextCursor: string | null;
  total?: number;
}

export interface OwnApiCollectionResponse<T> {
  data: T[];
  pagination: OwnApiPagination;
  requestId: string;
}

export type OwnApiOptionalDependencyStatus =
  | "available"
  | "unavailable"
  | "disabled";

export interface OwnApiHealthResponse {
  status: "ok";
  alive: boolean;
  ready: boolean;
  checks: {
    database: OwnApiOptionalDependencyStatus;
    jobs: OwnApiOptionalDependencyStatus;
    ffmpeg: "available" | "unavailable";
    ffprobe: "available" | "unavailable";
    mediaStorage: "available" | "unavailable";
    generatedStorage: "writable" | "unavailable";
  };
  /**
   * How far the server has got through startup.
   *
   * Optional because it is additive: a server from before the startup-state
   * work answers without it, and every field above means exactly what it always
   * meant. Left loosely typed here — the shape that matters to the app is
   * parsed in `serverConnectionDiagnostics`, which is the only consumer.
   */
  startup?: {
    live?: boolean;
    ready?: boolean;
    state?: string;
    phase?: string | null;
    elapsedMs?: number;
    phases?: unknown[];
  };
}

interface OwnApiSuccessEnvelope<T> {
  data: T;
  pagination?: unknown;
  requestId?: unknown;
}

interface ParsedOwnApiResponse<T> {
  envelope?: OwnApiSuccessEnvelope<T>;
  status: number;
  responseRequestId?: string;
}

interface OwnApiErrorEnvelope {
  error?: {
    code?: unknown;
    message?: unknown;
    requestId?: unknown;
  };
}

export class OwnApiClientError extends Error {
  status: number;
  code: string;
  requestId?: string;

  constructor(options: {
    status: number;
    code: string;
    message: string;
    requestId?: string;
  }) {
    super(options.message);
    this.name = "OwnApiClientError";
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
  }
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function safeRequestId(value: unknown): string | undefined {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value)
    ? value
    : undefined;
}

function invalidResponseError(
  response: Response,
  requestId?: string,
): OwnApiClientError {
  return new OwnApiClientError({
    status: response.status,
    code: "INVALID_RESPONSE",
    message: "Seyirlik returned an invalid response.",
    requestId: requestId ?? safeRequestId(response.headers.get("x-request-id")),
  });
}

function defaultRequestIdFactory(): string {
  return randomUuid();
}

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.trim().replace(/\/+$/, "");

  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    throw new Error(
      "Own API base path must be relative to the current origin.",
    );
  }

  // The configured origin is prefixed here rather than folded into the base
  // path, so path validation keeps rejecting absolute and traversing input.
  return `${OWN_API_ORIGIN}${trimmed}`;
}

function validateApiPath(apiPath: string): string {
  if (
    !apiPath.startsWith("/") ||
    apiPath.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(apiPath) ||
    apiPath.includes("\\")
  ) {
    throw new Error("Own API paths must be relative and start with one slash.");
  }

  const rawPathname = apiPath.split(/[?#]/, 1)[0] ?? "";
  const hasUnsafeSegment = rawPathname.split("/").some((segment) => {
    try {
      const decoded = decodeURIComponent(segment);
      return (
        decoded === ".." || decoded.includes("/") || decoded.includes("\\")
      );
    } catch {
      return true;
    }
  });

  if (hasUnsafeSegment) {
    throw new Error(
      "Own API paths must be relative and cannot traverse paths.",
    );
  }

  return apiPath;
}

function isJsonResponse(response: Response): boolean {
  return response.headers
    .get("content-type")
    ?.toLowerCase()
    .includes("application/json")
    ? true
    : false;
}

async function parseStructuredError(
  response: Response,
  expectedRequestId: string,
): Promise<OwnApiClientError> {
  const responseRequestId = safeRequestId(response.headers.get("x-request-id"));
  let envelope: OwnApiErrorEnvelope | null = null;

  if (isJsonResponse(response)) {
    try {
      envelope = (await response.json()) as OwnApiErrorEnvelope;
    } catch {
      envelope = null;
    }
  }

  const envelopeRequestId = safeRequestId(envelope?.error?.requestId);

  if (
    responseRequestId !== expectedRequestId ||
    envelopeRequestId !== expectedRequestId
  ) {
    return invalidResponseError(response, expectedRequestId);
  }

  const code =
    typeof envelope?.error?.code === "string"
      ? envelope.error.code
      : "HTTP_ERROR";
  const message =
    typeof envelope?.error?.message === "string"
      ? envelope.error.message
      : "Seyirlik request failed.";

  return new OwnApiClientError({
    status: response.status,
    code,
    message,
    requestId: expectedRequestId,
  });
}

export interface OwnApiClient {
  request<T>(path: string, options?: OwnApiRequestOptions): Promise<T>;
  requestCollection<T>(
    path: string,
    options?: OwnApiRequestOptions,
  ): Promise<OwnApiCollectionResponse<T>>;
  getHealth(options?: { signal?: AbortSignal }): Promise<OwnApiHealthResponse>;
  login(input: {
    username: string;
    password: string;
    deviceDescription?: string;
  }): Promise<OwnApiNativeUser>;
  getCurrentUser(options?: { signal?: AbortSignal }): Promise<OwnApiNativeUser>;
  refreshSession(): Promise<OwnApiNativeUser>;
  logout(): Promise<void>;
  logoutAll(): Promise<void>;
  getSignupConfig(): Promise<OwnApiSignupConfig>;
  signup(input: {
    username: string;
    displayName: string;
    password: string;
    inviteCode: string;
    turnstileToken: string;
  }): Promise<OwnApiNativeUser>;
}

export type OwnApiSignupConfig =
  | { enabled: true; turnstileSiteKey: string }
  | { enabled: false };

function defaultCsrfTokenProvider(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const supportedNames = ["__Secure-seyirlik_csrf", "seyirlik_csrf"];

  for (const part of document.cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (supportedNames.includes(name)) {
      return part.slice(separator + 1).trim() || undefined;
    }
  }
  return undefined;
}

function parsePagination(value: unknown): OwnApiPagination | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const limit = candidate.limit;
  const nextCursor = candidate.nextCursor;
  const total = candidate.total;

  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    (nextCursor !== null && typeof nextCursor !== "string") ||
    (total !== undefined &&
      total !== null &&
      (typeof total !== "number" || !Number.isInteger(total) || total < 0))
  ) {
    return undefined;
  }

  return {
    limit,
    nextCursor,
    ...(typeof total === "number" ? { total } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasStringValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): value is T[number] {
  return typeof value === "string" && allowed.includes(value);
}

function isOwnApiHealthResponse(value: unknown): value is OwnApiHealthResponse {
  if (!isRecord(value) || !isRecord(value.checks)) {
    return false;
  }

  const checks = value.checks;
  const optionalStatuses = ["available", "unavailable", "disabled"] as const;
  const binaryStatuses = ["available", "unavailable"] as const;

  return (
    value.status === "ok" &&
    typeof value.alive === "boolean" &&
    typeof value.ready === "boolean" &&
    hasStringValue(checks.database, optionalStatuses) &&
    hasStringValue(checks.jobs, optionalStatuses) &&
    hasStringValue(checks.ffmpeg, binaryStatuses) &&
    hasStringValue(checks.ffprobe, binaryStatuses) &&
    hasStringValue(checks.mediaStorage, binaryStatuses) &&
    hasStringValue(checks.generatedStorage, ["writable", "unavailable"])
  );
}

function isOwnApiNativeUser(value: unknown): value is OwnApiNativeUser {
  if (!isRecord(value) || Object.keys(value).length !== 4) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.username === "string" &&
    value.username.length > 0 &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    typeof value.isAdministrator === "boolean"
  );
}

function parseNativeUserPayload(value: unknown): OwnApiNativeUser | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 1) return undefined;
  return isOwnApiNativeUser(value.user) ? value.user : undefined;
}

export function createOwnApiClient({
  basePath = OWN_API_V1_BASE_PATH,
  fetchImpl = fetch,
  requestIdFactory = defaultRequestIdFactory,
  onUnauthorized,
  csrfTokenProvider = defaultCsrfTokenProvider,
}: OwnApiClientOptions = {}): OwnApiClient {
  const normalizedBasePath = normalizeBasePath(basePath);

  /**
   * A CSRF token is reissued on demand when the browser holds a session but no
   * readable token — after a cookie-path change, or once the token outlives its
   * usefulness. Without this the only recovery is for the user to sign out and
   * back in, which is not a thing an app should ask for.
   */
  async function reissueCsrfToken(): Promise<string | undefined> {
    try {
      const response = await fetchImpl(`${normalizedBasePath}/auth/csrf`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return undefined;
      return csrfTokenProvider();
    } catch {
      return undefined;
    }
  }

  async function requestEnvelope<T>(
    path: string,
    {
      method = "GET",
      body,
      binaryBody,
      signal,
      headers: additionalHeaders = {},
      background = false,
      keepalive = false,
      // Every unsafe method needs CSRF evidence. Making this opt-in meant each
      // new mutation had to remember, and every one of them forgot.
      csrf = method !== "GET",
    }: OwnApiRequestOptions = {},
  ): Promise<ParsedOwnApiResponse<T>> {
    const safePath = validateApiPath(path);
    const requestId = safeRequestId(requestIdFactory());

    if (!requestId) {
      throw new OwnApiClientError({
        status: 0,
        code: "INVALID_REQUEST_ID",
        message: "Seyirlik could not create a valid request identifier.",
      });
    }

    const headers: Record<string, string> = { Accept: "application/json" };

    if (body !== undefined && binaryBody !== undefined) {
      throw new OwnApiClientError({
        status: 0,
        code: "INVALID_REQUEST_BODY",
        message: "Seyirlik received two request body formats.",
      });
    }

    for (const [name, value] of Object.entries(additionalHeaders)) {
      const normalizedName = name.toLowerCase();

      if (
        normalizedName !== "x-request-id" &&
        normalizedName !== "content-type"
      ) {
        headers[name] = value;
      }
    }

    headers["X-Request-Id"] = requestId;

    if (csrf) {
      const csrfToken = csrfTokenProvider() ?? (await reissueCsrfToken());
      if (!csrfToken) {
        throw new OwnApiClientError({
          status: 0,
          code: "CSRF_TOKEN_UNAVAILABLE",
          message: "Seyirlik could not verify this request.",
          requestId,
        });
      }
      headers["X-CSRF-Token"] = csrfToken;
    }

    if (binaryBody !== undefined) {
      headers["Content-Type"] = binaryBody.type || "application/octet-stream";
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    let serializedBody: BodyInit | undefined = binaryBody;

    if (body !== undefined) {
      try {
        serializedBody = JSON.stringify(body);
      } catch {
        throw new OwnApiClientError({
          status: 0,
          code: "INVALID_REQUEST_BODY",
          message: "Seyirlik could not serialize the request body.",
          requestId,
        });
      }

      if (serializedBody === undefined) {
        throw new OwnApiClientError({
          status: 0,
          code: "INVALID_REQUEST_BODY",
          message: "Seyirlik could not serialize the request body.",
          requestId,
        });
      }
    }

    let response: Response;

    try {
      const pendingResponse = fetchImpl(`${normalizedBasePath}${safePath}`, {
        method,
        credentials: "include",
        headers,
        body: serializedBody,
        signal,
        ...(keepalive ? { keepalive: true } : {}),
      });
      response = await (background
        ? pendingResponse
        : trackLoadingActivity(pendingResponse));
    } catch {
      throw new OwnApiClientError({
        status: 0,
        code: signal?.aborted ? "REQUEST_ABORTED" : "NETWORK_ERROR",
        message: signal?.aborted
          ? "Seyirlik request was cancelled."
          : "Seyirlik could not reach the server.",
        requestId,
      });
    }

    if (!response.ok) {
      const error = await parseStructuredError(response, requestId);

      if (response.status === 401 && error.code !== "INVALID_RESPONSE") {
        onUnauthorized?.();
      }

      throw error;
    }

    const responseRequestId = safeRequestId(
      response.headers.get("x-request-id"),
    );

    if (response.status === 204) {
      if (responseRequestId !== requestId) {
        throw invalidResponseError(response, requestId);
      }

      return { status: response.status, responseRequestId };
    }

    if (!isJsonResponse(response)) {
      throw invalidResponseError(response, requestId);
    }

    let envelope: OwnApiSuccessEnvelope<T>;

    try {
      envelope = (await response.json()) as OwnApiSuccessEnvelope<T>;
    } catch {
      throw invalidResponseError(response, requestId);
    }

    if (
      !envelope ||
      typeof envelope !== "object" ||
      !("data" in envelope) ||
      responseRequestId !== requestId ||
      safeRequestId(envelope.requestId) !== requestId
    ) {
      throw invalidResponseError(response, requestId);
    }

    return {
      envelope,
      status: response.status,
      responseRequestId: requestId,
    };
  }

  async function request<T>(
    path: string,
    options?: OwnApiRequestOptions,
  ): Promise<T> {
    const response = await requestEnvelope<T>(path, options);
    return response.envelope?.data as T;
  }

  async function requestCollection<T>(
    path: string,
    options?: OwnApiRequestOptions,
  ): Promise<OwnApiCollectionResponse<T>> {
    const response = await requestEnvelope<T[]>(path, options);
    const envelope = response.envelope;
    const pagination = parsePagination(envelope?.pagination);
    const requestId = response.responseRequestId;

    if (
      !envelope ||
      !Array.isArray(envelope.data) ||
      !pagination ||
      !requestId
    ) {
      throw new OwnApiClientError({
        status: response.status,
        code: "INVALID_RESPONSE",
        message: "Seyirlik returned an invalid collection response.",
        requestId,
      });
    }

    return { data: envelope.data, pagination, requestId };
  }

  async function getHealth({
    signal,
  }: { signal?: AbortSignal } = {}): Promise<OwnApiHealthResponse> {
    const response = await requestEnvelope<unknown>("/health", { signal });
    const data = response.envelope?.data;

    if (!isOwnApiHealthResponse(data)) {
      throw new OwnApiClientError({
        status: response.status,
        code: "INVALID_RESPONSE",
        message: "Seyirlik returned an invalid health response.",
        requestId: response.responseRequestId,
      });
    }

    return data;
  }

  async function requestNativeUser(
    path: string,
    options?: OwnApiRequestOptions,
  ): Promise<OwnApiNativeUser> {
    const response = await requestEnvelope<unknown>(path, options);
    const user = parseNativeUserPayload(response.envelope?.data);

    if (!user) {
      throw new OwnApiClientError({
        status: response.status,
        code: "INVALID_RESPONSE",
        message: "Seyirlik returned an invalid identity response.",
        requestId: response.responseRequestId,
      });
    }

    return user;
  }

  const login: OwnApiClient["login"] = (input) =>
    // Login is the one mutation with no session to bind a CSRF token to, so the
    // server verifies it by strict origin alone. Demanding a token here would
    // make signing in impossible: there is nothing to have issued one yet.
    requestNativeUser("/auth/login", {
      method: "POST",
      body: input,
      csrf: false,
    });
  const getCurrentUser: OwnApiClient["getCurrentUser"] = (options) =>
    requestNativeUser("/auth/me", { signal: options?.signal });
  const refreshSession: OwnApiClient["refreshSession"] = () =>
    requestNativeUser("/auth/refresh", { method: "POST", csrf: true });
  const logout: OwnApiClient["logout"] = () =>
    request<void>("/auth/logout", { method: "POST", csrf: true });
  const logoutAll: OwnApiClient["logoutAll"] = () =>
    request<void>("/auth/logout-all", { method: "POST", csrf: true });
  const getSignupConfig: OwnApiClient["getSignupConfig"] = () =>
    request<OwnApiSignupConfig>("/auth/signup/config");
  const signup: OwnApiClient["signup"] = (input) =>
    // Like login: there is no session yet to bind a CSRF token to.
    requestNativeUser("/auth/signup", {
      method: "POST",
      body: input,
      csrf: false,
    });

  return {
    request,
    requestCollection,
    getHealth,
    login,
    getCurrentUser,
    refreshSession,
    logout,
    logoutAll,
    getSignupConfig,
    signup,
  };
}

export const ownApiClient = createOwnApiClient();
