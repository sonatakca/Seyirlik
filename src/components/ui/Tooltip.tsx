import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type Ref,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export type TooltipPlacement = "top" | "bottom" | "left" | "right";

interface TooltipProps {
  children: ReactElement;
  content?: ReactNode;
  shortcut?: ReactNode;
  placement?: TooltipPlacement;
  disabled?: boolean;
  offset?: string;
  group?: string;
}

interface TooltipPosition {
  left: number;
  top: number;
}

type BrowserFullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  mozFullScreenElement?: Element | null;
  msFullscreenElement?: Element | null;
};

const TOOLTIP_FADE_OUT_MS = 180;
const activeTooltipByGroup = new Map<string, () => void>();

function assignRef<TValue>(ref: Ref<TValue> | undefined, value: TValue) {
  if (!ref) {
    return;
  }

  if (typeof ref === "function") {
    ref(value);
    return;
  }

  (ref as { current: TValue }).current = value;
}

function getBrowserFullscreenElement(): Element | null {
  if (typeof document === "undefined") {
    return null;
  }

  const fullscreenDocument = document as BrowserFullscreenDocument;

  return (
    document.fullscreenElement ??
    fullscreenDocument.webkitFullscreenElement ??
    fullscreenDocument.mozFullScreenElement ??
    fullscreenDocument.msFullscreenElement ??
    null
  );
}

function getTooltipPortalRoot(): Element | null {
  if (typeof document === "undefined") {
    return null;
  }

  return getBrowserFullscreenElement() ?? document.body;
}

function cssLengthToPx(value: string): number {
  if (typeof document === "undefined") {
    return 8;
  }

  const root = getTooltipPortalRoot() ?? document.body;
  const element = document.createElement("div");

  element.style.position = "absolute";
  element.style.visibility = "hidden";
  element.style.pointerEvents = "none";
  element.style.width = value;

  root.appendChild(element);

  const pixels = element.getBoundingClientRect().width;

  root.removeChild(element);

  return Number.isFinite(pixels) ? pixels : 8;
}

function getTooltipPosition(
  triggerRect: DOMRect,
  tooltipRect: DOMRect,
  placement: TooltipPlacement,
  offset = "8px",
): TooltipPosition {
  const gap = cssLengthToPx(offset);
  const viewportMargin = 8;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  let resolvedPlacement = placement;

  if (
    placement === "top" &&
    triggerRect.top - tooltipRect.height - gap < viewportMargin
  ) {
    resolvedPlacement = "bottom";
  } else if (
    placement === "bottom" &&
    triggerRect.bottom + tooltipRect.height + gap >
      viewportHeight - viewportMargin
  ) {
    resolvedPlacement = "top";
  } else if (
    placement === "left" &&
    triggerRect.left - tooltipRect.width - gap < viewportMargin
  ) {
    resolvedPlacement = "right";
  } else if (
    placement === "right" &&
    triggerRect.right + tooltipRect.width + gap > viewportWidth - viewportMargin
  ) {
    resolvedPlacement = "left";
  }

  let left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2;
  let top = triggerRect.top - tooltipRect.height - gap;

  if (resolvedPlacement === "bottom") {
    top = triggerRect.bottom + gap;
  } else if (resolvedPlacement === "left") {
    left = triggerRect.left - tooltipRect.width - gap;
    top = triggerRect.top + triggerRect.height / 2 - tooltipRect.height / 2;
  } else if (resolvedPlacement === "right") {
    left = triggerRect.right + gap;
    top = triggerRect.top + triggerRect.height / 2 - tooltipRect.height / 2;
  }

  return {
    left: Math.min(
      Math.max(left, viewportMargin),
      viewportWidth - tooltipRect.width - viewportMargin,
    ),
    top: Math.min(
      Math.max(top, viewportMargin),
      viewportHeight - tooltipRect.height - viewportMargin,
    ),
  };
}

