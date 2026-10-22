import { motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";

type RevealDirection = "up" | "down" | "left" | "right" | "none";

interface MotionRevealProps {
  children: ReactNode;
  className?: string;
  delay?: number;
  direction?: RevealDirection;
  once?: boolean;
}

const easeOut: [number, number, number, number] = [0.22, 1, 0.36, 1];

// A whole transform string, which framer-motion hands to the compositor; its
// x/y shorthands are written by script every frame.
function getOffset(direction: RevealDirection): string {
  switch (direction) {
    case "down":
      return "translate(0px, -18px)";
    case "left":
      return "translate(18px, 0px)";
    case "right":
      return "translate(-18px, 0px)";
    case "none":
      return "translate(0px, 0px)";
    case "up":
    default:
      return "translate(0px, 18px)";
  }
}

export function MotionReveal({
  children,
  className = "",
  delay = 0,
  direction = "up",
  once = true,
}: MotionRevealProps) {
  const shouldReduceMotion = useReducedMotion();

  if (shouldReduceMotion) {
    return (
      <motion.div
        className={className}
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once, margin: "0px 0px -8% 0px" }}
        transition={{ duration: 0.01 }}
      >
        {children}
      </motion.div>
    );
  }

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, transform: getOffset(direction) }}
      whileInView={{
        opacity: 1,
        transform: "translate(0px, 0px)",
        transitionEnd: { transform: "none" },
      }}
      viewport={{ once, margin: "0px 0px -8% 0px" }}
      transition={{ duration: 0.35, delay, ease: easeOut }}
    >
      {children}
    </motion.div>
  );
}
