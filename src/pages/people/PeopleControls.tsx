import { useId, type ReactNode } from "react";

/** One setting: a label and its consequence on the left, a switch on the right. */
export function SwitchRow({
  label,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const labelId = useId();
  const descriptionId = useId();

  return (
    <div className={`flex gap-4 py-3.5 ${disabled ? "opacity-50" : ""}`}>
      <div className="min-w-0 flex-1">
        <p id={labelId} className="text-sm font-bold text-white/90">
          {label}
        </p>
        <p
          id={descriptionId}
          className="mt-0.5 text-xs font-medium leading-5 text-white/50"
        >
          {description}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-not-allowed ${
          checked ? "bg-[var(--accent)]" : "bg-white/15"
        }`}
      >
        <span
          aria-hidden="true"
          className={`h-5 w-5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.45)] transition-transform duration-150 ease-out motion-reduce:transition-none ${
            checked ? "translate-x-[1.125rem]" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}

/** A small set of exclusive choices, as pills. */
export function Segmented<Value extends string | number | null>({
  label,
  value,
  options,
  disabled = false,
  fill = false,
  onChange,
}: {
  label: string;
  value: Value;
  /** One row of equal cells, for a short scale that must not wrap. */
  fill?: boolean;
  options: ReadonlyArray<{ value: Value; label: string }>;
  disabled?: boolean;
  onChange: (value: Value) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={
        fill ? "grid auto-cols-fr grid-flow-col gap-1" : "flex flex-wrap gap-1"
      }
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`min-h-9 rounded-full border text-sm font-bold tabular-nums ${fill ? "px-1" : "px-3"} transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-not-allowed disabled:opacity-50 ${
              selected
                ? "border-white/30 bg-white/[0.14] text-white"
                : "border-white/10 text-white/60 hover:bg-white/[0.06] hover:text-white"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A Control Booth panel: hairline, flat, one heading. */
export function Panel({
  title,
  aside,
  className = "",
  children,
}: {
  title: string;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`rounded-2xl border border-white/10 bg-white/[0.03] px-5 pb-2 pt-4 ${className}`}
    >
      <div className="flex items-baseline justify-between gap-3 border-b border-white/[0.07] pb-3">
        <h3 className="text-sm font-black text-white">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export const fieldClassName =
  "min-h-11 w-full rounded-xl border border-white/10 bg-white/[0.06] px-3.5 text-sm font-semibold text-white outline-none transition-[border-color,background-color] duration-150 placeholder:text-white/35 focus:border-[var(--accent)] focus:bg-white/[0.09] disabled:cursor-not-allowed disabled:opacity-50";

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="py-3.5">
      <label
        htmlFor={htmlFor}
        className="block text-[0.6875rem] font-black uppercase tracking-[0.12em] text-white/55"
      >
        {label}
      </label>
      <div className="mt-2">{children}</div>
      {hint ? (
        <p className="mt-1.5 text-xs font-medium leading-5 text-white/50">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
