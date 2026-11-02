import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  RotateCcw,
  X,
} from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import {
  getMotionLabValues,
  setMotionLabEnabled,
  setMotionLabValues,
} from "../../lib/heroMotionLab";
import {
  heroMotionDefaults,
  liftDurationS,
  tuneHeroMotion,
  type HeroMotion,
  type HeroPlace,
  type StageSize,
} from "./homeHeroModel";

type NumberKey = {
  [Key in keyof HeroMotion]: HeroMotion[Key] extends number ? Key : never;
}[keyof HeroMotion];
type PlaceKey = {
  [Key in keyof HeroMotion]: HeroMotion[Key] extends HeroPlace ? Key : never;
}[keyof HeroMotion];
type EaseKey = Exclude<keyof HeroMotion, NumberKey | PlaceKey>;
type Bezier = [number, number, number, number];

interface Dial {
  key: NumberKey;
  min: number;
  max: number;
  step: number;
  unit?: "s" | "×" | "px";
}

const seconds = (key: NumberKey, max = 1.5): Dial => ({
  key,
  min: 0,
  max,
  step: 0.01,
  unit: "s",
});
const share = (key: NumberKey, min = 0): Dial => ({
  key,
  min,
  max: 1,
  step: 0.01,
  unit: "×",
});

/** Every value HERO_MOTION holds, by the move it shapes. */
const GROUPS: ReadonlyArray<{
  title: string;
  dials: Dial[];
  eases?: EaseKey[];
  places?: PlaceKey[];
}> = [
  {
    title: "Layout",
    dials: [],
    places: ["titlePlace", "dockPlace"],
  },
  {
    title: "Lift",
    dials: [
      seconds("travelS"),
      {
        key: "maxTravelPxPerFrameAt1080",
        min: 20,
        max: 300,
        step: 1,
        unit: "px",
      },
      share("riseUndimShare"),
    ],
    eases: ["travelEase"],
  },
  {
    title: "Recede",
    dials: [share("pushBackScale", 0.7), share("pushBackDim")],
  },
  {
    title: "Queue",
    dials: [
      seconds("slideS"),
      seconds("slideDelayS", 0.5),
      seconds("dropS"),
      seconds("queueArriveDimS"),
      seconds("swipeSettleS"),
    ],
    eases: ["slideEase", "settleEase"],
  },
  {
    title: "Copy",
    dials: [
      share("copyLeadIn"),
      seconds("copyExitS"),
      seconds("copyExitStaggerS", 0.3),
      seconds("copyEnterS"),
      seconds("copyEnterStaggerS", 0.3),
      seconds("overviewS"),
    ],
  },
  {
    title: "First arrival",
    dials: [
      seconds("openCopyDelayS"),
      seconds("openQueueDelayS"),
      seconds("openQueueDimS"),
      seconds("openQueueStaggerS", 0.3),
      seconds("openQueueFadeS"),
      seconds("skeletonFadeS"),
    ],
  },
  {
    title: "Halo",
    dials: [
      seconds("hoverS"),
      { key: "hoverHaloPx", min: 0, max: 100, step: 1, unit: "px" },
      { key: "hoverHaloReachPx", min: 0, max: 100, step: 1, unit: "px" },
      share("hoverHalo"),
      { key: "hoverHaloSaturate", min: 0, max: 3, step: 0.05, unit: "×" },
    ],
  },
  {
    title: "Logo",
    dials: [
      seconds("logoLapS", 2),
      { key: "logoTailLaps", min: 0, max: 20, step: 1, unit: "×" },
      seconds("logoHoldS", 3),
      seconds("logoFadeS", 2),
    ],
  },
  {
    title: "Other",
    dials: [seconds("trailerS", 3), seconds("progressFadeS")],
  },
];

const round = (value: number) => Math.round(value * 1000) / 1000;

