import { useEffect, useRef, useState } from "react";

const OPEN_AT = 24;
const CLOSE_AT = 8;

/** A settled navbar state, with a dead band to avoid flicker near the top. */
export function useNavbarScrolled(): boolean {
  const [scrolled, setScrolled] = useState(() => window.scrollY >= OPEN_AT);
  const shown = useRef(scrolled);

  useEffect(() => {
    const onScroll = () => {
      const next = shown.current
        ? window.scrollY > CLOSE_AT
        : window.scrollY >= OPEN_AT;
      if (next === shown.current) return;
      shown.current = next;
      setScrolled(next);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return scrolled;
}
