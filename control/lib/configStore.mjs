/**
 * The two env files, read for display and written only by replacing them
 * whole.
 *
 * Failure model, since this is the one module here that changes state the
 * server cannot start without:
 *
 * - Writes go to a temporary file beside the target, flushed to disk, and are
 *   then renamed over it. A crash leaves either the old file or the new one,
 *   never half of each. Leftover temporary files are removed at startup.
 * - On Windows the target's permissions are copied onto the temporary file
 *   *before* the rename. If they cannot be copied the write is abandoned:
 *   secrets.env with the wrong permissions is worse than an unsaved edit.
 * - Every write names the version it was based on. If the file changed in
 *   between (Notepad, a deploy script, a second browser tab) the write is
 *   refused and the operator reloads, rather than one edit silently undoing
 *   another.
 * - The previous contents are kept in history before every write, so any
 *   change, including a restore, can itself be undone.
 * - The audit log records who changed which keys, never a value.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  applyChange,
  entriesOf,
  EnvValueError,
  parseEnv,
  serializeEnv,
} from "./envFile.mjs";
import {
  catalogue,
  checkValue,
  presentValue,
  requiredKeys,
  specFor,
} from "./catalog.mjs";

const FILE_IDS = /** @type {const} */ (["settings", "secrets"]);
const TEMP_SUFFIX = ".control-tmp";
const HISTORY_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
const HISTORY_KEEP = 40;

export class ConflictError extends Error {}
export class ValidationError extends Error {
  /** @param {string[]} errors */
  constructor(errors) {
    super(errors.join(" "));
    this.errors = errors;
  }
}
export class NotFoundError extends Error {}

/**
 * @typedef {"settings" | "secrets"} FileId
 * @typedef {{ set?: Record<string, string>, unset?: string[] }} Change
 * @typedef {{ ip: string }} Actor
 * @typedef {(from: string, to: string) => Promise<void>} CopyAcl
 */

/**
 * @param {{
 *   files: Record<FileId, string>,
 *   dataDir: string,
 *   copyAcl?: CopyAcl,
 *   now?: () => Date,
 * }} options
 */
