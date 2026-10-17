/**
 * What the dashboard knows about each setting: what it is for, how to check a
 * new value, and — the part that matters most — whether its value may be
 * shown at all.
 *
 * Visibility is decided per key, and it fails closed:
 *
 *   visible   shown and edited as plain text (paths, ports, modes)
 *   masked    shown with its credentials blanked (a database URL shows the
 *             host and database, never the password)
 *   secret    never shown, never sent to a browser; it can be replaced or
 *             removed, and the dashboard only says whether it is set
 *
 * A key the catalog does not list is secret if its name looks like a
 * credential, or if it lives in secrets.env. Being in that file is somebody's
 * earlier decision that it is sensitive, and guessing otherwise is the one
 * mistake this module must not make.
 */

/**
 * @typedef {"visible" | "masked" | "secret"} Visibility
 * @typedef {"text" | "path" | "int" | "bool" | "enum" | "url" | "origins" | "json"} Kind
 * @typedef {{
 *   key: string,
 *   group: string,
 *   label: string,
 *   help: string,
 *   file: "settings" | "secrets",
 *   kind: Kind,
 *   visibility: Visibility,
 *   values?: string[],
 *   min?: number,
 *   max?: number,
 *   json?: "array" | "object",
 *   required?: boolean,
 *   mustExist?: boolean,
 * }} KeySpec
 */

export const GROUPS = [
  { id: "storage", label: "Storage" },
  { id: "process", label: "Process & network" },
  { id: "database", label: "Database" },
  { id: "credentials", label: "Credentials" },
  { id: "media", label: "Media processing" },
  { id: "library", label: "Library & files" },
  { id: "integrations", label: "Integrations" },
  { id: "other", label: "Other" },
];

/** @param {Partial<KeySpec> & { key: string, group: string, label: string, help: string }} spec @returns {KeySpec} */
function k(spec) {
  return { file: "settings", kind: "text", visibility: "visible", ...spec };
}

