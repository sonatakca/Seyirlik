import { createContext, useContext, type ReactNode } from "react";

/**
 * Where a title page's centre dock stands.
 *
 * In the title hero it is level with the watch dock: same width, same foot,
 * centred on the stage. A phone's title hero has no stage to stand in, so
 * there it is `null` and the dock sits in the page, under the hero.
 */
export type HeroCentreDockPlace = {
  width: number;
  compact: boolean;
  /** The stage's height, so a panel opened above the dock can fit inside it. */
  stageHeight: number;
} | null;

export type RenderHeroCentreDock = (place: HeroCentreDockPlace) => ReactNode;

/**
 * Lets the page that owns a title (and knows who is looking at it) put a dock
 * in the middle of that title's hero, without the hero knowing what it is.
 */
export const HeroCentreDockContext = createContext<RenderHeroCentreDock | null>(
  null,
);

export function useHeroCentreDock(): RenderHeroCentreDock | null {
  return useContext(HeroCentreDockContext);
}
