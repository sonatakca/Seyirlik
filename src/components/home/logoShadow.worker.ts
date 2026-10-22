/// <reference lib="webworker" />
// Draws and encodes hero logo shadows off the main thread: on it, one PNG
// encode was a long task, landing as a new preview mounted mid-travel.
import { bakeShadowBlobs, type ShadowBakeRequest } from "./logoShadowBake";

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (
  event: MessageEvent<{ id: number; bitmap: ImageBitmap } & ShadowBakeRequest>,
) => {
  const { id, bitmap, ...request } = event.data;
  try {
    const shadows = await bakeShadowBlobs(
      bitmap,
      request,
      (width, height) => new OffscreenCanvas(width, height),
    );
    self.postMessage({ id, shadows });
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  } finally {
    bitmap.close();
  }
};
