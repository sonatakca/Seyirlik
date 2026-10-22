/**
 * Bakes the navbar wordmark's shadow for each of its six colour frames.
 *
 * Reads the plain frames in `src/assets/navbar-wordmark/` and writes each
 * one's shadow alone, black, on a canvas padded by its reach, to
 * `src/assets/navbar-wordmark/shadow/`. Drawn under its plain frame it gives
 * exactly the shadowed wordmark; the page fades it by how much the artwork
 * behind needs it. The shadow is the CSS filter the wordmark used to carry,
 * computed the way a browser does it: each drop-shadow blurs the alpha of
 * everything drawn so far (a Gaussian, its deviation fitted to WebKit's),
 * offsets it, tints it black, and draws the input over it. See
 * `src/components/navbarWordmarkShadow.ts` for why.
 *
 *   npx tsx scripts/bake-navbar-wordmark.ts
 *
 * Run it again whenever a plain frame changes; it never reads its own output.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  WORDMARK_FRAME_HEIGHT,
  WORDMARK_FRAME_WIDTH,
  WORDMARK_SHADOWS,
  WORDMARK_SHADOW_SCALE,
  WORDMARK_SHADOW_SIGMA_PER_BLUR,
  getWordmarkShadowPad,
} from "../src/components/navbarWordmarkShadow";

const FRAMES = ["warm-red", "amber", "gold", "olive", "green", "teal"];
const SOURCE_DIR = path.resolve("src/assets/navbar-wordmark");
const OUT_DIR = path.join(SOURCE_DIR, "shadow");

function gaussianKernel(sigma: number): Float32Array {
  const radius = Math.ceil(sigma * 3);
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  return kernel;
}

/** A separable Gaussian blur of one channel, zero outside the canvas. */
function blur(src: Float32Array, w: number, h: number, sigma: number) {
  const kernel = gaussianKernel(sigma);
  const r = (kernel.length - 1) / 2;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < w) acc += src[y * w + xx] * kernel[k + r];
      }
      tmp[y * w + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < h) acc += tmp[yy * w + x] * kernel[k + r];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

async function bake(name: string) {
  const pad = getWordmarkShadowPad();
  const w = WORDMARK_FRAME_WIDTH + pad.left + pad.right;
  const h = WORDMARK_FRAME_HEIGHT + pad.top + pad.bottom;

  const { data, info } = await sharp(path.join(SOURCE_DIR, `${name}.webp`))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    info.width !== WORDMARK_FRAME_WIDTH ||
    info.height !== WORDMARK_FRAME_HEIGHT
  ) {
    throw new Error(`${name}.webp is ${info.width}x${info.height}`);
  }

  // The letters' alpha, 0..1, on the padded canvas.
  let a = new Float32Array(w * h);
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const s = (y * info.width + x) * 4;
      const d = (y + pad.top) * w + (x + pad.left);
      a[d] = data[s + 3] / 255;
    }
  }

  const letters = a;
  // Each shadow is black, so it only adds coverage: the alpha becomes
  // input + (1 - input) * shadow.
  for (const shadow of WORDMARK_SHADOWS) {
    const sigma =
      shadow.blur * WORDMARK_SHADOW_SIGMA_PER_BLUR * WORDMARK_SHADOW_SCALE;
    const blurred = blur(a, w, h, sigma);
    const dy = Math.round(shadow.dy * WORDMARK_SHADOW_SCALE);
    const next = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const sy = y - dy;
        const cast = sy >= 0 && sy < h ? blurred[sy * w + x] * shadow.alpha : 0;
        next[i] = a[i] + (1 - a[i]) * cast;
      }
    }
    a = next;
  }

  // The shadow alone: what, drawn under the letters, makes that alpha.
  // letters + (1 - letters) * shadow = all, solved for shadow; under an
  // opaque letter it is never seen.
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const cover = 1 - letters[i];
    const shadow = cover > 1e-3 ? (a[i] - letters[i]) / cover : 0;
    out[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, shadow)) * 255);
  }

  const file = path.join(OUT_DIR, `${name}.webp`);
  await sharp(out, { raw: { width: w, height: h, channels: 4 } })
    .webp({ quality: 92, alphaQuality: 100, effort: 6 })
    .toFile(file);
  return { file, width: w, height: h };
}

await mkdir(OUT_DIR, { recursive: true });
for (const name of FRAMES) {
  const { file, width, height } = await bake(name);
  console.log(`${path.relative(process.cwd(), file)} ${width}x${height}`);
}
console.log("pad", getWordmarkShadowPad());