/** @type {KeySpec[]} */
const SPECS = [
  // ---------------------------------------------------------------- storage
  k({
    key: "SEYIRLIK_MEDIA_ROOT",
    group: "storage",
    label: "Media root",
    kind: "path",
    required: true,
    mustExist: true,
    help: "The folder that holds the library. The server will not finish starting until this folder exists.",
  }),
  k({
    key: "SEYIRLIK_GENERATED_STORAGE",
    group: "storage",
    label: "Generated storage",
    kind: "path",
    required: true,
    mustExist: true,
    help: "Artwork, trickplay and HLS working files. Keep it outside the media root.",
  }),
  k({
    key: "SEYIRLIK_PROCESSING_SCRATCH_ROOT",
    group: "storage",
    label: "Processing scratch",
    kind: "path",
    mustExist: true,
    help: "Fast disk where jobs build and verify before the result is copied to media storage.",
  }),
  k({
    key: "SEYIRLIK_RENDITION_ROOT",
    group: "storage",
    label: "Rendition root",
    kind: "path",
    help: "Legacy offline rendition output.",
  }),
  k({
    key: "SEYIRLIK_RENDITION_WORK_ROOT",
    group: "storage",
    label: "Rendition work root",
    kind: "path",
    help: "Used when the processing scratch root is unset.",
  }),
  k({
    key: "SEYIRLIK_RENDITION_STATE_ROOT",
    group: "storage",
    label: "Rendition state root",
    kind: "path",
    help: "Legacy rendition state.",
  }),
  k({
    key: "SEYIRLIK_RENDITION_LOGS_ROOT",
    group: "storage",
    label: "Rendition logs root",
    kind: "path",
    help: "Legacy rendition logs.",
  }),
  k({
    key: "SEYIRLIK_RENDITION_LOG_ROOT",
    group: "storage",
    label: "Rendition log root",
    kind: "path",
    help: "Legacy rendition logs (older spelling).",
  }),
  k({
    key: "SEYIRLIK_RENDITION_RESERVE_GB",
    group: "storage",
    label: "Free space to keep (GB)",
    kind: "int",
    min: 0,
    help: "Processing stops before media storage drops below this much free space.",
  }),
  k({
    key: "SEYIRLIK_LIVE_PROGRESS_DIR",
    group: "storage",
    label: "Live progress folder",
    kind: "path",
    help: "Where running encodes publish progress.",
  }),
  k({
    key: "SEYIRLIK_BOOK_SEARCH_MODEL_DIR",
    group: "storage",
    label: "Book search model folder",
    kind: "path",
    help: "Local model files for book search.",
  }),
  k({
    key: "SEYIRLIK_STATIC_ROOT",
    group: "storage",
    label: "Built frontend folder",
    kind: "path",
    mustExist: true,
    help: "Serve the built app from this folder alongside the API.",
  }),

  // ------------------------------------------------------- process & network
  k({
    key: "SEYIRLIK_HOST",
    group: "process",
    label: "Listen address",
    help: "Address the API listens on.",
  }),
  k({
    key: "SEYIRLIK_PORT",
    group: "process",
    label: "Port",
    kind: "int",
    min: 1,
    max: 65535,
    help: "Port the API listens on.",
  }),
  k({
    key: "SEYIRLIK_PUBLIC_ORIGIN",
    group: "process",
    label: "Public origin",
    kind: "url",
    help: "Canonical browser origin when TLS ends at a proxy.",
  }),
  k({
    key: "SEYIRLIK_ALLOWED_ORIGINS",
    group: "process",
    label: "Allowed origins",
    kind: "origins",
    help: "Comma-separated origins the browser may call the API from.",
  }),
  k({
    key: "SEYIRLIK_COOKIE_DOMAIN",
    group: "process",
    label: "Cookie domain",
    help: "Only when the app and API are on different hosts.",
  }),
  k({
    key: "SEYIRLIK_RESTART_MODE",
    group: "process",
    label: "Restart mode",
    kind: "enum",
    values: ["respawn", "supervisor", "disabled"],
    help: "Under NSSM this must be supervisor.",
  }),
  k({
    key: "SEYIRLIK_RUN_WORKER",
    group: "process",
    label: "Run worker in API process",
    kind: "bool",
    help: "Must be false when SeyirlikWorker runs as its own service.",
  }),
  k({
    key: "SEYIRLIK_USER_AGENT",
    group: "process",
    label: "User agent",
    help: "Sent to metadata providers.",
  }),
  k({
    key: "SEYIRLIK_RELEASE",
    group: "process",
    label: "Release",
    help: "Release label reported by the server.",
  }),
  k({
    key: "NODE_ENV",
    group: "process",
    label: "Node environment",
    kind: "enum",
    values: ["production", "development", "test"],
    help: "Normally production.",
  }),
  k({
    key: "SEYIRLIK_STARTUP_STALL_MS",
    group: "process",
    label: "Startup stall (ms)",
    kind: "int",
    min: 0,
    help: "How long a startup phase may stall before it is reported.",
  }),

  // ---------------------------------------------------------------- database
  k({
    key: "DATABASE_URL",
    group: "database",
    label: "Database URL",
    kind: "url",
    visibility: "masked",
    file: "secrets",
    required: true,
    help: "PostgreSQL connection. The password is never shown; to change it, enter the whole URL.",
  }),
  k({
    key: "SEYIRLIK_DATABASE_POOL_MAX",
    group: "database",
    label: "Connection pool size",
    kind: "int",
    min: 1,
    max: 200,
    help: "Maximum database connections.",
  }),
  k({
    key: "SEYIRLIK_DB_PASSWORD",
    group: "database",
    label: "Database password (Docker)",
    visibility: "secret",
    file: "secrets",
    help: "Read by docker-compose only.",
  }),
  k({
    key: "SEYIRLIK_TEST_DATABASE_URL",
    group: "database",
    label: "Test database URL",
    kind: "url",
    visibility: "masked",
    file: "secrets",
    help: "Integration tests only.",
  }),
  k({
    key: "SEYIRLIK_LAB_DATABASE_URL",
    group: "database",
    label: "Lab database URL",
    kind: "url",
    visibility: "masked",
    file: "secrets",
    help: "Media lab only.",
  }),

  // ------------------------------------------------------------- credentials
  k({
    key: "SEYIRLIK_SESSION_HASH_SECRET",
    group: "credentials",
    label: "Session hash secret",
    visibility: "secret",
    file: "secrets",
    required: true,
    help: "At least 32 bytes, different from the CSRF secret. Changing it signs everyone out.",
  }),
  k({
    key: "SEYIRLIK_CSRF_SECRET",
    group: "credentials",
    label: "CSRF secret",
    visibility: "secret",
    file: "secrets",
    required: true,
    help: "At least 32 bytes, different from the session secret.",
  }),
  k({
    key: "SEYIRLIK_TMDB_API_KEY",
    group: "credentials",
    label: "TMDB key",
    visibility: "secret",
    file: "secrets",
    help: "v3 key or v4 read token.",
  }),
  k({
    key: "SEYIRLIK_SABNZBD_API_KEY",
    group: "credentials",
    label: "SABnzbd API key",
    visibility: "secret",
    file: "secrets",
    help: "Used with the SABnzbd integration.",
  }),
  k({
    key: "SEYIRLIK_ALERTS_SECRET",
    group: "credentials",
    label: "Alerts signing secret",
    visibility: "secret",
    file: "secrets",
    help: "Signs heartbeats sent to the alert service.",
  }),

  // ---------------------------------------------------------- media processing
  k({
    key: "SEYIRLIK_FFMPEG_PATH",
    group: "media",
    label: "FFmpeg",
    kind: "path",
    mustExist: true,
    help: "Absolute path to ffmpeg.exe.",
  }),
  k({
    key: "SEYIRLIK_FFPROBE_PATH",
    group: "media",
    label: "FFprobe",
    kind: "path",
    mustExist: true,
    help: "Absolute path to ffprobe.exe.",
  }),
  k({
    key: "SEYIRLIK_FFMPEG_VIDEO_ENCODER",
    group: "media",
    label: "Video encoder",
    help: "auto, hardware, software, or an encoder such as h264_qsv.",
  }),
  k({
    key: "SEYIRLIK_RENDITION_ENCODER",
    group: "media",
    label: "Rendition encoder",
    help: "Encoder used for offline renditions.",
  }),
  k({
    key: "SEYIRLIK_RENDITION_HDR",
    group: "media",
    label: "Rendition HDR",
    help: "HDR handling for renditions.",
  }),
  k({
    key: "SEYIRLIK_MAX_VIDEO_TRANSCODES",
    group: "media",
    label: "Parallel transcodes",
    kind: "int",
    min: 0,
    max: 64,
    help: "Live transcodes allowed at once.",
  }),
  k({
    key: "SEYIRLIK_SOFTWARE_TRANSCODE_THREADS",
    group: "media",
    label: "Software threads",
    kind: "int",
    min: 1,
    max: 256,
    help: "Override for automatic topology detection.",
  }),
  k({
    key: "SEYIRLIK_SOFT_STALL_MS",
    group: "media",
    label: "Soft stall (ms)",
    kind: "int",
    min: 0,
    help: "When an encode counts as stalled.",
  }),
  k({
    key: "SEYIRLIK_HARD_STALL_MS",
    group: "media",
    label: "Hard stall (ms)",
    kind: "int",
    min: 0,
    help: "When a stalled encode is stopped.",
  }),
  k({
    key: "SEYIRLIK_STALL_KILL_GRACE_MS",
    group: "media",
    label: "Stall kill grace (ms)",
    kind: "int",
    min: 0,
    help: "Grace before a stalled encoder is killed.",
  }),
  k({
    key: "SEYIRLIK_SOURCE_PROBE_TIMEOUT_MS",
    group: "media",
    label: "Probe timeout (ms)",
    kind: "int",
    min: 0,
    help: "Timeout for probing a source file.",
  }),
  k({
    key: "SEYIRLIK_SOURCE_DAMAGE_POLICY",
    group: "media",
    label: "Damaged source policy",
    help: "What to do with a damaged source.",
  }),

  // --------------------------------------------------------- library & files
  k({
    key: "SEYIRLIK_LIBRARIES",
    group: "library",
    label: "Libraries",
    kind: "json",
    json: "array",
    help: "JSON list of libraries. Roots are relative to the media root.",
  }),
  k({
    key: "SEYIRLIK_NFO_EXPORT",
    group: "library",
    label: "NFO export",
    kind: "enum",
    values: ["disabled", "preview", "generated", "sidecar"],
    help: "How .nfo files are produced.",
  }),
  k({
    key: "SEYIRLIK_NFO_OVERWRITE",
    group: "library",
    label: "NFO overwrite",
    kind: "enum",
    values: ["managed-only", "force"],
    help: "Which existing .nfo files may be replaced.",
  }),
  k({
    key: "SEYIRLIK_NFO_ARR_MANAGED_LIBRARIES",
    group: "library",
    label: "Radarr/Sonarr libraries",
    help: "Library slugs whose .nfo files an *arr owns.",
  }),
  k({
    key: "SEYIRLIK_MEDIA_ORGANIZE",
    group: "library",
    label: "Organise folders on scan",
    kind: "enum",
    values: ["off", "plan", "apply"],
    help: "Whether a scan tidies the media folders.",
  }),
  k({
    key: "SEYIRLIK_IMPORT",
    group: "library",
    label: "Import",
    kind: "json",
    json: "object",
    help: "JSON import configuration.",
  }),
  k({
    key: "SEYIRLIK_SUBTITLES",
    group: "library",
    label: "Subtitles",
    kind: "json",
    json: "object",
    help: "JSON subtitle configuration. Keys go in their own secrets.",
  }),

  // ------------------------------------------------------------- integrations
  k({
    key: "SEYIRLIK_SABNZBD",
    group: "integrations",
    label: "SABnzbd",
    kind: "json",
    json: "object",
    help: "JSON with baseUrl and category. The key is a separate secret.",
  }),
  k({
    key: "SEYIRLIK_INDEXERS",
    group: "integrations",
    label: "Indexers",
    kind: "json",
    json: "array",
    help: "JSON list of indexers. Each key is a separate secret.",
  }),
  k({
    key: "SEYIRLIK_ALERTS_URL",
    group: "integrations",
    label: "Alerts service URL",
    kind: "url",
    help: "Where heartbeats and events are sent.",
  }),
  k({
    key: "TMDB_API_BASE_URL",
    group: "integrations",
    label: "TMDB API URL",
    kind: "url",
    help: "Override for the TMDB API.",
  }),
  k({
    key: "TMDB_IMAGE_BASE_URL",
    group: "integrations",
    label: "TMDB image URL",
    kind: "url",
    help: "Override for TMDB images.",
  }),
];

