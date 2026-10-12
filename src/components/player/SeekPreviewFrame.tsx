import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import { TRICKPLAY_COLUMNS, TRICKPLAY_ROWS } from "./constants";
import { getSpritePositionPercent } from "./mediaGeometry";

export interface SeekPreviewTile {
  imageUrl: string;
  column: number;
  row: number;
}

interface SeekPreviewFrameProps {
  /** Null hides the frame; it dissolves into whatever is underneath. */
  tile: SeekPreviewTile | null;
  /**
   * False while a jump's preview is held in reserve: the tile's sheet is
   * decoded meanwhile, so it can come up at once if it is needed.
   */
  shown: boolean;
  rect: { left: number; top: number; width: number; height: number } | null;
  className: string;
}

/** Arrival: quick enough to answer the pointer. Sine, so the peak step stays small. */
const FRAME_IN = { duration: 0.18, ease: [0.61, 1, 0.88, 1] as const };
/**
 * Departure: the preview resolving into the real frame at the same moment of
 * the film, so it is given time to read as one picture sharpening rather than
 * one picture replacing another.
 */
const FRAME_OUT = { duration: 0.34, ease: [0.37, 0, 0.63, 1] as const };
// Sheets already decoded, so a tile can be shown the moment it is asked for.
const decodedSheets = new Set<string>();
const pendingSheets = new Map<string, Promise<void>>();

function decodeSheet(url: string): Promise<void> {
  if (decodedSheets.has(url)) return Promise.resolve();
  const pending = pendingSheets.get(url);
  if (pending) return pending;
  const image = new Image();
  image.src = url;
  const promise = (image.decode ? image.decode() : Promise.resolve())
    .then(() => {
      decodedSheets.add(url);
    })
    .finally(() => {
      pendingSheets.delete(url);
    });
  pendingSheets.set(url, promise);
  return promise;
}

function tileKey(tile: SeekPreviewTile): string {
  return `${tile.imageUrl}#${tile.column}:${tile.row}`;
}

/**
 * The tile that may be shown: the one asked for once its sheet has decoded,
 * otherwise the last one that could be. An undecoded sheet painted as an empty
 * box — black over the film for as long as it took to arrive.
 */
function useDecodedTile(tile: SeekPreviewTile | null): SeekPreviewTile | null {
  const [shown, setShown] = useState<SeekPreviewTile | null>(() =>
    tile && decodedSheets.has(tile.imageUrl) ? tile : null,
  );

  useEffect(() => {
    if (!tile) {
      setShown(null);
      return undefined;
    }
    if (decodedSheets.has(tile.imageUrl)) {
      setShown(tile);
      return undefined;
    }
    let cancelled = false;
    decodeSheet(tile.imageUrl).then(
      () => {
        if (!cancelled) setShown(tile);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
    // The tile is compared by what it shows, not by object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tile?.imageUrl, tile?.column, tile?.row]);

  return shown;
}

/**
 * Most layers a fast scrub may stack while each one fades in over the last.
 * Each is a full-frame image, so this bounds the compositing cost; the one
 * dropped is at the bottom, already all but covered.
 */
const MAX_TILE_LAYERS = 4;

interface TileLayer {
  key: string;
  tile: SeekPreviewTile;
  fadeIn: boolean;
}

/**
 * Neighbouring thumbnails cross-fade: each new one fades in over the one
 * below, which stays opaque until covered — fading both at once dips
 * through to black. Once a layer is fully in, everything beneath it goes.
 *
 * Not AnimatePresence: it keeps every exiting child until all of them have
 * finished, and a scrub changes tile faster than that ever happens — measured
 * at 26 full-frame layers stacked by the end of one drag.
 */
function TileStack({
  tile,
  reduceMotion,
}: {
  tile: SeekPreviewTile;
  reduceMotion: boolean;
}) {
  const key = tileKey(tile);
  const [layers, setLayers] = useState<TileLayer[]>(() => [
    { key, tile, fadeIn: false },
  ]);

  // Derived during render, so the new tile is drawn in the same frame as the
  // pointer move that asked for it.
  if (layers[layers.length - 1]?.key !== key) {
    setLayers((previous) =>
      reduceMotion
        ? [{ key, tile, fadeIn: false }]
        : [...previous, { key, tile, fadeIn: true }].slice(-MAX_TILE_LAYERS),
    );
  }

  return (
    <>
      {layers.map((layer) => (
        <div
          key={layer.key}
          className={`absolute inset-0 ${
            layer.fadeIn ? "seyirlik-seek-preview-tile--in" : ""
          }`}
          style={{
            backgroundImage: `url("${layer.tile.imageUrl}")`,
            backgroundSize: `${TRICKPLAY_COLUMNS * 100}% ${TRICKPLAY_ROWS * 100}%`,
            backgroundPosition: `${getSpritePositionPercent(
              layer.tile.column,
              TRICKPLAY_COLUMNS,
            )}% ${getSpritePositionPercent(layer.tile.row, TRICKPLAY_ROWS)}%`,
            backgroundRepeat: "no-repeat",
          }}
          onAnimationEnd={() =>
            setLayers((previous) => {
              const index = previous.findIndex(
                (entry) => entry.key === layer.key,
              );
              return index > 0 ? previous.slice(index) : previous;
            })
          }
        />
      ))}
    </>
  );
}

export function SeekPreviewFrame({
  tile,
  shown: isShown,
  rect,
  className,
}: SeekPreviewFrameProps) {
  const reduceMotion = useReducedMotion();
  const shown = useDecodedTile(tile);
  const visible = isShown && tile !== null && shown !== null && rect !== null;

  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          key="seek-preview"
          data-testid="seek-preview-frame"
          aria-hidden="true"
          className={`pointer-events-none z-[9] overflow-hidden ${className}`}
          initial={{ opacity: 0 }}
          animate={{
            opacity: 1,
            transition: reduceMotion ? { duration: 0.08 } : FRAME_IN,
          }}
          exit={{
            opacity: 0,
            transition: reduceMotion ? { duration: 0.12 } : FRAME_OUT,
          }}
        >
          <div
            className="absolute overflow-hidden bg-black"
            style={{
              left: `${rect.left}px`,
              top: `${rect.top}px`,
              width: `${rect.width}px`,
              height: `${rect.height}px`,
            }}
          >
            <TileStack tile={shown} reduceMotion={reduceMotion === true} />
            <div className="absolute inset-0 bg-black/[0.22]" />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