export function createConfigStore({
  files,
  dataDir,
  copyAcl = async () => {},
  now = () => new Date(),
}) {
  const auditFile = path.join(dataDir, "audit.jsonl");
  let chain = Promise.resolve();

  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  function locked(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** @param {string} id */
  function fileId(id) {
    if (!FILE_IDS.includes(/** @type {FileId} */ (id)))
      throw new NotFoundError(`No such file: ${id}`);
    return /** @type {FileId} */ (id);
  }

  /** @param {FileId} id */
  async function read(id) {
    const target = files[id];
    try {
      const bytes = await fs.readFile(target);
      const text = bytes.toString("utf8");
      return {
        id,
        path: target,
        exists: true,
        text,
        version: versionOf(bytes),
        doc: parseEnv(text),
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return {
        id,
        path: target,
        exists: false,
        text: "",
        version: "absent",
        doc: parseEnv(""),
      };
    }
  }

  /** Everything the dashboard may show, with secrets reduced to "set". */
  async function snapshot() {
    const [settings, secrets] = await Promise.all([
      read("settings"),
      read("secrets"),
    ]);
    const secretKeys = new Set(entriesOf(secrets.doc).keys());
    const present = new Set();
    const entries = [];
    for (const file of [settings, secrets]) {
      for (const [key, entry] of entriesOf(file.doc)) {
        present.add(key);
        const spec = specFor(key, file.id);
        const shown = presentValue(spec, entry.value);
        entries.push({
          key,
          file: file.id,
          label: spec.label,
          group: spec.group,
          help: spec.help,
          kind: spec.kind,
          visibility: spec.visibility,
          values: spec.values,
          value: shown.display,
          masked: shown.masked,
          empty: entry.value === "",
          occurrences: entry.occurrences,
          warning: entry.warning,
          overridden: file.id === "settings" && secretKeys.has(key),
          misplaced:
            spec.file !== file.id && spec.visibility === "secret"
              ? "This is a credential but it is in settings.env."
              : undefined,
        });
      }
    }
    const missing = requiredKeys().filter((key) => !present.has(key));
    const available = catalogue()
      .filter((spec) => !present.has(spec.key))
      .map(({ key, label, group, help, file, kind, visibility, values }) => ({
        key,
        label,
        group,
        help,
        file,
        kind,
        visibility,
        values,
      }));
    return {
      files: Object.fromEntries(
        [settings, secrets].map((file) => [
          file.id,
          { path: file.path, exists: file.exists, version: file.version },
        ]),
      ),
      entries,
      missing,
      available,
    };
  }

  /**
   * Checks a change without writing it, and describes it in display form.
   *
   * @param {FileId} id
   * @param {Change} change
   * @param {Awaited<ReturnType<typeof read>>} [current]
   */
  async function plan(id, change, current) {
    const file = current ?? (await read(id));
    const set = change.set ?? {};
    const unset = change.unset ?? [];
    const errors = [];
    const warnings = [];
    const diff = [];
    const existing = entriesOf(file.doc);

    if (
      typeof set !== "object" ||
      Array.isArray(set) ||
      !Array.isArray(unset)
    ) {
      throw new ValidationError(["The change is malformed."]);
    }
    for (const key of unset) {
      if (typeof key !== "string" || !existing.has(key)) {
        errors.push(`${key} is not in ${id}.env.`);
        continue;
      }
      if (Object.hasOwn(set, key))
        errors.push(`${key} cannot be both changed and removed.`);
      const spec = specFor(key, id);
      if (spec.required)
        warnings.push(
          `${key} is required. The server will not start without it.`,
        );
      diff.push({
        key,
        action: "remove",
        before: presentValue(spec, existing.get(key).value).display,
        after: null,
      });
    }
    for (const [key, value] of Object.entries(set)) {
      if (typeof value !== "string") {
        errors.push(`${key} must be text.`);
        continue;
      }
      const spec = specFor(key, id);
      if (
        spec.visibility === "secret" &&
        id === "settings" &&
        spec.file === "secrets"
      ) {
        errors.push(
          `${key} is a credential. Put it in secrets.env, which only the services can read.`,
        );
        continue;
      }
      if (spec.file !== id && spec.visibility !== "secret") {
        warnings.push(`${key} normally lives in ${spec.file}.env.`);
      }
      const check = checkValue(spec, value);
      errors.push(
        ...check.errors.map((message) => `${spec.label}: ${message}`),
      );
      warnings.push(
        ...check.warnings.map((message) => `${spec.label}: ${message}`),
      );
      const before = existing.get(key);
      if (before && before.value === value) continue;
      diff.push({
        key,
        action: before ? "change" : "add",
        before: before ? presentValue(spec, before.value).display : null,
        after: presentValue(spec, value).display,
      });
    }
    try {
      applyChange(file.doc, { set, unset });
    } catch (error) {
      if (!(error instanceof EnvValueError)) throw error;
      errors.push(error.message);
    }
    return { errors, warnings, diff, version: file.version };
  }

  /**
   * @param {FileId} id
   * @param {Change & { baseVersion: string }} change
   * @param {Actor} actor
   */
  function apply(id, change, actor) {
    return locked(async () => {
      const current = await read(id);
      if (current.version !== change.baseVersion) {
        throw new ConflictError(
          `${id}.env changed since you loaded it. Reload and make the change again.`,
        );
      }
      const checked = await plan(id, change, current);
      if (checked.errors.length > 0) throw new ValidationError(checked.errors);
      const next = serializeEnv(applyChange(current.doc, change));
      if (next === current.text)
        return {
          changed: false,
          version: current.version,
          warnings: checked.warnings,
        };
      const result = await replace(current, next);
      await audit({
        action: "change",
        file: id,
        actor,
        set: Object.keys(change.set ?? {}),
        unset: change.unset ?? [],
        historyId: result.historyId,
      });
      return {
        changed: true,
        version: result.version,
        warnings: [...checked.warnings, ...result.warnings],
      };
    });
  }

  /**
   * Puts an earlier version back. The version being replaced goes into
   * history like any other, so a restore is undoable too.
   *
   * @param {FileId} id
   * @param {string} historyId
   * @param {string} baseVersion
   * @param {Actor} actor
   */
  function restore(id, historyId, baseVersion, actor) {
    return locked(async () => {
      if (!HISTORY_ID.test(historyId))
        throw new NotFoundError("No such version.");
      const current = await read(id);
      if (current.version !== baseVersion) {
        throw new ConflictError(
          `${id}.env changed since you loaded it. Reload and try again.`,
        );
      }
      let text;
      try {
        text = await fs.readFile(
          path.join(historyDir(id), `${historyId}.env`),
          "utf8",
        );
      } catch (error) {
        if (error?.code === "ENOENT")
          throw new NotFoundError("That version is no longer kept.");
        throw error;
      }
      const before = entriesOf(current.doc);
      const after = entriesOf(parseEnv(text));
      const changedKeys = [
        ...new Set([...before.keys(), ...after.keys()]),
      ].filter((key) => before.get(key)?.value !== after.get(key)?.value);
      const result = await replace(current, text);
      await audit({
        action: "restore",
        file: id,
        actor,
        restored: historyId,
        set: changedKeys,
        unset: [],
        historyId: result.historyId,
      });
      return {
        changed: true,
        version: result.version,
        warnings: result.warnings,
      };
    });
  }

  /** Newest first, from the audit log, marking which versions are still kept. */
  async function history(id, limit = 30) {
    const lines = await readAudit();
    const kept = new Set(
      (await listHistory(id)).map((name) => name.replace(/\.env$/, "")),
    );
    return lines
      .filter((entry) => entry.file === id)
      .reverse()
      .slice(0, limit)
      .map((entry) => ({
        ...entry,
        restorable: Boolean(entry.historyId && kept.has(entry.historyId)),
      }));
  }

  /** @param {Awaited<ReturnType<typeof read>>} current @param {string} text */
  async function replace(current, text) {
    const warnings = [];
    let historyId = null;
    if (current.exists) {
      historyId = stamp(now()) + "-" + randomBytes(4).toString("hex");
      const dir = historyDir(current.id);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(dir, `${historyId}.env`), current.text, {
        mode: 0o600,
        flag: "wx",
      });
      await pruneHistory(current.id);
    } else {
      warnings.push(
        `${current.id}.env did not exist and was created with its folder's permissions. Check that the services can read it.`,
      );
    }
    await writeAtomic(current.path, text, current.exists ? copyAcl : null);
    return {
      version: versionOf(Buffer.from(text, "utf8")),
      historyId,
      warnings,
    };
  }

  /** @param {Record<string, unknown>} entry */
  async function audit(entry) {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({
      id: randomBytes(6).toString("hex"),
      at: now().toISOString(),
      ...entry,
    });
    await fs.appendFile(auditFile, line + "\n", { mode: 0o600 });
  }

  async function readAudit() {
    try {
      const text = await fs.readFile(auditFile, "utf8");
      return text
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  /** @param {FileId} id */
  function historyDir(id) {
    return path.join(dataDir, "history", id);
  }

  /** @param {FileId} id */
  async function listHistory(id) {
    try {
      return (await fs.readdir(historyDir(id)))
        .filter((name) => HISTORY_ID.test(name.replace(/\.env$/, "")))
        .sort();
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  /** @param {FileId} id */
  async function pruneHistory(id) {
    const names = await listHistory(id);
    for (const name of names.slice(
      0,
      Math.max(0, names.length - HISTORY_KEEP),
    )) {
      await fs.rm(path.join(historyDir(id), name), { force: true });
    }
  }

  /** Removes temporary files a crash left beside either env file. */
  async function cleanup() {
    for (const target of Object.values(files)) {
      const dir = path.dirname(target);
      const prefix = `.${path.basename(target)}.`;
      let names = [];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.startsWith(prefix) && name.endsWith(TEMP_SUFFIX))
          await fs.rm(path.join(dir, name), { force: true });
      }
    }
  }

  return {
    fileId,
    read,
    snapshot,
    plan,
    apply,
    restore,
    history,
    cleanup,
    record: audit,
    readAudit,
  };
}

/** @param {Buffer} bytes */
function versionOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

/** @param {Date} date */
function stamp(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/**
 * @param {string} target
 * @param {string} text
 * @param {CopyAcl | null} copyAcl
 */
export async function writeAtomic(target, text, copyAcl) {
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomBytes(6).toString("hex")}${TEMP_SUFFIX}`,
  );
  const handle = await fs.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (process.platform !== "win32") {
      // POSIX: keep the original's mode, as copyAcl keeps the DACL on Windows.
      const mode = await fs.stat(target).then(
        (s) => s.mode & 0o777,
        () => null,
      );
      if (mode !== null) await fs.chmod(temp, mode);
    }
    if (copyAcl) await copyAcl(target, temp);
    await renameWithRetry(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

/**
 * Windows refuses a rename while something holds the target open without
 * sharing delete — an antivirus scan, an editor. Those are brief.
 *
 * @param {string} from
 * @param {string} to
 */
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(error?.code))
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
}
