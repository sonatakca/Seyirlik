import { motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";

interface PageTransitionProps {
  children: ReactNode;
  variant?: "default" | "player";
}

const easeOut: [number, number, number, number] = [0.22, 1, 0.36, 1];

export function PageTransition({
  children,
  variant = "default",
}: PageTransitionProps) {
  const shouldReduceMotion = useReducedMotion();

  if (shouldReduceMotion) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.01 }}
      >
        {children}
      </motion.div>
    );
  }

  if (variant === "player") {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.12, ease: easeOut }}
      >
        {children}
      </motion.div>
    );
  }

  // Whole-string transforms and opacity are what framer-motion hands to the
  // compositor (WAAPI); its y/scale shorthands are written by script every
  // frame, and a blur over the whole page repaints it every frame. The settled
  // page goes back to no transform, so it never becomes the containing block
  // of a fixed child.
  return (
    <motion.div
      initial={{ opacity: 0, transform: "translateY(14px) scale(0.985)" }}
      animate={{
        opacity: 1,
        transform: "translateY(0px) scale(1)",
        transitionEnd: { transform: "none" },
      }}
      // From an explicit start: read back from "none", framer-motion would
      // zero every number in the target and start the exit at scale(0).
      exit={{
        opacity: 0,
        transform: [
          "translateY(0px) scale(1)",
          "translateY(-8px) scale(0.995)",
        ],
      }}
      transition={{ duration: 0.22, ease: easeOut }}
    >
      {children}
    </motion.div>
  );
}
