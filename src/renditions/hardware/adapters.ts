import { spawn } from "node:child_process";
import type { RenditionCodecFamily, RenditionVideoEncoder } from "../encoding";

/**
 * Hardware encoding, described the same way on every operating system.
 *
 * The orchestration layer is cross-platform; only the list of encoders worth
 * trying, and the order to try them in, is not. An adapter is that list plus
 * the name an operator recognises. Nothing here decides *whether* an encoder
 * works — that is settled by actually running it, because an encoder can be
 * compiled into FFmpeg on a machine that has no GPU to run it on.
 */

export type HardwarePlatform = "darwin" | "win32" | "linux" | "any";

/**
 * Every encoder name an adapter can name, including ones this build does not
 * yet drive.
 *
 * Deliberately wider than `RenditionVideoEncoder`, which is the set the encoder
 * argument builder actually knows how to configure. Naming an encoder here that
 * the builder cannot configure is how an adapter reports "recognised, but not
 * implemented in this build" instead of pretending to support it.
 */
export type HardwareEncoderName =
  | RenditionVideoEncoder
  | "h264_amf"
  | "hevc_amf"
  | "h264_vaapi"
  | "hevc_vaapi";

const DRIVEABLE_ENCODERS = new Set<string>([
  "libx264",
  "libx265",
  "h264_qsv",
  "hevc_qsv",
  "h264_videotoolbox",
  "hevc_videotoolbox",
  "h264_nvenc",
  "hevc_nvenc",
]);

/** Whether the encoder argument builder can actually configure this encoder. */
export function isDriveableEncoder(
  encoder: HardwareEncoderName,
): encoder is RenditionVideoEncoder {
  return DRIVEABLE_ENCODERS.has(encoder);
}

export interface HardwareAdapter {
  /** Stable identifier used in APIs, job records and the UI. */
  id: string;
  /** What an operator calls it. */
  label: string;
  platform: HardwarePlatform;
  /** Lower sorts first when several adapters are usable. */
  preference: number;
  /** Encoder for a codec family at a given bit depth, if this adapter has one. */
  encoderFor(
    family: RenditionCodecFamily,
    tenBit: boolean,
  ): HardwareEncoderName | undefined;
}

export const VIDEOTOOLBOX_ADAPTER: HardwareAdapter = {
  id: "videotoolbox",
  label: "Apple VideoToolbox",
  platform: "darwin",
  preference: 10,
  encoderFor: (family) =>
    family === "hevc" ? "hevc_videotoolbox" : "h264_videotoolbox",
};

export const NVENC_ADAPTER: HardwareAdapter = {
  id: "nvenc",
  label: "NVIDIA NVENC",
  platform: "any",
  preference: 20,
  encoderFor: (family) => (family === "hevc" ? "hevc_nvenc" : "h264_nvenc"),
};

export const QSV_ADAPTER: HardwareAdapter = {
  id: "qsv",
  label: "Intel Quick Sync",
  platform: "any",
  preference: 30,
  encoderFor: (family) => (family === "hevc" ? "hevc_qsv" : "h264_qsv"),
};

export const AMF_ADAPTER: HardwareAdapter = {
  id: "amf",
  label: "AMD AMF",
  platform: "win32",
  preference: 40,
  encoderFor: (family) => (family === "hevc" ? "hevc_amf" : "h264_amf"),
};

export const VAAPI_ADAPTER: HardwareAdapter = {
  id: "vaapi",
  label: "VA-API",
  platform: "linux",
  preference: 50,
  encoderFor: (family) => (family === "hevc" ? "hevc_vaapi" : "h264_vaapi"),
};

/**
 * Always last, always present.
 *
 * A machine with no usable accelerator still has to be able to process its
 * library; it just takes longer. Software is a deliberate destination, not the
 * absence of a decision.
 */
export const SOFTWARE_ADAPTER: HardwareAdapter = {
  id: "software",
  label: "CPU (software)",
  platform: "any",
  preference: 100,
  encoderFor: (family) => (family === "hevc" ? "libx265" : "libx264"),
};

