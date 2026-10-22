import { useEffect, useState } from "react";

export const MOBILE_VIEW_QUERY = "(max-width: 1023px)";
const devMode = import.meta.env.DEV;

export function readIsMobileView(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) {
    return false;
  }

  return window.matchMedia(MOBILE_VIEW_QUERY).matches;
}

export function useIsMobileView(): boolean {
  const [isMobile, setIsMobile] = useState(readIsMobileView);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return undefined;
    }

    const mediaQuery = window.matchMedia(MOBILE_VIEW_QUERY);
    const updateIsMobile = () => {
      if (devMode) {
        console.log("devMode", devMode);
        console.log("innerWidth:", window.innerWidth);
        console.log("visualViewport:", window.visualViewport?.width);
        console.log("mobile:", mediaQuery.matches);
      }

      setIsMobile(mediaQuery.matches);
    };

    updateIsMobile();
    mediaQuery.addEventListener("change", updateIsMobile);

    return () => {
      mediaQuery.removeEventListener("change", updateIsMobile);
    };
  }, []);

  return isMobile;
}
