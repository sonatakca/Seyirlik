import { useEffect, useState, type RefObject } from "react";
import { filePartAt, partStartSeconds } from "../../lib/fileParts";
import type { MediaFilePart, MediaItem } from "../../lib/types";

/**
 * The episode under the playhead, in a file that holds several.
 *
 * Renders only when the playhead crosses into another part, never per frame.
 * `deckEpoch` changes when the player swaps its video element.
 */
export function useActiveFilePart(
  videoRef: RefObject<HTMLVideoElement | null>,
  deckEpoch: number,
  item: MediaItem,
): MediaFilePart | null {
  const [part, setPart] = useState<MediaFilePart | null>(() =>
    filePartAt(item, partStartSeconds(item)),
  );

  useEffect(() => {
    const video = videoRef.current;
    const update = () => {
      const next = filePartAt(
        item,
        video ? video.currentTime : partStartSeconds(item),
      );
      setPart((current) => (current?.Id === next?.Id ? current : next));
    };

    update();
    if (!video || !item.FileParts) return undefined;

    video.addEventListener("seeked", update);
    video.addEventListener("timeupdate", update);
    return () => {
      video.removeEventListener("seeked", update);
      video.removeEventListener("timeupdate", update);
    };
  }, [deckEpoch, item, videoRef]);

  return part;
}