const BY_KEY = new Map(SPECS.map((spec) => [spec.key, spec]));

/** Names that are credentials whatever file they are in. */
const SECRET_NAME =
  /(SECRET|PASSWORD|PASSWD|PASSPHRASE|TOKEN|APIKEY|API_KEY|PRIVATE|CREDENTIAL|_KEY$)/;
/** Query parameters that carry a credential inside a URL. */
const SECRET_PARAM =
  /^(api[-_]?key|apikey|key|token|access[-_]?token|secret|password|pass|auth|sig|signature)$/i;

/**
 * @param {string} key
 * @param {"settings" | "secrets"} file where the key currently lives
 * @returns {KeySpec}
 */
export function specFor(key, file) {
  const known = BY_KEY.get(key);
  if (known) return known;
  const secret = file === "secrets" || SECRET_NAME.test(key);
  return {
    key,
    group: secret ? "credentials" : "other",
    label: key,
    help: secret
      ? "Not in the catalogue. Treated as a secret."
      : "Not in the catalogue.",
    file: secret ? "secrets" : "settings",
    kind: "text",
    visibility: secret ? "secret" : "visible",
  };
}

/** The keys a fresh setup is expected to have. */
export function requiredKeys() {
  return SPECS.filter((spec) => spec.required).map((spec) => spec.key);
}

