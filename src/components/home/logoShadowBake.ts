/**
 * Draws a hero logo's black shadows into PNGs, once, so travel only moves
 * plain images: WebKit can corrupt live filters during scaled, clipped
 * carousel travel. Shared by the shadow worker and its main-thread fallback.
 * Canvas shadowBlur is supported on Safari too (unlike Canvas filter).
 */

export interface ShadowBakeRequest {
  /** The logo's width and height in the title box's layout px, as drawn. */
  drawnWidth: number;
  queueScale: number;
}

export interface BakedShadowBlob {
  blob: Blob;
  /** Where the PNG sits around the logo, as fractions of the logo's box. */
  box: { left: number; top: number; width: number; height: number };
}

export interface BakedShadowBlobs {
  base: BakedShadowBlob;
  halo: BakedShadowBlob;
  queue: BakedShadowBlob;
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

export async function bakeShadowBlobs(
  bitmap: ImageBitmap,
  { drawnWidth, queueScale }: ShadowBakeRequest,
  makeCanvas: (width: number, height: number) => AnyCanvas,
): Promise<BakedShadowBlobs> {
  // A blur needs no more than one canvas px per layout px.
  const aspect = bitmap.width / bitmap.height;
  const width = Math.max(1, Math.min(bitmap.width, Math.round(drawnWidth)));
  const height = Math.max(1, Math.round(width / aspect));
  const px = width / drawnWidth;
  const draw = async (
    layers: { blur: number; dy: number; alpha: number }[],
  ): Promise<BakedShadowBlob> => {
    const pad =
      Math.ceil(
        Math.max(...layers.map((s) => (3 * s.blur + Math.abs(s.dy)) * px)),
      ) + 2;
    const canvas = makeCanvas(width + pad * 2, height + pad * 2);
    const context = canvas.getContext("2d") as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D
      | null;
    if (!context) throw new Error("No logo shadow canvas context");
    // The source paints outside the canvas; only its shadow lands inside it.
    const offset = canvas.width + width + pad;
    for (const layer of layers) {
      context.shadowColor = `rgba(0,0,0,${layer.alpha})`;
      // Canvas shadowBlur is twice the standard deviation CSS blurs take.
      context.shadowBlur = layer.blur * px * 2;
      context.shadowOffsetX = offset;
      context.shadowOffsetY = layer.dy * px;
      context.drawImage(bitmap, pad - offset, pad, width, height);
    }
    return {
      blob: await encode(canvas),
      box: {
        left: -pad / width,
        top: -pad / height,
        width: canvas.width / width,
        height: canvas.height / height,
      },
    };
  };
  return {
    base: await draw([{ blur: 30, dy: 6, alpha: 0.55 }]),
    halo: await draw([
      { blur: 3, dy: 0, alpha: 0.55 },
      { blur: 22, dy: 0, alpha: 0.6 },
    ]),
    queue: await draw([
      {
        blur: 5 / Math.max(queueScale, 0.01),
        dy: 2 / Math.max(queueScale, 0.01),
        alpha: 1,
      },
    ]),
  };
}

function encode(canvas: AnyCanvas): Promise<Blob> {
  if ("convertToBlob" in canvas)
    return canvas.convertToBlob({ type: "image/png" });
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("No logo shadow blob"))),
      "image/png",
    ),
  );
}
