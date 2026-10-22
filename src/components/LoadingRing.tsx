import type { CSSProperties } from "react";
import "@material/web/progress/circular-progress.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "md-circular-progress": {
        // React 18 passes custom elements `class` verbatim; `className` would
        // become an unknown "classname" attribute.
        class?: string;
        style?: CSSProperties;
        indeterminate?: "";
        value?: number;
        "aria-hidden"?: "true";
      };
    }
  }
}

interface LoadingRingProps {
  /** Outer diameter of the ring, in CSS pixels. */
  size?: number;
  /** Line thickness, in CSS pixels. */
  stroke?: number;
}

// Material Web insets the ring 4px inside the element's box.
const MATERIAL_RING_INSET = 8;

/**
 * A thin ring whose arc grows and shrinks as it turns, drawn in currentColor.
 *
 * Material Web's indeterminate spinner builds this motion from rotations
 * alone, so the compositor runs it at the display's full rate (120 Hz on
 * ProMotion) and it keeps moving while the main thread is busy starting the
 * app. An SVG ring animating stroke-dasharray would be held to 60 fps in
 * Safari and freeze at one arc length under load.
 */
export function LoadingRing({ size = 96, stroke = 3 }: LoadingRingProps) {
  const style = {
    "--md-circular-progress-size": `${size + MATERIAL_RING_INSET}px`,
    // A percentage of the ring's diameter, not a length.
    "--md-circular-progress-active-indicator-width": `${(stroke / size) * 100}`,
    "--md-circular-progress-active-indicator-color": "currentColor",
  } as CSSProperties;

  return (
    <>
      <md-circular-progress
        aria-hidden="true"
        indeterminate=""
        class="motion-reduce:hidden"
        style={style}
      />
      <md-circular-progress
        aria-hidden="true"
        value={0.7}
        class="hidden motion-reduce:inline-flex"
        style={style}
      />
    </>
  );
}