export function catalogue() {
  return SPECS;
}

/**
 * What may leave the server for this value.
 *
 * Secrets return nothing. Masked values return a form with credentials
 * removed. Visible values still go through URL masking, because a URL typed
 * into a plain setting can carry a key in its query string, and the cost of
 * blanking one by mistake is a moment's confusion while the cost of showing
 * one is a leaked key.
 *
 * @param {KeySpec} spec
 * @param {string} value
 * @returns {{ display: string | null, masked: boolean }}
 */
export function presentValue(spec, value) {
  if (spec.visibility === "secret") return { display: null, masked: true };
  const masked = maskUrlCredentials(value);
  if (spec.visibility === "masked") return { display: masked, masked: true };
  return { display: masked, masked: masked !== value };
}

/**
 * Blanks the password and any credential-looking query parameter of every URL
 * in a value, including URLs inside JSON.
 *
 * @param {string} value
 */
export function maskUrlCredentials(value) {
  return value.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (candidate) => {
    let url;
    try {
      url = new URL(candidate);
    } catch {
      return candidate;
    }
    let changed = false;
    if (url.password) {
      url.password = "hidden";
      changed = true;
    }
    for (const name of [...url.searchParams.keys()]) {
      if (SECRET_PARAM.test(name)) {
        url.searchParams.set(name, "hidden");
        changed = true;
      }
    }
    return changed ? url.toString().replace(/hidden/g, "••••") : candidate;
  });
}

