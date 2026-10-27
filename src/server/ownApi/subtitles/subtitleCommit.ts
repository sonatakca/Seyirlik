import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

export class SubtitleCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubtitleCommitError";
  }
}

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function durableWrite(file: string, bytes: Uint8Array, flags: string) {
  const handle = await open(file, flags, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.truncate(bytes.length);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function recoveryDirectory(root: string) {
  let current = root;
  for (const segment of [
    ".seyirlik",
    "state",
    "subtitle-rewrites",
    randomUUID(),
  ]) {
    current = path.join(current, segment);
    await mkdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new SubtitleCommitError(
        "The subtitle recovery directory is not safe.",
      );
    }
  }
  return current;
}

/** The caller holds the per-title write lock and has checked path containment. */
export async function replaceSubtitleFile(input: {
  root: string;
  target: string;
  temporary: string;
  previous: Uint8Array;
  bytes: Uint8Array;
  platform?: NodeJS.Platform;
}) {
  if ((input.platform ?? process.platform) === "win32") {
    // Windows network/Drive mounts can acknowledge rename-over-existing while
    // retaining the old bytes or an empty file. Preserve both versions before
    // modifying the existing file, and never report a commit without readback.
    const backup = await recoveryDirectory(input.root);
    await durableWrite(path.join(backup, "before"), input.previous, "wx");
    await durableWrite(path.join(backup, "after"), input.bytes, "wx");
    await durableWrite(
      path.join(backup, "target.json"),
      Buffer.from(
        JSON.stringify({
          relativePath: path.relative(input.root, input.target),
        }),
      ),
      "wx",
    );
    if (
      digest(await readFile(path.join(backup, "before"))) !==
        digest(input.previous) ||
      digest(await readFile(path.join(backup, "after"))) !== digest(input.bytes)
    ) {
      throw new SubtitleCommitError(
        "Subtitle recovery copies could not be verified.",
      );
    }
    // Check again after the backup I/O; an unrelated editor must not be lost.
    if (digest(await readFile(input.target)) !== digest(input.previous)) {
      throw new SubtitleCommitError("The subtitle changed before commit.");
    }
    try {
      await durableWrite(input.target, input.bytes, "r+");
      if (digest(await readFile(input.target)) !== digest(input.bytes)) {
        throw new SubtitleCommitError(
          "The saved subtitle did not match the correction.",
        );
      }
    } catch {
      try {
        await durableWrite(input.target, input.previous, "r+");
      } catch {
        /* Both complete versions remain in the recovery directory. */
      }
      throw new SubtitleCommitError(
        "The subtitle could not be saved and verified; recovery copies were preserved.",
      );
    }
  } else {
    await rename(input.temporary, input.target);
  }
  if (digest(await readFile(input.target)) !== digest(input.bytes)) {
    throw new SubtitleCommitError(
      "The saved subtitle did not match the correction.",
    );
  }
}
