import { useEffect, useState } from "react";
import { ownApiClient } from "../../api/ownApi/client";
import { listAcquisitions } from "../../lib/acquisitionsApi";
import { bucketOf } from "../../lib/acquisitionPresentation";
import { getVolumeSpace, type VolumeSpace } from "../../lib/processingApi";

/**
 * The things the overview can say truthfully without going looking.
 *
 * Each is an endpoint a tool on this page already calls, asked once. Nothing
 * here starts a scan, walks the library or counts anything the server does not
 * already have to hand — a dashboard that costs a disk pass to draw is a
 * dashboard nobody can afford to open.
 *
 * A source that fails resolves to `undefined` rather than to zero. Zero is a
 * measurement; an unanswered request is not, and showing "0 failed downloads"
 * because the request failed is worse than showing nothing.
 */
export interface DevToolsStatus {
  readonly loading: boolean;
  readonly server: "ready" | "degraded" | "unreachable" | undefined;
  readonly downloads: { active: number; failed: number } | undefined;
  readonly space: readonly VolumeSpace[] | undefined;
}

export function useDevToolsStatus(): DevToolsStatus {
  const [status, setStatus] = useState<DevToolsStatus>({
    loading: true,
    server: undefined,
    downloads: undefined,
    space: undefined,
  });

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    async function readServer(): Promise<DevToolsStatus["server"]> {
      try {
        const health = await ownApiClient.getHealth({
          signal: controller.signal,
        });
        const degraded = Object.values(health.checks).some(
          (state) => state === "unavailable",
        );
        return health.ready && !degraded ? "ready" : "degraded";
      } catch {
        return "unreachable";
      }
    }

    async function readDownloads(): Promise<DevToolsStatus["downloads"]> {
      try {
        const rows = await listAcquisitions();
        return {
          active: rows.filter((row) => bucketOf(row.state) === "active").length,
          failed: rows.filter((row) => bucketOf(row.state) === "needsAttention")
            .length,
        };
      } catch {
        return undefined;
      }
    }

    async function readSpace(): Promise<DevToolsStatus["space"]> {
      try {
        const { volumes } = await getVolumeSpace({
          signal: controller.signal,
        });
        return volumes;
      } catch {
        return undefined;
      }
    }

    void Promise.all([readServer(), readDownloads(), readSpace()]).then(
      ([server, downloads, space]) => {
        if (cancelled) return;
        setStatus({ loading: false, server, downloads, space });
      },
    );

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  return status;
}
