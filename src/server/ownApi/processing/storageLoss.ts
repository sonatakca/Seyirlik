/**
 * Whether a volume disappearing is evidence of device loss.
 *
 * It is when an encoder has the source open at that moment: that is a read
 * failing under a running job, and it raises a quarantine that outlives the
 * process. Everything else is an unmount, which the guard records as the
 * storage being unavailable and recovers from on its own.
 *
 * Two things used to be counted as evidence and are not:
 *
 * - **Jobs that are not running.** Pending, queued and paused jobs have no
 *   file open. Counting them meant a library with one long-paused job turned
 *   every planned unmount — restarting the Google Drive mount to pick up a new
 *   sign-in — into a quarantine that held every future encode.
 * - **Processes that do not run the encoder.** The API server and a `light`
 *   worker watch the volume too, but through their own view of it; on a cloud
 *   mount that is a different mount on a different machine from the one
 *   encoding. Only the processing worker can say its encoder lost its source.
 */
export function deviceLossEvidence<Job extends { id: string; state: string }>(
  processingWorker: boolean,
  activeJobs: readonly Job[],
): Job | null {
  if (!processingWorker) return null;
  return activeJobs.find((job) => job.state === "running") ?? null;
}

/**
 * The jobs a storage loss should pause: the ones not already paused.
 *
 * A paused job keeps the reason it was paused for. Re-pausing it used to
 * overwrite that reason with "storage unavailable", and since the storage
 * coming back resumes exactly the jobs it paused, a mount blip resumed jobs a
 * person had paused by hand and jobs held by a quarantine.
 */
export function jobsToPauseOnLoss<Job extends { state: string }>(
  activeJobs: readonly Job[],
): Job[] {
  return activeJobs.filter((job) => job.state !== "paused");
}
