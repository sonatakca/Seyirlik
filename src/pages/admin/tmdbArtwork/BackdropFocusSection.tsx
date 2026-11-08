import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Crosshair, RotateCcw, Save } from "lucide-react";
import { useLanguage } from "../../../i18n/LanguageContext";
import type { TranslationKey } from "../../../i18n/translations";
import {
  CENTRE_FOCUS,
  clampFocus,
  coverPosition,
  coverRect,
  isCentred,
  type ImageFocus,
} from "../../../lib/imageFocus";
import { getBackdropImageUrl } from "../../../lib/mediaApi";
import { getStatusClasses, type ActionStatus } from "../tmdbArtworkModel";

/**
 * The shapes a backdrop is actually cropped to. A hero takes the backdrop
 * only in a landscape frame (a tall one shows the poster), so these are the
 * full-screen hero on a desktop and on a laptop, and the phone's title hero,
 * a near-square band 20rem tall.
 */
const FRAMES: ReadonlyArray<{
  labelKey: TranslationKey;
  width: number;
  height: number;
}> = [
  { labelKey: "backdropFocus.desktop", width: 16, height: 9 },
  { labelKey: "backdropFocus.laptop", width: 16, height: 10 },
  { labelKey: "backdropFocus.phone", width: 343, height: 320 },
];

const STEP = 0.01;
const BIG_STEP = 0.05;

/**
 * Picks the point of a title's backdrop that every hero keeps in view.
 *
 * The picture is shown whole, with the desktop hero's cut darkened around it,
 * so where the point goes and what it costs are visible at once; the three
 * previews below are the real crops, drawn with the same geometry the heroes
 * use.
 *
 * Its state starts from what is stored, so the page keys it by title and
 * backdrop: another title or a replaced backdrop mounts a fresh editor.
 */