export function Tooltip({
  children,
  content,
  shortcut,
  placement = "top",
  disabled = false,
  offset = "8px",
  group,
}: TooltipProps) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const lastPointerTypeRef = useRef<string | null>(null);
  const lastPointerPositionRef = useRef<{ x: number; y: number } | null>(null);
  const fadeOutTimerRef = useRef<number | null>(null);
  const isScrollLockedRef = useRef(false);
  const scrollUnlockTimerRef = useRef<number | null>(null);
  const isPointerOverRef = useRef(false);
  const [shouldRender, setShouldRender] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const [portalRoot, setPortalRoot] = useState<Element | null>(() =>
    getTooltipPortalRoot(),
  );

  const hasContent = Boolean(content);

  const isPointerStillOverTrigger = () => {
    const trigger = triggerRef.current;
    const pointerPosition = lastPointerPositionRef.current;

    if (!trigger || !pointerPosition) {
      return false;
    }

    const rect = trigger.getBoundingClientRect();

    return (
      pointerPosition.x >= rect.left &&
      pointerPosition.x <= rect.right &&
      pointerPosition.y >= rect.top &&
      pointerPosition.y <= rect.bottom
    );
  };

  const hideImmediately = () => {
    if (fadeOutTimerRef.current !== null) {
      window.clearTimeout(fadeOutTimerRef.current);
      fadeOutTimerRef.current = null;
    }

    setIsVisible(false);
    setShouldRender(false);
    setPosition(null);
  };

  useEffect(() => {
    const hideForGroup = () => {
      hideImmediately();

      if (group && activeTooltipByGroup.get(group) === hideForGroup) {
        activeTooltipByGroup.delete(group);
      }
    };

    if (!hasContent || disabled) {
      hideForGroup();
      // No listeners run while disabled, so a pointer that leaves meanwhile is
      // never seen; forget it, or the next scroll brings the tooltip back.
      isPointerOverRef.current = false;
      lastPointerPositionRef.current = null;
      return;
    }

    const trigger = triggerRef.current;

    if (!trigger) {
      return;
    }

    const show = () => {
      if (isScrollLockedRef.current) {
        return;
      }

      if (fadeOutTimerRef.current !== null) {
        window.clearTimeout(fadeOutTimerRef.current);
        fadeOutTimerRef.current = null;
      }

      if (group) {
        const activeTooltip = activeTooltipByGroup.get(group);

        if (activeTooltip && activeTooltip !== hideForGroup) {
          activeTooltip();
        }

        activeTooltipByGroup.set(group, hideForGroup);
      }

      setPosition(null);
      setShouldRender(true);
      setIsVisible(true);
    };

    const hide = () => {
      setIsVisible(false);

      if (fadeOutTimerRef.current !== null) {
        window.clearTimeout(fadeOutTimerRef.current);
      }

      fadeOutTimerRef.current = window.setTimeout(() => {
        setShouldRender(false);
        setPosition(null);
        fadeOutTimerRef.current = null;

        if (group && activeTooltipByGroup.get(group) === hideForGroup) {
          activeTooltipByGroup.delete(group);
        }
      }, TOOLTIP_FADE_OUT_MS);
    };

    const handlePointerEnter = (event: globalThis.PointerEvent) => {
      lastPointerTypeRef.current = event.pointerType;
      lastPointerPositionRef.current = {
        x: event.clientX,
        y: event.clientY,
      };
      isPointerOverRef.current = true;

      if (event.pointerType !== "touch") {
        show();
      }
    };
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      lastPointerTypeRef.current = event.pointerType;
      lastPointerPositionRef.current = {
        x: event.clientX,
        y: event.clientY,
      };

      if (event.pointerType === "touch") {
        hide();
      }
    };
    const handlePointerMove = (event: globalThis.PointerEvent) => {
      lastPointerTypeRef.current = event.pointerType;
      lastPointerPositionRef.current = {
        x: event.clientX,
        y: event.clientY,
      };
    };
    const handlePointerLeave = () => {
      isPointerOverRef.current = false;
      lastPointerPositionRef.current = null;
      hide();
    };
    const handleMouseEnter = () => {
      isPointerOverRef.current = true;

      if (lastPointerTypeRef.current !== "touch") {
        show();
      }
    };
    const handleFocusIn = () => {
      isPointerOverRef.current = true;

      if (lastPointerTypeRef.current !== "touch") {
        show();
      }
    };
    const handleFocusOut = () => {
      isPointerOverRef.current = false;
      hide();
    };

    trigger.addEventListener("pointerenter", handlePointerEnter);
    trigger.addEventListener("pointerleave", handlePointerLeave);
    trigger.addEventListener("pointerdown", handlePointerDown);
    trigger.addEventListener("pointermove", handlePointerMove);
    trigger.addEventListener("mouseenter", handleMouseEnter);
    trigger.addEventListener("mouseleave", handlePointerLeave);
    trigger.addEventListener("focusin", handleFocusIn);
    trigger.addEventListener("focusout", handleFocusOut);

    return () => {
      trigger.removeEventListener("pointerenter", handlePointerEnter);
      trigger.removeEventListener("pointerleave", handlePointerLeave);
      trigger.removeEventListener("pointerdown", handlePointerDown);
      trigger.removeEventListener("pointermove", handlePointerMove);
      trigger.removeEventListener("mouseenter", handleMouseEnter);
      trigger.removeEventListener("mouseleave", handlePointerLeave);
      trigger.removeEventListener("focusin", handleFocusIn);
      trigger.removeEventListener("focusout", handleFocusOut);

      if (group && activeTooltipByGroup.get(group) === hideForGroup) {
        activeTooltipByGroup.delete(group);
      }
    };
  }, [disabled, group, hasContent]);

  useEffect(() => {
    if (!hasContent || disabled) {
      return;
    }

    const handleScroll = () => {
      isScrollLockedRef.current = true;
      hideImmediately();

      if (scrollUnlockTimerRef.current !== null) {
        window.clearTimeout(scrollUnlockTimerRef.current);
      }

      scrollUnlockTimerRef.current = window.setTimeout(() => {
        isScrollLockedRef.current = false;
        scrollUnlockTimerRef.current = null;

        if (
          isPointerOverRef.current &&
          isPointerStillOverTrigger() &&
          lastPointerTypeRef.current !== "touch"
        ) {
          setPosition(null);
          setShouldRender(true);
          setIsVisible(true);
        }
      }, 260);
    };

    window.addEventListener("scroll", handleScroll, true);

    return () => {
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [disabled, hasContent]);

  useEffect(() => {
    return () => {
      if (fadeOutTimerRef.current !== null) {
        window.clearTimeout(fadeOutTimerRef.current);
      }

      if (scrollUnlockTimerRef.current !== null) {
        window.clearTimeout(scrollUnlockTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const updatePortalRoot = () => {
      setPortalRoot(getTooltipPortalRoot());
      setPosition(null);
    };

    updatePortalRoot();
    document.addEventListener("fullscreenchange", updatePortalRoot);
    document.addEventListener("webkitfullscreenchange", updatePortalRoot);
    document.addEventListener("mozfullscreenchange", updatePortalRoot);
    document.addEventListener("MSFullscreenChange", updatePortalRoot);

    return () => {
      document.removeEventListener("fullscreenchange", updatePortalRoot);
      document.removeEventListener("webkitfullscreenchange", updatePortalRoot);
      document.removeEventListener("mozfullscreenchange", updatePortalRoot);
      document.removeEventListener("MSFullscreenChange", updatePortalRoot);
    };
  }, []);

  useLayoutEffect(() => {
    if (!shouldRender || !hasContent) {
      return;
    }

    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;

    if (!trigger || !tooltip) {
      return;
    }

    const updatePosition = () => {
      setPosition(
        getTooltipPosition(
          trigger.getBoundingClientRect(),
          tooltip.getBoundingClientRect(),
          placement,
          offset,
        ),
      );
    };

    updatePosition();

    window.addEventListener("resize", updatePosition);

    return () => {
      window.removeEventListener("resize", updatePosition);
    };
  }, [
    hasContent,
    shouldRender,
    placement,
    content,
    shortcut,
    offset,
    portalRoot,
  ]);

  // Disabling keeps the same element tree: returning the bare child here would
  // remount the trigger, dropping focus from the button that was just pressed.
  if (!isValidElement(children) || !hasContent) {
    return children;
  }

  const child = children as ReactElement<{
    ref?: Ref<HTMLElement>;
    title?: string;
  }>;

  const trigger = cloneElement(child, {
    // Native title attributes are intentionally stripped here so Seyirlik never
    // shows both a browser tooltip and the custom glass tooltip.
    title: undefined,
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      assignRef(child.props.ref, node);
    },
  });
  const isPositioned = position !== null;

  return (
    <>
      {trigger}
      {shouldRender && portalRoot && !disabled
        ? createPortal(
            <div
              ref={tooltipRef}
              role="tooltip"
              className={`pointer-events-none fixed z-[9999] max-w-[min(32rem,calc(100vw-1rem))] origin-center rounded-lg border border-white/10 bg-zinc-950/85 px-2.5 py-1.5 text-sm font-semibold leading-snug text-white shadow-[0_18px_58px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-xl transition-opacity ease-out ${
                !isPositioned
                  ? "invisible opacity-0 duration-0"
                  : isVisible
                    ? "visible opacity-100 duration-0"
                    : "visible opacity-0 duration-200"
              }`}
              style={
                position
                  ? {
                      left: position.left,
                      top: position.top,
                      visibility: "visible",
                    }
                  : {
                      left: 0,
                      top: 0,
                      visibility: "hidden",
                    }
              }
            >
              <div className="flex max-w-full items-center gap-2">
                {shortcut ? (
                  <span className="rounded-md border border-white/30 bg-white/10 px-1.5 py-0.5 text-xs font-semibold leading-none text-white/95 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]">
                    {shortcut}
                  </span>
                ) : null}

                <span className="min-w-0 max-w-full whitespace-normal break-words">
                  {content}
                </span>
              </div>
            </div>,
            portalRoot,
          )
        : null}
    </>
  );
}
