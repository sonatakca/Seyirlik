import { useEffect, useState } from "react";

/**
 * Where the phone's own heroes are used: a phone, and a tablet held upright.
 * Both get the poster-card home hero and the title page's whole backdrop
 * with its copy beneath. A tablet on its side, a phone on its side and any
 * desktop window, even a narrow tall one (it has no coarse pointer), keep the
 * desktop's hero laid out for their stage.
 */
const PHONE_VIEW_QUERY =
  "(max-width: 599px), (orientation: portrait) and (pointer: coarse)";

function readIsPhoneView(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(PHONE_VIEW_QUERY).matches;
}

export function useIsPhoneView(): boolean {
  const [isPhone, setIsPhone] = useState(readIsPhoneView);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const mediaQuery = window.matchMedia(PHONE_VIEW_QUERY);
    const update = () => setIsPhone(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  return isPhone;
}