/** The values that differ from the defaults, as they would be written in code. */
function changes(values: Partial<HeroMotion>): string {
  const defaults = heroMotionDefaults();
  const lines = Object.entries(values)
    .filter(
      ([key, value]) =>
        JSON.stringify(value) !==
        JSON.stringify(defaults[key as keyof HeroMotion]),
    )
    .map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`);
  return lines.length ? `{\n${lines.join("\n")}\n}` : "{}";
}

interface HeroMotionLabProps {
  stage: StageSize | null;
  isTravelling: boolean;
  onPrevious: () => void;
  onNext: () => void;
  /** The values changed: the hero redraws what it lays out from them. */
  onTune: () => void;
}

/**
 * The motion lab's panel, over the real home hero.
 *
 * It does not draw a hero of its own: it sets the values the live hero moves
 * by, and its buttons run the hero's own travel. What it shows is exactly what
 * those values ship as. Leaving the page puts the defaults back.
 */
export default function HeroMotionLab({
  stage,
  isTravelling,
  onPrevious,
  onNext,
  onTune,
}: HeroMotionLabProps) {
  const { t } = useLanguage();
  const defaults = heroMotionDefaults();
  const [values, setValues] = useState<Partial<HeroMotion>>(getMotionLabValues);
  const [isOpen, setIsOpen] = useState(true);
  const [copied, setCopied] = useState(false);

  // Top left, clear of the queue and the title; moved by its header.
  const [place, setPlace] = useState({ left: 16, top: 80 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const startDrag = (event: PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    drag.current = {
      x: event.clientX - place.left,
      y: event.clientY - place.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    const from = drag.current;
    if (!from) return;
    setPlace({
      left: Math.min(
        Math.max(0, event.clientX - from.x),
        window.innerWidth - 120,
      ),
      top: Math.min(
        Math.max(0, event.clientY - from.y),
        window.innerHeight - 48,
      ),
    });
  };

  // Set on the live hero as they change, before any move can read them, and
  // undone on leaving. Setting the same values again changes nothing, so this
  // may run during render; the lift is then worked out as the hero will.
  const lift = useMemo(() => {
    tuneHeroMotion(values);
    return stage ? liftDurationS(stage) : null;
  }, [values, stage]);
  useEffect(() => setMotionLabValues(values), [values]);
  const onTuneRef = useRef(onTune);
  useEffect(() => {
    onTuneRef.current = onTune;
  });
  // Set again once mounted: a remount (as React's development mode does at
  // once) runs the reset below first.
  useEffect(() => {
    tuneHeroMotion(values);
    onTuneRef.current();
  }, [values]);
  useEffect(
    () => () => {
      tuneHeroMotion({});
      onTuneRef.current();
    },
    [],
  );

  const current = { ...defaults, ...values };

  const set = <Key extends keyof HeroMotion>(
    key: Key,
    value: HeroMotion[Key],
  ) => setValues((previous) => ({ ...previous, [key]: value }));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(changes(values));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const button =
    "inline-flex h-9 items-center justify-center gap-1.5 rounded-full px-3 text-xs font-black text-white/80 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30 disabled:opacity-40";

  // Solid, with no backdrop blur: Safari would redraw a blur over the moving
  // hero on every frame, and the swap being judged would run slower than it
  // does without the panel.
  return createPortal(
    <aside
      aria-label={t("devtools.motionLab.title")}
      style={{ left: place.left, top: place.top }}
      className="fixed z-[130] flex max-h-[55vh] w-[22rem] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[rgb(12_12_14)] text-white shadow-[0_18px_60px_rgba(0,0,0,0.6)]"
    >
      <header
        className="flex cursor-grab touch-none select-none items-center gap-1 border-b border-white/10 px-2 py-1.5 active:cursor-grabbing"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <h2 className="flex-1 truncate px-2 text-sm font-black">
          {t("devtools.motionLab.title")}
        </h2>
        <button
          type="button"
          className={button}
          onClick={onPrevious}
          disabled={isTravelling}
          aria-label={t("hero.previous")}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          type="button"
          className={button}
          onClick={onNext}
          disabled={isTravelling}
          aria-label={t("hero.next")}
        >
          <ChevronRight size={16} />
        </button>
        <button
          type="button"
          className={button}
          onClick={() => setIsOpen((open) => !open)}
          aria-expanded={isOpen}
          aria-label={
            isOpen
              ? t("devtools.motionLab.collapse")
              : t("devtools.motionLab.expand")
          }
        >
          {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        <button
          type="button"
          className={button}
          onClick={() => setMotionLabEnabled(false)}
          aria-label={t("devtools.motionLab.close")}
        >
          <X size={16} />
        </button>
      </header>

      {isOpen ? (
        <>
          <p className="border-b border-white/10 px-4 py-2 text-xs font-bold text-white/55">
            {t("devtools.motionLab.actualLift")}{" "}
            <span className="tabular-nums text-white">
              {lift === null ? "–" : `${round(lift)} s`}
            </span>
            {lift !== null && lift > current.travelS + 0.0005 ? (
              <span className="text-amber-300">
                {" "}
                · {t("devtools.motionLab.capped")}
              </span>
            ) : null}
          </p>
          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
            {GROUPS.map((group) => (
              <section key={group.title}>
                <h3 className="mb-1.5 text-[0.6875rem] font-black uppercase tracking-[0.16em] text-white/35">
                  {group.title}
                </h3>
                <div className="space-y-2">
                  {group.places?.map((key) => (
                    <PlaceRow
                      key={key}
                      name={key}
                      value={current[key]}
                      isChanged={current[key] !== defaults[key]}
                      onChange={(value) => set(key, value)}
                    />
                  ))}
                  {group.dials.map((dial) => (
                    <DialRow
                      key={dial.key}
                      dial={dial}
                      value={current[dial.key]}
                      isChanged={current[dial.key] !== defaults[dial.key]}
                      onChange={(value) => set(dial.key, value)}
                    />
                  ))}
                  {group.eases?.map((key) => (
                    <EaseRow
                      key={key}
                      name={key}
                      value={current[key]}
                      isChanged={
                        JSON.stringify(current[key]) !==
                        JSON.stringify(defaults[key])
                      }
                      onChange={(value) => set(key, value)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
          <footer className="flex gap-1 border-t border-white/10 px-2 py-1.5">
            <button
              type="button"
              className={button}
              onClick={() => setValues({})}
            >
              <RotateCcw size={14} />
              {t("devtools.motionLab.reset")}
            </button>
            <button
              type="button"
              className={button}
              onClick={() => void copy()}
            >
              <Copy size={14} />
              {copied
                ? t("devtools.motionLab.copied")
                : t("devtools.motionLab.copy")}
            </button>
          </footer>
        </>
      ) : null}
    </aside>,
    document.body,
  );
}

/** The one-line description each value carries under its name. */
const hintKey = (key: keyof HeroMotion) =>
  `devtools.motionLab.hint.${key}` as TranslationKey;

function PlaceRow({
  name,
  value,
  isChanged,
  onChange,
}: {
  name: PlaceKey;
  value: HeroPlace;
  isChanged: boolean;
  onChange: (value: HeroPlace) => void;
}) {
  const { t } = useLanguage();
  const places: HeroPlace[] = ["left", "centre"];
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-2">
      <div className="min-w-0">
        <span
          className={`block truncate font-mono text-[0.6875rem] ${
            isChanged ? "text-amber-300" : "text-white/70"
          }`}
        >
          {name}
        </span>
        <span className="block text-[0.6875rem] font-semibold leading-4 text-white/40">
          {t(hintKey(name))}
        </span>
      </div>
      <div
        role="radiogroup"
        aria-label={name}
        className="flex rounded-full bg-white/[0.07] p-0.5"
      >
        {places.map((place) => (
          <button
            key={place}
            type="button"
            role="radio"
            aria-checked={value === place}
            onClick={() => onChange(place)}
            className={`h-7 rounded-full px-3 text-xs font-black transition focus:outline-none focus-visible:ring-1 focus-visible:ring-white/40 ${
              value === place
                ? "bg-white text-black"
                : "text-white/60 hover:text-white"
            }`}
          >
            {t(`devtools.motionLab.place.${place}` as TranslationKey)}
          </button>
        ))}
      </div>
    </div>
  );
}

function DialRow({
  dial,
  value,
  isChanged,
  onChange,
}: {
  dial: Dial;
  value: number;
  isChanged: boolean;
  onChange: (value: number) => void;
}) {
  const { t } = useLanguage();
  const id = `motion-lab-${dial.key}`;
  return (
    <div className="grid grid-cols-[1fr_4.5rem] items-center gap-x-2">
      <label htmlFor={id} className="min-w-0">
        <span
          className={`block truncate font-mono text-[0.6875rem] ${
            isChanged ? "text-amber-300" : "text-white/70"
          }`}
        >
          {dial.key}
        </span>
        <span className="block text-[0.6875rem] font-semibold leading-4 text-white/40">
          {t(hintKey(dial.key))}
        </span>
      </label>
      <input
        type="number"
        aria-label={dial.key}
        value={round(value)}
        min={dial.min}
        step={dial.step}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        className="h-7 rounded-md bg-white/[0.07] px-1.5 text-right font-mono text-xs tabular-nums text-white outline-none focus:ring-1 focus:ring-white/30"
      />
      <input
        id={id}
        type="range"
        value={value}
        min={dial.min}
        max={Math.max(dial.max, value)}
        step={dial.step}
        onChange={(event) => onChange(Number(event.target.value))}
        className="col-span-2 h-4 w-full accent-[var(--accent)]"
      />
    </div>
  );
}

function EaseRow({
  name,
  value,
  isChanged,
  onChange,
}: {
  name: EaseKey;
  value: Bezier;
  isChanged: boolean;
  onChange: (value: Bezier) => void;
}) {
  const { t } = useLanguage();
  const [x1, y1, x2, y2] = value;
  // The curve in a 40-unit box, y up, with room for overshoot.
  const path = `M0 40 C${x1 * 40} ${40 - y1 * 40} ${x2 * 40} ${40 - y2 * 40} 40 0`;
  return (
    <div>
      <div
        className={`mb-1 font-mono text-[0.6875rem] ${
          isChanged ? "text-amber-300" : "text-white/70"
        }`}
      >
        {name}
        <span className="block font-sans text-[0.6875rem] font-semibold leading-4 text-white/40">
          {t(hintKey(name))}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <svg
          viewBox="-4 -12 48 64"
          className="h-12 w-9 shrink-0 rounded-md bg-white/[0.05]"
          aria-hidden="true"
        >
          <path d="M0 40 L40 0" stroke="rgba(255,255,255,0.15)" fill="none" />
          <path d={path} stroke="white" strokeWidth={2} fill="none" />
        </svg>
        <div className="grid flex-1 grid-cols-4 gap-1">
          {value.map((number, index) => (
            <input
              key={index}
              type="number"
              aria-label={`${name} ${["x1", "y1", "x2", "y2"][index]}`}
              value={round(number)}
              step={0.01}
              min={index % 2 === 0 ? 0 : undefined}
              max={index % 2 === 0 ? 1 : undefined}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (!Number.isFinite(next)) return;
                const copy = [...value] as Bezier;
                copy[index] =
                  index % 2 === 0 ? Math.min(1, Math.max(0, next)) : next;
                onChange(copy);
              }}
              className="h-7 min-w-0 rounded-md bg-white/[0.07] px-1 text-right font-mono text-xs tabular-nums text-white outline-none focus:ring-1 focus:ring-white/30"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
