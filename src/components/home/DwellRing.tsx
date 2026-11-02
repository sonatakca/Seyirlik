import { motion } from "framer-motion";
import { useLayoutEffect, useRef, useState } from "react";

/**
 * The dwell drawn round the hero's controls: a stroke along the pill's own
 * border, from its top middle and clockwise, filled as the title's time on
 * stage runs out. The clock plays it; this only lays the path out.
 */
export function DwellRing({
  attach,
  isShown,
  fadeS,
}: {
  /** The dwell clock's callback ref. */
  attach: (element: SVGElement | null) => void;
  isShown: boolean;
  fadeS: number;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    const svg = ref.current;
    if (!svg) return undefined;
    const measure = () => {
      const { width, height } = svg.getBoundingClientRect();
      if (width > 0 && height > 0)
        setSize((current) =>
          current?.width === width && current.height === height
            ? current
            : { width, height },
        );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  return (
    <motion.svg
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute -left-px -top-px overflow-visible"
      style={{ width: "calc(100% + 2px)", height: "calc(100% + 2px)" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: isShown ? 1 : 0 }}
      transition={{ duration: fadeS }}
    >
      {size ? (
        <path
          ref={attach}
          d={stadium(size.width, size.height, STROKE_PX / 2)}
          pathLength={1}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={STROKE_PX}
          strokeDasharray="1 1"
          strokeDashoffset={1}
        />
      ) : null}
    </motion.svg>
  );
}

const STROKE_PX = 2;

/** A pill's outline, inset by `inset`, from its top middle and clockwise. */
function stadium(width: number, height: number, inset: number): string {
  const top = inset;
  const bottom = height - inset;
  const radius = (bottom - top) / 2;
  const left = inset + radius;
  const right = width - inset - radius;
  return [
    `M ${width / 2} ${top}`,
    `H ${right}`,
    `A ${radius} ${radius} 0 0 1 ${right} ${bottom}`,
    `H ${left}`,
    `A ${radius} ${radius} 0 0 1 ${left} ${top}`,
    "Z",
  ].join(" ");
}
