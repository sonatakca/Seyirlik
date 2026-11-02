import { describe, expect, it } from "vitest";
import {
  filePartAt,
  initialFileSeconds,
  partProgress,
  sharesFile,
} from "./fileParts";
import type { MediaItem } from "./types";

// SpongeBob 1x1's file: Help Wanted, Reef Blower at 9:09, Tea at the Treedome at 12:00.
const parts = [
  { Id: "help", Name: "Help Wanted", IndexNumber: 1, StartSeconds: 0, EndSeconds: 549 },
  { Id: "reef", Name: "Reef Blower", IndexNumber: 2, StartSeconds: 549, EndSeconds: 720 },
  { Id: "tea", Name: "Tea at the Treedome", IndexNumber: 3, StartSeconds: 720 },
];

function opened(id: string, savedSeconds?: number): MediaItem {
  const part = parts.find((candidate) => candidate.Id === id)!;
  return {
    Id: id,
    Name: part.Name,
    Type: "Episode",
    PlayAs: {
      MediaFileId: "file-1",
      StartSeconds: part.StartSeconds,
      ...(part.EndSeconds === undefined ? {} : { EndSeconds: part.EndSeconds }),
    },
    FileParts: parts,
    ...(savedSeconds === undefined
      ? {}
      : { UserData: { PlaybackPositionTicks: savedSeconds * 10_000_000 } }),
  } as MediaItem;
}

describe("file parts", () => {
  it("names the part under the playhead, counting a seek that lands just short", () => {
    expect(filePartAt(opened("help"), 10)?.Id).toBe("help");
    expect(filePartAt(opened("help"), 548.7)?.Id).toBe("reef");
    expect(filePartAt(opened("help"), 1_400)?.Id).toBe("tea");
  });

  it("puts progress on the playing part's own clock", () => {
    expect(partProgress(opened("reef"), 600)).toEqual({
      itemId: "reef",
      positionSeconds: 51,
      index: 1,
    });
  });

  it("cannot locate a file whose parts have no starts", () => {
    const unplaced = {
      ...opened("help"),
      FileParts: parts.map(({ StartSeconds: _start, ...part }) => part),
    } as MediaItem;
    expect(filePartAt(unplaced, 600)).toBeNull();
    expect(partProgress(unplaced, 600)).toBeNull();
  });

  it("opens an episode at its own start, or its own resume point", () => {
    expect(initialFileSeconds(opened("reef"), 0)).toBe(549);
    expect(initialFileSeconds(opened("reef"), 40)).toBe(589);
    // Played through once: start it over rather than at its end.
    expect(initialFileSeconds(opened("reef"), 171)).toBe(549);
    // The last story has no known end; any saved place is inside it.
    expect(initialFileSeconds(opened("tea"), 300)).toBe(1_020);
  });

  it("leaves an ordinary item's resume point alone", () => {
    const film = { Id: "film", Name: "Film", Type: "Movie" } as MediaItem;
    expect(initialFileSeconds(film, 42)).toBe(42);
    expect(filePartAt(film, 42)).toBeNull();
  });

  it("knows which episodes are in the file already playing", () => {
    const tea = { Id: "tea", Name: "Tea", Type: "Episode" } as MediaItem;
    const next = { Id: "next", Name: "Next", Type: "Episode" } as MediaItem;
    expect(sharesFile(opened("help"), tea)).toBe(true);
    expect(sharesFile(opened("help"), next)).toBe(false);
  });
});
