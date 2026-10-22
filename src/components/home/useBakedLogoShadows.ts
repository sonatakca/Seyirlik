import { useEffect, useState, type CSSProperties } from "react";
import {
  bakeShadowBlobs,
  type BakedShadowBlob,
  type BakedShadowBlobs,
  type ShadowBakeRequest,
} from "./logoShadowBake";

export interface BakedShadow {
  url: string;
  style: CSSProperties;
}
interface LogoShadows {
  aspect: number | null;
  base: BakedShadow | null;
  halo: BakedShadow | null;
  queue: BakedShadow | null;
}
const EMPTY: LogoShadows = {
  aspect: null,
  base: null,
  halo: null,
  queue: null,
};

/** WebKit can corrupt live filters during scaled, clipped carousel travel,
 * so a logo's shadows are baked into plain images (see logoShadowBake). The
 * baking runs in a worker: a new preview mounts mid-travel, and its encodes
 * on the main thread dropped frames. Images, not canvases: Chromium gives
 * every canvas its own layer, which the frame's rounded clip made costly.
 */
export function useBakedLogoShadows(
  source: string,
  boxWidth: number,
  maxHeight: number,
  queueScale = 1,
): LogoShadows {
  const [result, setResult] = useState<{
    key: string;
    shadows: LogoShadows;
  } | null>(null);
  const key = `${source}|${boxWidth}|${maxHeight}|${queueScale}`;
  useEffect(() => {
    if (!source || boxWidth <= 0) return;
    let cancelled = false;
    let owned: LogoShadows | null = null;
    void bakeLogoShadows(source, boxWidth, maxHeight, queueScale)
      .then((shadows) => {
        if (cancelled) release(shadows);
        else {
          owned = shadows;
          setResult({ key, shadows });
        }
      })
      .catch(() => {
        // Keep the unfiltered logo if its image cannot be decoded or drawn.
        if (!cancelled) setResult({ key, shadows: EMPTY });
      });
    return () => {
      cancelled = true;
      if (owned) release(owned);
    };
  }, [source, boxWidth, maxHeight, queueScale, key]);
  return result?.key === key ? result.shadows : EMPTY;
}

function release(shadows: LogoShadows) {
  for (const image of [shadows.base, shadows.halo, shadows.queue]) {
    if (image) URL.revokeObjectURL(image.url);
  }
}

async function bakeLogoShadows(
  source: string,
  boxWidth: number,
  maxHeight: number,
  queueScale: number,
): Promise<LogoShadows> {
  const response = await fetch(source, { credentials: "include" });
  if (!response.ok)
    throw new Error(`Logo shadow request failed: ${response.status}`);
  const logo = await response.blob();
  const bitmap = await createImageBitmap(logo);
  // The logo is drawn across the title box's width unless its height cap
  // makes it narrower; shadow sizes are in that box's px.
  const aspect = bitmap.width / bitmap.height;
  const request = {
    drawnWidth: Math.min(boxWidth, maxHeight * aspect),
    queueScale,
  };
  const blobs = await bakeInWorker(bitmap, request).catch(async () => {
    // The bitmap may already have moved to the worker; draw from a new one.
    bitmap.close();
    const own = await createImageBitmap(logo);
    try {
      return await bakeShadowBlobs(own, request, (width, height) =>
        Object.assign(document.createElement("canvas"), { width, height }),
      );
    } finally {
      own.close();
    }
  });
  return {
    aspect,
    base: toImage(blobs.base),
    halo: toImage(blobs.halo),
    queue: toImage(blobs.queue),
  };
}

function toImage({ blob, box }: BakedShadowBlob): BakedShadow {
  return {
    url: URL.createObjectURL(blob),
    style: {
      left: `${box.left * 100}%`,
      top: `${box.top * 100}%`,
      width: `${box.width * 100}%`,
      height: `${box.height * 100}%`,
      maxWidth: "none",
    },
  };
}

type WorkerReply = { id: number } & (
  | { shadows: BakedShadowBlobs }
  | { error: string }
);

let worker: Worker | null | undefined;
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (shadows: BakedShadowBlobs) => void; reject: () => void }
>();

/** One worker for every hero. Rejects, keeping the bitmap, if it can't run. */
function bakeInWorker(
  bitmap: ImageBitmap,
  request: ShadowBakeRequest,
): Promise<BakedShadowBlobs> {
  if (worker === undefined) worker = startWorker();
  const running = worker;
  if (!running) return Promise.reject(new Error("No shadow worker"));
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    // The bitmap moves to the worker and is closed there.
    running.postMessage({ id, bitmap, ...request }, [bitmap]);
  });
}

function startWorker(): Worker | null {
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined")
    return null;
  try {
    const started = new Worker(
      new URL("./logoShadow.worker.ts", import.meta.url),
      { type: "module" },
    );
    started.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      const waiting = pending.get(reply.id);
      pending.delete(reply.id);
      if (!waiting) return;
      if ("shadows" in reply) waiting.resolve(reply.shadows);
      else waiting.reject();
    };
    started.onerror = () => {
      // A worker that cannot start fails every request; stop using it.
      worker = null;
      for (const waiting of pending.values()) waiting.reject();
      pending.clear();
    };
    return started;
  } catch {
    return null;
  }
}
