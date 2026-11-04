/**
 * The machine: services, drives, file permissions, logs.
 *
 * Anything that touches a disk the dashboard does not own runs in a child
 * process with a deadline. That is not caution for its own sake: the failure
 * this dashboard exists for is a media drive that has wedged, and a `stat` on
 * a wedged drive can block forever. In-process, a few of those would take
 * every thread in Node's pool and the dashboard would hang exactly when it is
 * needed. A child process that hangs is killed instead.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const COMMAND_TIMEOUT_MS = 15_000;
const PATH_CHECK_TIMEOUT_MS = 5_000;
const LOG_NAME = /^[\w .()-]+\.(log|txt)$/i;
const MAX_TAIL_BYTES = 512 * 1024;

/**
 * @typedef {{ name: string, state: string, startMode?: string, pid?: number }} ServiceState
 * @typedef {{ id: string, label?: string, fileSystem?: string, type: string, size?: number, free?: number }} Drive
 * @typedef {{ path: string, exists: boolean, directory?: boolean, file?: boolean, free?: number, size?: number, error?: string }} PathInfo
 */

/**
 * @param {string} file
 * @param {string[]} args
 * @param {number} [timeout]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function run(file, args, timeout = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error
          ? typeof error.code === "number"
            ? error.code
            : -1
          : 0;
        resolve({
          code,
          stdout: String(stdout),
          stderr:
            String(stderr) +
            (error && code === -1 ? String(error.message) : ""),
        });
      },
    );
  });
}

/** A PowerShell literal string: single-quoted, single quotes doubled. */
export function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/** @param {string} script */
function powershell(script, timeout = COMMAND_TIMEOUT_MS) {
  const encoded = Buffer.from(
    "$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';" +
      script,
    "utf16le",
  ).toString("base64");
  return run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ],
    timeout,
  );
}

/** @param {string} text */
function parseJsonList(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
}

const SC_STATES = {
  1: "stopped",
  2: "starting",
  3: "stopping",
  4: "running",
  5: "resuming",
  6: "pausing",
  7: "paused",
};

/** @type {Record<string, string>} */
const CIM_STATES = {
  Stopped: "stopped",
  "Start Pending": "starting",
  "Stop Pending": "stopping",
  Running: "running",
  "Continue Pending": "resuming",
  "Pause Pending": "pausing",
  Paused: "paused",
};

/** @param {string} output */
export function parseScState(output) {
  const match = /STATE\s*:\s*(\d+)/.exec(output);
  return match
    ? (SC_STATES[/** @type {keyof typeof SC_STATES} */ (Number(match[1]))] ??
        "unknown")
    : "unknown";
}

/** @returns {Platform} */
export function windowsPlatform() {
  /** @param {string} name */
  async function scState(name) {
    const result = await run("sc.exe", ["query", name]);
    if (result.code === 1060) return "missing";
    return parseScState(result.stdout);
  }

  /** @param {string} name @param {string} want @param {number} seconds */
  async function waitFor(name, want, seconds) {
    for (let i = 0; i < seconds; i++) {
      if ((await scState(name)) === want) return true;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }

  /** @param {string} name @param {"start" | "stop"} verb */
  async function sc(name, verb) {
    const result = await run("sc.exe", [verb, name]);
    // 1056: already running. 1062: not started. Both mean "already there".
    if (result.code !== 0 && result.code !== 1056 && result.code !== 1062) {
      throw new Error(
        `sc ${verb} ${name} failed (${result.code}): ${(result.stdout + result.stderr).trim().split(/\r?\n/).pop()}`,
      );
    }
  }

  return {
    name: "windows",
    async services(names) {
      if (names.length === 0) return [];
      const list = names.map(psQuote).join(",");
      const result = await powershell(
        `Get-CimInstance Win32_Service | Where-Object { @(${list}) -contains $_.Name } | Select-Object Name,State,StartMode,ProcessId | ConvertTo-Json -Compress`,
      );
      if (result.code !== 0)
        throw new Error(result.stderr.trim() || "Could not read services.");
      const found = new Map(
        parseJsonList(result.stdout).map((s) => [s.Name, s]),
      );
      return names.map((name) => {
        const s = found.get(name);
        if (!s) return { name, state: "missing" };
        return {
          name,
          state: CIM_STATES[String(s.State)] ?? "unknown",
          startMode: s.StartMode,
          pid: s.ProcessId || undefined,
        };
      });
    },
    async serviceAction(name, action) {
      if (action === "start") {
        await sc(name, "start");
        if (!(await waitFor(name, "running", 60)))
          throw new Error(`${name} did not reach running within 60 s.`);
      } else if (action === "stop") {
        await sc(name, "stop");
        if (!(await waitFor(name, "stopped", 90)))
          throw new Error(`${name} did not stop within 90 s.`);
      } else {
        if ((await scState(name)) !== "stopped") {
          await sc(name, "stop");
          if (!(await waitFor(name, "stopped", 90)))
            throw new Error(`${name} did not stop within 90 s.`);
        }
        await sc(name, "start");
        if (!(await waitFor(name, "running", 60)))
          throw new Error(`${name} did not reach running within 60 s.`);
      }
    },
    async drives() {
      const result = await powershell(
        "Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,FileSystem,DriveType,Size,FreeSpace | ConvertTo-Json -Compress",
        10_000,
      );
      if (result.code !== 0)
        throw new Error(
          result.code === -1
            ? "Reading drives timed out. A drive may be unresponsive."
            : result.stderr.trim(),
        );
      const types = {
        2: "removable",
        3: "local",
        4: "network",
        5: "optical",
        6: "ram",
      };
      return parseJsonList(result.stdout).map((d) => ({
        id: d.DeviceID,
        label: d.VolumeName || undefined,
        fileSystem: d.FileSystem || undefined,
        type: types[/** @type {keyof typeof types} */ (d.DriveType)] ?? "other",
        size: d.Size ?? undefined,
        free: d.FreeSpace ?? undefined,
      }));
    },
    async copyAcl(from, to) {
      // Only the DACL is copied. The temporary file's owner stays this
      // service, which is what lets it set the DACL without privileges it
      // does not have; ownership of the original is not something an env
      // edit should change anyway.
      const script = [
        `$src = (Get-Acl -LiteralPath ${psQuote(from)}).GetSecurityDescriptorSddlForm('Access')`,
        `$dst = Get-Acl -LiteralPath ${psQuote(to)}`,
        `$dst.SetSecurityDescriptorSddlForm($src, 'Access')`,
        `Set-Acl -LiteralPath ${psQuote(to)} -AclObject $dst`,
        `$now = (Get-Acl -LiteralPath ${psQuote(to)}).GetSecurityDescriptorSddlForm('Access')`,
        `if ($now -ne $src) { throw ('permissions differ after copy: ' + $now) }`,
      ].join(";");
      const result = await powershell(script);
      if (result.code !== 0) {
        throw new Error(
          `Could not copy file permissions, so nothing was saved. ${result.stderr.trim().split(/\r?\n/)[0] ?? ""}`,
        );
      }
    },
  };
}

/**
 * For running the dashboard on a development machine: services are simulated
 * in memory, so every button can be tried without a Windows host.
 *
 * @param {string[]} names
 * @returns {Platform}
 */
export function devPlatform(names) {
  const states = new Map(names.map((name) => [name, "running"]));
  return {
    name: "dev",
    async services(list) {
      return list.map((name) => ({
        name,
        state: states.get(name) ?? "missing",
      }));
    },
    async serviceAction(name, action) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      states.set(name, action === "stop" ? "stopped" : "running");
    },
    async drives() {
      return [];
    },
    async copyAcl() {},
  };
}