export function BackdropFocusSection({
  itemId,
  backdropTag,
  savedFocus,
  onSave,
  className,
}: {
  itemId: string;
  backdropTag: string | null;
  savedFocus: ImageFocus | null;
  onSave: (focus: ImageFocus | null) => Promise<void>;
  className: string;
}) {
  const { t } = useLanguage();
  const [focus, setFocus] = useState<ImageFocus>(savedFocus ?? CENTRE_FOCUS);
  const [natural, setNatural] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [status, setStatus] = useState<ActionStatus>({
    tone: "idle",
    message: "",
  });
  const pictureRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const busy = status.tone === "busy";
  const stored = savedFocus ?? CENTRE_FOCUS;
  const changed =
    Math.abs(focus.x - stored.x) > 0.0005 ||
    Math.abs(focus.y - stored.y) > 0.0005;

  const pointAt = (event: PointerEvent<HTMLDivElement>) => {
    const box = pictureRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return;
    setFocus(
      clampFocus({
        x: (event.clientX - box.left) / box.width,
        y: (event.clientY - box.top) / box.height,
      }),
    );
  };

  const nudge = (event: KeyboardEvent<HTMLDivElement>) => {
    if (busy) return;
    const step = event.shiftKey ? BIG_STEP : STEP;
    const move: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const delta = move[event.key];
    if (!delta) return;
    event.preventDefault();
    setFocus((value) =>
      clampFocus({ x: value.x + delta[0], y: value.y + delta[1] }),
    );
  };

  async function save(chosen: ImageFocus | null) {
    // A thousandth of the picture is finer than any pointer can place.
    const round = (value: number) => Math.round(value * 1000) / 1000;
    const next = chosen ? { x: round(chosen.x), y: round(chosen.y) } : null;
    setStatus({ tone: "busy", message: t("backdropFocus.saving") });
    try {
      await onSave(next);
      setFocus(next ?? CENTRE_FOCUS);
      setStatus({
        tone: "success",
        message: next ? t("backdropFocus.saved") : t("backdropFocus.cleared"),
      });
    } catch {
      setStatus({ tone: "error", message: t("backdropFocus.couldNotSave") });
    }
  }

  const imageUrl = backdropTag
    ? getBackdropImageUrl(itemId, backdropTag, 1280)
    : "";
  // The desktop hero's window on the picture, in fractions of it.
  const desktop = FRAMES[0]!;
  const cut = natural
    ? (() => {
        const rect = coverRect(natural, desktop, focus);
        return {
          left: -rect.left / rect.width,
          top: -rect.top / rect.height,
          width: desktop.width / rect.width,
          height: desktop.height / rect.height,
        };
      })()
    : null;
  const percent = (value: number) => `${Math.round(value * 100)}%`;

  return (
    <section
      id="artwork-focus"
      aria-labelledby="artwork-focus-title"
      className={`${className} scroll-mt-28`}
    >
      <h2
        id="artwork-focus-title"
        className="flex items-center gap-2 text-base font-black text-white"
      >
        <Crosshair className="h-4 w-4 text-white/35" aria-hidden="true" />
        {t("backdropFocus.title")}
      </h2>
      <p className="mt-1 text-xs font-semibold text-white/40">
        {t("backdropFocus.description")}
      </p>

      {!backdropTag ? (
        <p className="mt-3 text-sm font-bold text-white/40">
          {t("backdropFocus.noBackdrop")}
        </p>
      ) : (
        <div className="mt-4 max-w-4xl">
          <div className="min-w-0">
            <div
              ref={pictureRef}
              role="group"
              tabIndex={busy ? -1 : 0}
              aria-label={`${t("backdropFocus.marker")}: ${percent(focus.x)}, ${percent(focus.y)}`}
              aria-describedby="artwork-focus-instructions"
              onKeyDown={nudge}
              onPointerDown={(event) => {
                if (busy || event.button !== 0) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                draggingRef.current = true;
                pointAt(event);
              }}
              onPointerMove={(event) => {
                if (draggingRef.current) pointAt(event);
              }}
              onPointerUp={(event) => {
                draggingRef.current = false;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
              }}
              onPointerCancel={() => {
                draggingRef.current = false;
              }}
              className="relative w-full cursor-crosshair touch-none select-none overflow-hidden rounded-2xl bg-black/40 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              style={{
                aspectRatio: natural
                  ? `${natural.width} / ${natural.height}`
                  : "16 / 9",
              }}
            >
              <img
                src={imageUrl}
                alt=""
                draggable={false}
                onLoad={(event) =>
                  setNatural({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
                className="absolute inset-0 h-full w-full"
              />
              {cut ? (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute rounded-md border border-white/70 shadow-[0_0_0_200vmax_rgba(0,0,0,0.55)]"
                  style={{
                    left: percent(cut.left),
                    top: percent(cut.top),
                    width: percent(cut.width),
                    height: percent(cut.height),
                  }}
                />
              ) : null}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.65),0_2px_10px_rgba(0,0,0,0.7)]"
                style={{ left: percent(focus.x), top: percent(focus.y) }}
              >
                <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.65)]" />
              </div>
            </div>
            <p
              id="artwork-focus-instructions"
              className="mt-3 text-xs font-semibold leading-6 text-white/45"
            >
              {t("backdropFocus.instructions")}
            </p>
          </div>

          <div className="mt-4 min-w-0">
            <p className="text-[0.62rem] font-black uppercase tracking-[0.1em] text-white/35">
              {t("backdropFocus.previews")}
            </p>
            {/* One height for every frame, so the shapes compare at a glance. */}
            <ul className="mt-2 flex flex-wrap items-end gap-3">
              {FRAMES.map((frame) => {
                const position = natural
                  ? coverPosition(natural, frame, focus)
                  : { x: 0.5, y: 0.5 };
                return (
                  <li key={frame.labelKey}>
                    <img
                      src={imageUrl}
                      alt=""
                      draggable={false}
                      className="h-24 w-auto rounded-xl border border-white/10 object-cover sm:h-32"
                      style={{
                        aspectRatio: `${frame.width} / ${frame.height}`,
                        objectPosition: `${position.x * 100}% ${position.y * 100}%`,
                      }}
                    />
                    <span className="mt-1 block text-[0.68rem] font-black uppercase tracking-[0.08em] text-white/45">
                      {t(frame.labelKey)}
                    </span>
                  </li>
                );
              })}
            </ul>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || !changed}
                onClick={() => void save(isCentred(focus) ? null : focus)}
                className="inline-flex items-center gap-2 rounded-2xl bg-emerald-400/20 px-4 py-2 text-sm font-black text-emerald-100 transition hover:bg-emerald-400/30 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <Save className="h-4 w-4" aria-hidden="true" />
                {t("backdropFocus.save")}
              </button>
              <button
                type="button"
                disabled={busy || (!savedFocus && isCentred(focus))}
                onClick={() => void save(null)}
                className="inline-flex items-center gap-2 rounded-2xl border border-white/15 px-4 py-2 text-sm font-black text-white/70 transition hover:border-white/30 hover:text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                {t("backdropFocus.centre")}
              </button>
            </div>
            {status.message ? (
              <p
                role={status.tone === "error" ? "alert" : "status"}
                className={`mt-2 text-xs font-bold ${getStatusClasses(status.tone)}`}
              >
                {status.message}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