/**
 * Checks a proposed value. Errors stop a save; warnings are shown and the
 * operator decides. A path that does not exist is a warning, never an error:
 * pointing the media root at a drive that is about to be reconnected is a
 * legitimate thing to do.
 *
 * @param {KeySpec} spec
 * @param {string} value
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function checkValue(spec, value) {
  const errors = [];
  const warnings = [];
  const v = value.trim();
  if (value.includes("••••")) {
    // The mask itself, saved back. It would replace a working credential
    // with four dots, and the operator would not find out until it failed.
    errors.push(
      "This still contains the hidden part (••••). Enter the full value.",
    );
    return { errors, warnings };
  }
  if (v !== value && spec.kind !== "text")
    warnings.push("Leading or trailing spaces will be kept.");
  if (v === "") {
    if (spec.required)
      warnings.push(
        "This setting is required. The server will not start without it.",
      );
    return { errors, warnings };
  }
  switch (spec.kind) {
    case "int": {
      if (!/^-?\d+$/.test(v)) {
        errors.push("Must be a whole number.");
        break;
      }
      const n = Number(v);
      if (spec.min !== undefined && n < spec.min)
        errors.push(`Must be at least ${spec.min}.`);
      if (spec.max !== undefined && n > spec.max)
        errors.push(`Must be at most ${spec.max}.`);
      break;
    }
    case "bool":
      if (!["true", "false"].includes(v.toLowerCase()))
        errors.push("Must be true or false.");
      break;
    case "enum":
      if (!spec.values?.includes(v.toLowerCase()))
        errors.push(`Must be one of: ${spec.values?.join(", ")}.`);
      break;
    case "url":
      try {
        new URL(v);
      } catch {
        errors.push("Must be a full URL, for example https://example.org.");
      }
      break;
    case "origins":
      for (const part of v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        try {
          const url = new URL(part);
          if (url.origin !== part.replace(/\/$/, ""))
            warnings.push(`${part} has a path; only the origin is used.`);
        } catch {
          errors.push(`${part} is not an origin such as https://seyirlik.org.`);
        }
      }
      break;
    case "json": {
      let parsed;
      try {
        parsed = JSON.parse(v);
      } catch (error) {
        errors.push(
          `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }
      if (spec.json === "array" && !Array.isArray(parsed))
        errors.push("Must be a JSON list ([...]).");
      if (
        spec.json === "object" &&
        (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      ) {
        errors.push("Must be a JSON object ({...}).");
      }
      break;
    }
    case "path":
      if (!isAbsolutePath(v))
        errors.push("Must be an absolute path, for example D:\\media.");
      break;
  }
  if (
    spec.key === "SEYIRLIK_SESSION_HASH_SECRET" ||
    spec.key === "SEYIRLIK_CSRF_SECRET"
  ) {
    if (Buffer.byteLength(v) < 32) errors.push("Must be at least 32 bytes.");
  }
  return { errors, warnings };
}

/** Windows drive or UNC paths, or POSIX absolute paths for a development host. */
export function isAbsolutePath(value) {
  return (
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\[^\\]+\\[^\\]+/.test(value) ||
    value.startsWith("/")
  );
}
