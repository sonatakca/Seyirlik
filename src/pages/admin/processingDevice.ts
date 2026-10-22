import type { ProcessingJob } from "../../lib/processingApi";

const ADAPTER_LABELS: Record<string, string> = {
  nvenc: "NVIDIA NVENC",
  qsv: "Intel Quick Sync",
  videotoolbox: "Apple VideoToolbox",
  amf: "AMD AMF",
  vaapi: "VA-API",
  software: "CPU",
};

/**
 * Where a job is being (or was) processed: the machine, then its encoder.
 *
 * Null before a worker has planned the attempt. Until then the stored adapter
 * is the queue-time guess made by whichever machine served the page, which in
 * a split deployment is not the one that will encode.
 */
export function processingDeviceLabel(
  job: Pick<ProcessingJob, "processedBy" | "hardwareAdapter" | "state">,
): string | null {
  const planned =
    Boolean(job.processedBy) ||
    (job.state !== "pending" && job.state !== "queued");
  if (!planned) return null;
  const adapter = job.hardwareAdapter
    ? (ADAPTER_LABELS[job.hardwareAdapter] ?? job.hardwareAdapter)
    : null;
  const parts = [job.processedBy, adapter].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}
