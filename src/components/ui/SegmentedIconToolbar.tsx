import type { CSSProperties, ReactElement, ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  glassSegmentedItem,
  glassSegmentedItemActive,
  glassSegmentedToolbar,
} from "./glassControlStyles";
import { Tooltip } from "./Tooltip";

type SharedActionProps = {
  id: string;
  label: string;
  icon?: ReactNode;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  /** False withholds the tooltip, e.g. while the action's own panel is open. */
  tooltip?: boolean;
};

type ButtonAction = SharedActionProps & {
  type: "button";
  onClick: () => void;
};

type InternalLinkAction = SharedActionProps & {
  type: "link";
  to: string;
};

type ExternalLinkAction = SharedActionProps & {
  type: "anchor";
  href: string;
  target?: string;
  download?: boolean | string;
};

type CustomAction = SharedActionProps & {
  type: "custom";
  render: (className: string, style?: CSSProperties) => ReactElement;
};

export type SegmentedIconToolbarAction =
  | ButtonAction
  | InternalLinkAction
  | ExternalLinkAction
  | CustomAction;

interface SegmentedIconToolbarProps {
  actions: SegmentedIconToolbarAction[];
  className?: string;
  itemClassName?: string;
  activeItemClassName?: string;
  inactiveItemClassName?: string;
  style?: CSSProperties;
  itemStyle?: CSSProperties;
  activeItemStyle?: CSSProperties;
  inactiveItemStyle?: CSSProperties;
  size?: "sm" | "md" | "lg";
  ariaLabel?: string;
}

const SIZE_CLASSES = {
  sm: {
    container: "gap-0.5 p-1",
    item: "h-9 w-9",
    icon: "[&_svg]:h-[18px] [&_svg]:w-[18px]",
  },
  md: {
    container: "gap-1 p-[0.2rem]",
    item: "h-10 w-10",
    icon: "[&_svg]:h-5 [&_svg]:w-5",
  },
  lg: {
    container: "gap-1 p-[0.2rem]",
    item: "h-12 w-12",
    icon: "[&_svg]:h-6 [&_svg]:w-6",
  },
} as const;

export function SegmentedIconToolbar({
  actions,
  className = "",
  itemClassName = "",
  activeItemClassName = "",
  inactiveItemClassName = "",
  style,
  itemStyle,
  activeItemStyle,
  inactiveItemStyle,
  size = "md",
  ariaLabel = "Actions",
}: SegmentedIconToolbarProps) {
  const sizeClasses = SIZE_CLASSES[size];

  const getActionClassName = (action: SegmentedIconToolbarAction): string => {
    const interactionClass = action.active
      ? activeItemClassName || glassSegmentedItemActive
      : inactiveItemClassName ||
        "text-white/78 hover:bg-white/[0.09] hover:text-white";

    return [
      glassSegmentedItem,
      "disabled:pointer-events-none disabled:opacity-40",
      sizeClasses.item,
      sizeClasses.icon,
      interactionClass,
      itemClassName,
      action.className,
    ]
      .filter(Boolean)
      .join(" ");
  };

  const getActionStyle = (
    action: SegmentedIconToolbarAction,
  ): CSSProperties | undefined => ({
    ...itemStyle,
    ...(action.active ? activeItemStyle : inactiveItemStyle),
  });

  return (
    <div
      role="toolbar"
      aria-label={ariaLabel}
      style={style}
      className={[glassSegmentedToolbar, sizeClasses.container, className]
        .filter(Boolean)
        .join(" ")}
    >
      {actions.map((action) => {
        const actionClassName = getActionClassName(action);
        const actionStyle = getActionStyle(action);
        const content = action.icon ?? null;

        if (action.type === "button") {
          return (
            <Tooltip
              key={action.id}
              content={action.label}
              disabled={action.tooltip === false}
            >
              <button
                type="button"
                aria-label={action.label}
                aria-pressed={action.active}
                disabled={action.disabled}
                onClick={action.onClick}
                style={actionStyle}
                className={actionClassName}
              >
                {content}
              </button>
            </Tooltip>
          );
        }

        if (action.type === "link") {
          return (
            <Tooltip
              key={action.id}
              content={action.label}
              disabled={action.tooltip === false}
            >
              <Link
                to={action.to}
                aria-label={action.label}
                style={actionStyle}
                className={actionClassName}
              >
                {content}
              </Link>
            </Tooltip>
          );
        }

        if (action.type === "anchor") {
          return (
            <Tooltip
              key={action.id}
              content={action.label}
              disabled={action.tooltip === false}
            >
              <a
                href={action.href}
                target={action.target}
                download={action.download}
                rel={action.target === "_blank" ? "noreferrer" : undefined}
                aria-label={action.label}
                style={actionStyle}
                className={actionClassName}
              >
                {content}
              </a>
            </Tooltip>
          );
        }

        return (
          <Tooltip
            key={action.id}
            content={action.label}
            disabled={action.tooltip === false}
          >
            {action.render(actionClassName, actionStyle)}
          </Tooltip>
        );
      })}
    </div>
  );
}
