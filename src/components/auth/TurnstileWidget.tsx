import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

/*
 * Cloudflare Turnstile, the check that the person signing up is a person. The
 * widget is usually invisible work: it runs in the background and only asks
 * for a tick when it is unsure. It hands back a one-use token the server
 * verifies; the token is spent by every attempt, so a refused sign-up resets
 * the widget for the next one.
 */
const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render(
    element: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      theme: "dark" | "light" | "auto";
      language?: string;
      size?: "normal" | "flexible" | "compact";
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () =>
      window.turnstile
        ? resolve(window.turnstile)
        : reject(new Error("Turnstile did not start."));
    script.onerror = () => {
      // A blocked or failed load may succeed on the next visit.
      scriptPromise = null;
      script.remove();
      reject(new Error("Turnstile could not be loaded."));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export interface TurnstileHandle {
  reset(): void;
}

export const TurnstileWidget = forwardRef<
  TurnstileHandle,
  {
    siteKey: string;
    language: string;
    onToken: (token: string | null) => void;
    onUnavailable: () => void;
  }
>(function TurnstileWidget({ siteKey, language, onToken, onUnavailable }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const handlers = useRef({ onToken, onUnavailable });
  handlers.current = { onToken, onUnavailable };

  useImperativeHandle(ref, () => ({
    reset() {
      handlers.current.onToken(null);
      if (widgetIdRef.current) window.turnstile?.reset(widgetIdRef.current);
    },
  }));

  useEffect(() => {
    let cancelled = false;
    void loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !containerRef.current) return;
        widgetIdRef.current = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action: "signup",
          theme: "dark",
          size: "flexible",
          language,
          callback: (token) => handlers.current.onToken(token),
          "expired-callback": () => handlers.current.onToken(null),
          "error-callback": () => handlers.current.onToken(null),
        });
      })
      .catch(() => {
        if (!cancelled) handlers.current.onUnavailable();
      });

    return () => {
      cancelled = true;
      if (widgetIdRef.current) {
        window.turnstile?.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [siteKey, language]);

  // The widget draws 65px tall; holding the room stops the form jumping.
  return <div ref={containerRef} className="min-h-[65px] w-full" />;
});