/**
 * @typedef {{
 *   name: string,
 *   services(names: string[]): Promise<ServiceState[]>,
 *   serviceAction(name: string, action: "start" | "stop" | "restart"): Promise<void>,
 *   drives(): Promise<Drive[]>,
 *   copyAcl(from: string, to: string): Promise<void>,
 * }} Platform
 */

/**
 * Checks paths from a child process, so a hung drive costs a killed child
 * rather than a stuck dashboard.
 *
 * @param {string[]} paths
 * @returns {Promise<PathInfo[]>}
 */
export async function inspectPaths(paths) {
  if (paths.length === 0) return [];
  const script = `
    const fs = require("node:fs");
    const out = [];
    for (const p of JSON.parse(process.argv[1])) {
      try {
        const s = fs.statSync(p);
        const info = { path: p, exists: true, directory: s.isDirectory(), file: s.isFile() };
        try { const f = fs.statfsSync(p); info.free = f.bavail * f.bsize; info.size = f.blocks * f.bsize; } catch {}
        out.push(info);
      } catch (e) {
        out.push({ path: p, exists: false, error: e.code === "ENOENT" ? undefined : String(e.code || e.message) });
      }
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const result = await run(
    process.execPath,
    ["-e", script, JSON.stringify(paths)],
    PATH_CHECK_TIMEOUT_MS,
  );
  if (result.code === 0) {
    try {
      return JSON.parse(result.stdout);
    } catch {
      // fall through
    }
  }
  const reason =
    result.code === -1
      ? "Timed out. The drive may be unresponsive."
      : "Could not be checked.";
  return paths.map((p) => ({ path: p, exists: false, error: reason }));
}

/** @param {string} url */
export async function readHealth(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const body = await response.json().catch(() => null);
    return {
      reachable: true,
      status: response.status,
      body: body?.data ?? body,
    };
  } catch (error) {
    return {
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** @param {string} dir */
export async function listLogs(dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const out = [];
  for (const name of names.filter((n) => LOG_NAME.test(n))) {
    try {
      const s = await fs.stat(path.join(dir, name));
      if (s.isFile())
        out.push({ name, size: s.size, modified: s.mtime.toISOString() });
    } catch {
      // vanished between readdir and stat: rotated
    }
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

/**
 * The end of one log file. The name must be one `listLogs` would return; it is
 * never joined onto the folder unchecked.
 *
 * @param {string} dir
 * @param {string} name
 * @param {number} bytes
 */
export async function tailLog(dir, name, bytes) {
  if (!LOG_NAME.test(name) || path.basename(name) !== name) return null;
  const listed = await listLogs(dir);
  if (!listed.some((log) => log.name === name)) return null;
  const want = Math.min(Math.max(1024, bytes || 64 * 1024), MAX_TAIL_BYTES);
  const handle = await fs.open(path.join(dir, name), "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - want);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    // NSSM writes UTF-16 when a service writes through the console; detect it.
    if (text.includes("\u0000")) text = buffer.toString("utf16le");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return { name, size, truncated: start > 0, text };
  } finally {
    await handle.close();
  }
}