const ALL_ADAPTERS: readonly HardwareAdapter[] = [
  VIDEOTOOLBOX_ADAPTER,
  NVENC_ADAPTER,
  QSV_ADAPTER,
  AMF_ADAPTER,
  VAAPI_ADAPTER,
  SOFTWARE_ADAPTER,
];

/**
 * Adapters worth probing on this platform, best first.
 *
 * Adapters for other platforms are not silently dropped — the caller still
 * reports them as unavailable with a reason, so an operator looking at a Mac
 * can see that NVENC was considered and why it was not used.
 */
export function adaptersForPlatform(
  platform: NodeJS.Platform,
): HardwareAdapter[] {
  return ALL_ADAPTERS.filter(
    (adapter) => adapter.platform === "any" || adapter.platform === platform,
  ).sort((left, right) => left.preference - right.preference);
}

export function adaptersNotOnPlatform(
  platform: NodeJS.Platform,
): HardwareAdapter[] {
  return ALL_ADAPTERS.filter(
    (adapter) => adapter.platform !== "any" && adapter.platform !== platform,
  ).sort((left, right) => left.preference - right.preference);
}

export function findAdapter(id: string): HardwareAdapter | undefined {
  return ALL_ADAPTERS.find((adapter) => adapter.id === id);
}

export interface EncoderProbeResult {
  ok: boolean;
  /** FFmpeg's own first error line, when it produced one. */
  detail?: string;
}

/**
 * Runs a real encode rather than checking whether a name exists.
 *
 * An encoder can be compiled into FFmpeg on a machine with no accelerator, and
 * `-encoders` lists it happily. It can also open at one frame size and refuse
 * another, which is how a 480p rung once failed on hardware that encoded 1080p
 * without complaint. The probe therefore encodes at the size and bit depth the
 * caller intends to use.
 */
export function probeEncoder(
  ffmpegPath: string,
  encoder: HardwareEncoderName,
  options: {
    tenBit?: boolean;
    width?: number;
    height?: number;
    extraArgs?: string[];
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<EncoderProbeResult> {
  const tenBit = options.tenBit ?? false;
  const width = options.width ?? 320;
  const height = options.height ?? 240;
  const sourceFormat = tenBit ? "p010" : "nv12";
  const profile =
    encoder === "hevc_qsv" ||
    encoder === "hevc_videotoolbox" ||
    encoder === "hevc_nvenc"
      ? ["-profile:v", tenBit ? "main10" : "main"]
      : [];

  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    const finish = (result: EncoderProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        `color=c=black:s=${width}x${height}:d=0.1,format=${sourceFormat}`,
        "-c:v",
        encoder,
        ...profile,
        ...(options.extraArgs ?? []),
        "-f",
        "null",
        "-",
      ],
      { shell: false, windowsHide: true, signal: options.signal },
    );

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, detail: "The encoder probe timed out." });
    }, options.timeoutMs ?? 20_000);
    if (typeof timer.unref === "function") timer.unref();

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString();
    });
    child.stdout?.resume();
    child.once("error", (error) =>
      finish({ ok: false, detail: firstMeaningfulLine(String(error.message)) }),
    );
    child.once("close", (code) =>
      code === 0
        ? finish({ ok: true })
        : finish({ ok: false, detail: firstMeaningfulLine(stderr) }),
    );
  });
}

/**
 * FFmpeg prefixes its diagnostics with a component and an allocation address,
 * neither of which means anything to an operator, and the address changes every
 * run so it would defeat any grouping of identical failures.
 */
export function firstMeaningfulLine(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return undefined;
  return (
    line
      .replace(/^\[[^\]]*@\s*0x[0-9a-f]+\]\s*/gi, "")
      .replace(/\s*@\s*0x[0-9a-f]+/gi, "")
      .trim()
      .slice(0, 240) || undefined
  );
}
