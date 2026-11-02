import { useCallback, useEffect, useRef } from "react";
import { partProgress } from "../../lib/fileParts";
import {
  markItemPlayed,
  reportPlaybackProgress,
  reportPlaybackStart,
  reportPlaybackStopped,
  reportPlaybackStoppedBeforeUnload,
  ticksFromSeconds,
} from "../../lib/mediaApi";
import type { MediaItem, PlaybackSourceCandidate } from "../../lib/types";

/**
 * Reports playback to the server.
 *
 * In a file that holds several episodes the position belongs to the one under
 * the playhead, on its own clock, and an episode played through to the next
 * is marked watched. Seeking past one is not watching it, so only the step to
 * the very next part counts.
 */
export function usePlaybackReporting(
  activeSource: PlaybackSourceCandidate | null,
  item: MediaItem | null = null,
) {
  const lastPartRef = useRef<{ itemId: string; index: number } | null>(null);

  useEffect(() => {
    lastPartRef.current = null;
  }, [item?.Id]);

  const resolve = useCallback(
    (positionSeconds: number) => {
      if (!activeSource) {
        return null;
      }

      const progress = partProgress(item, positionSeconds);

      if (!progress) {
        return { source: activeSource, positionSeconds };
      }

      const last = lastPartRef.current;
      if (last && progress.index === last.index + 1) {
        void markItemPlayed(last.itemId).catch((error) => {
          console.warn(
            "[Seyirlik Playback] Could not mark an episode watched",
            error,
          );
        });
      }
      lastPartRef.current = {
        itemId: progress.itemId,
        index: progress.index,
      };

      return {
        source:
          progress.itemId === activeSource.itemId
            ? activeSource
            : { ...activeSource, itemId: progress.itemId },
        positionSeconds: progress.positionSeconds,
      };
    },
    [activeSource, item],
  );

  const handlePlaybackStarted = useCallback(
    (positionSeconds: number) => {
      const target = resolve(positionSeconds);
      if (!target) {
        return;
      }

      void reportPlaybackStart(
        target.source,
        ticksFromSeconds(target.positionSeconds),
      ).catch((error) => {
        console.warn(
          "[Seyirlik Playback] Could not report playback start",
          error,
        );
      });
    },
    [resolve],
  );

  const handlePlaybackProgress = useCallback(
    (positionSeconds: number, isPaused: boolean) => {
      const target = resolve(positionSeconds);
      if (!target) {
        return;
      }

      void reportPlaybackProgress(
        target.source,
        ticksFromSeconds(target.positionSeconds),
        isPaused,
      ).catch((error) => {
        console.warn(
          "[Seyirlik Playback] Could not report playback progress",
          error,
        );
      });
    },
    [resolve],
  );

  const handlePlaybackStopped = useCallback(
    (positionSeconds: number) => {
      const target = resolve(positionSeconds);
      if (!target) {
        return;
      }

      void reportPlaybackStopped(
        target.source,
        ticksFromSeconds(target.positionSeconds),
      ).catch((error) => {
        console.warn(
          "[Seyirlik Playback] Could not report playback stopped",
          error,
        );
      });
    },
    [resolve],
  );

  const handlePlaybackBeforeUnload = useCallback(
    (positionSeconds: number) => {
      const target = resolve(positionSeconds);
      if (!target) {
        return;
      }

      reportPlaybackStoppedBeforeUnload(
        target.source,
        ticksFromSeconds(target.positionSeconds),
      );
    },
    [resolve],
  );

  return {
    handlePlaybackBeforeUnload,
    handlePlaybackProgress,
    handlePlaybackStarted,
    handlePlaybackStopped,
  };
}
