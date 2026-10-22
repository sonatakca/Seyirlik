import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Curve, type ValueSource } from "../../lib/timeline/curve";
import { useBake, type BakedFrame } from "../../lib/timeline/bake";
import {
  CLIP_RADIUS,
  CORNERS,
  CORNER_RADIUS,
  coverFit,
  frameAt,
  type Corner,
} from "./heroFrame";
import { useLanguage } from "../../i18n/LanguageContext";
import { getLogoImageUrl } from "../../lib/mediaApi";
import {
  getItemDisplayMetadata,
  getItemLogoUrl,
} from "../../lib/itemMetadataPreferences";
import { useCroppedTransparentImage } from "../../hooks/useCroppedTransparentImage";
import type { MediaItem } from "../../lib/types";
import type { SampleRegion } from "../../lib/logoShadow";
import { getStageImageCandidates } from "../hero/heroModel";
import { sampleUrl, useLogoShadow } from "./logoShadowStyle";
import { useRegisterNavbarBackdrop } from "../../lib/navbarBackdrop";
import { useBakedLogoShadows } from "./useBakedLogoShadows";
import {
  measureWords,
  useReportedSize,
  type DrawnSize,
} from "./useReportedSize";
import {
  QUEUE_TITLE_BOX,
  TITLE_SCALE,
  heroForm,
  heroFrameRadius,
  queueTitleTransform,
  stageness,
  tallFootGradient,
  type HeroLayout,
  type Placement,
  type StageSize,
} from "./homeHeroModel";

/**
 * One featured title, drawn once at the stage's full size.
 *
 * On stage it is at scale 1; in the queue it is this same element scaled down
 * into its slot. Nothing about a title is redrawn when it moves between the
 * two — the transform is the whole transition, which is why the miniature and
 * the stage can never disagree about how the title looks.
 *
 * Everything that moves is baked into Web Animations from the composition's
 * Curves (see lib/timeline), so the compositor plays a journey at the
 * display's full rate and nothing is written on the main thread while it does.
 * The frame's corners keep their on-screen radius at any scale, and a tablet
 * miniature is cropped shorter, without animating a radius, a clip-path or a
 * height: the frame is the intersection of four clipping boxes, each rounding
 * one corner, carried to the frame's corners by transforms (see `frameAt`).
 */

/** Every value that places or shades a composition, owned by the choreography. */
export interface CompositionMotion {
  x: Curve;
  y: Curve;
  scale: Curve;
  /** Black over the whole frame, 0–1: receding or leaving. */
  dim: Curve;
  /** The title's own scale inside the frame: resting, open, or trailer. */
  titleScale: Curve;
  /** The title's rise, in px, while the overview is open under it. */
  titleY: Curve;
  /** 0–1: the trailer over the artwork. */
  trailer: Curve;
}

export function createCompositionMotion(
  placement: Placement,
  dim = 0,
  titleRest: number = TITLE_SCALE.rest,
): CompositionMotion {
  return {
    x: new Curve(placement.x),
    y: new Curve(placement.y),
    scale: new Curve(placement.scale),
    dim: new Curve(dim),
    titleScale: new Curve(titleRest),
    titleY: new Curve(0),
    trailer: new Curve(0),
  };
}

const QUEUE_LOGO_REGION: SampleRegion = {
  left: QUEUE_TITLE_BOX.left,
  top: 1 - QUEUE_TITLE_BOX.bottom - QUEUE_TITLE_BOX.height,
  width: QUEUE_TITLE_BOX.width,
  height: QUEUE_TITLE_BOX.height,
};

interface HeroCompositionProps {
  item: MediaItem;
  stage: StageSize;
  /** Where the title sits in the frame; the copy overlay reads the same. */
  titleBox: HeroLayout["title"];
  /**
   * The tallest a logo may be drawn at full size. Every logo takes the title
   * box's width and grows upward as its own proportions ask; only a logo
   * close to square, which would rise into the menu when the overview opens,
   * is held to this.
   */
  logoMaxHeight: number;
  motion: CompositionMotion;
  /** The scale a slot holds a composition at; corners round in step with it. */
  slotScale: number;
  slotHeight?: number;
  /** The title's own scale at rest, which its box is measured at. */
  titleRestScale?: number;
  /**
   * The whole frame's opacity, for a miniature stepping aside: on a tall
   * stage the queue makes way for the overview, which opens across it.
   */
  opacity?: ValueSource;
  zIndex: number;
  /** The one on stage speaks to assistive technology; miniatures do not. */
  isStage: boolean;
  trailerUrl?: string | null;
  isTrailerPlaying?: boolean;
  isTrailerMuted?: boolean;
  onTrailerEnded?: () => void;
  onArtworkReady?: () => void;
  /**
   * False while the page holds the hero hidden behind its skeleton: the
   * artwork and logo load but wait to fade in until they can be seen.
   */
  isRevealed?: boolean;
  /**
   * The title as drawn at full size, logo or lettering, before the scale it
   * rests or travels at: the copy's hover target reaches exactly that high.
   */
  onTitleSize?: (size: DrawnSize) => void;
}

/** A logo held to its box by `object-contain`, measured as it is drawn. */
function drawnLogoSize(image: HTMLImageElement): DrawnSize {
  const box = { width: image.offsetWidth, height: image.offsetHeight };
  if (!image.naturalWidth || !image.naturalHeight) return box;
  const aspect = image.naturalWidth / image.naturalHeight;
  return {
    width: Math.min(box.width, box.height * aspect),
    height: Math.min(box.height, box.width / aspect),
  };
}

export function HeroComposition({
  item,
  stage,
  titleBox,
  logoMaxHeight,
  motion: m,
  slotScale,
  slotHeight,
  titleRestScale = TITLE_SCALE.rest,
  opacity,
  zIndex,
  isStage,
  trailerUrl,
  isTrailerPlaying = false,
  isTrailerMuted = true,
  onTrailerEnded,
  onArtworkReady,
  isRevealed = true,
  onTitleSize,
}: HeroCompositionProps) {
  const { language } = useLanguage();
  const [failed, setFailed] = useState<string[]>([]);
  const [isArtworkLoaded, setIsArtworkLoaded] = useState(false);
  const [isLogoLoaded, setIsLogoLoaded] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const logoRef = useReportedSize<HTMLImageElement>(onTitleSize, drawnLogoSize);
  const letteringRef = useReportedSize<HTMLHeadingElement>(
    onTitleSize,
    measureWords,
  );
  const frameRef = useRef<HTMLDivElement>(null);

  const form = heroForm(stage);
  const artwork = getStageImageCandidates(item, form, stage.width).find(
    (candidate) => !failed.includes(candidate.url),
  );
  /**
   * A poster carries its own lettering, so a miniature shows it as printed
   * and draws no logo; as the frame grows onto the stage the foot fades the
   * printed title away and the logo comes up in its place.
   */
  const isPoster = artwork?.type === "poster";
  // On stage the artwork is what the navbar stands on. Its box is the stage
  // itself, where the frame comes to rest, so a lift still under way does
  // not skew where the navbar's wordmark falls on it.
  const artworkUrl = artwork?.url;
  const navbarBackdrop = useMemo(
    () =>
      isStage && artworkUrl
        ? {
            url: sampleUrl(artworkUrl),
            getBox: () =>
              (
                frameRef.current?.parentElement ?? document.body
              ).getBoundingClientRect(),
            position: { x: 0.5, y: isPoster ? 0 : 0.5 },
          }
        : null,
    [isStage, artworkUrl, isPoster],
  );
  useRegisterNavbarBackdrop(navbarBackdrop);
  const fallbackLogoUrl = item.ImageTags?.Logo
    ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 1100)
    : "";
  const logoUrl = useCroppedTransparentImage(
    getItemLogoUrl(item, language, fallbackLogoUrl),
  );
  const title = getItemDisplayMetadata(item, language).title ?? item.Name;

  const footGradient = useMemo(
    () => tallFootGradient(stage, titleBox, titleRestScale),
    [stage, titleBox, titleRestScale],
  );

  // Crop the wider tablet miniature without changing its travel scale.
  const queueHeight = slotHeight ? slotHeight / slotScale : stage.height;

  // In a slot the logo is drawn large at the miniature's bottom-left so it
  // reads at that size; on stage it is at its own place and size. Between
  // the two it follows the frame's scale, so a lift carries it smoothly.
  const queueMove = useMemo(
    () => queueTitleTransform({ ...stage, height: queueHeight }, titleBox),
    [stage, titleBox, queueHeight],
  );
  // A black silhouette of the logo under it, as strong as the artwork needs,
  // for as long as the frame is a miniature.
  const shadow = useLogoShadow(logoUrl, artwork?.url, QUEUE_LOGO_REGION);
  // On stage the logo is measured where it rests, at its resting size.
  const stageLogoRegion = useMemo<SampleRegion>(() => {
    const height = titleBox.height * titleRestScale;
    return {
      left: titleBox.left / stage.width,
      top: 1 - (titleBox.bottom + height) / stage.height,
      width: (titleBox.width * titleRestScale) / stage.width,
      height: height / stage.height,
    };
  }, [stage, titleBox, titleRestScale]);
  const stageShadow = useLogoShadow(logoUrl, artwork?.url, stageLogoRegion);
  const baked = useBakedLogoShadows(
    logoUrl,
    titleBox.width,
    logoMaxHeight,
    slotScale * queueMove.scale,
  );

  // ------------------------------------------------------------- the bake
  const clipRefs = useRef<Record<Corner, HTMLDivElement | null>>({
    tl: null,
    tr: null,
    br: null,
    bl: null,
  });
  const pictureRef = useRef<HTMLDivElement>(null);
  const artworkRef = useRef<HTMLImageElement>(null);
  const hairlineRef = useRef<HTMLDivElement>(null);
  const trailerRef = videoRef;
  const footRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const silhouetteRef = useRef<HTMLDivElement>(null);
  const presenceRef = useRef<HTMLDivElement>(null);
  const haloRef = useRef<HTMLImageElement>(null);
  const dimRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{
    width: number;
    height: number;
  } | null>(null);
  // Big enough that, scaled down to the smallest radius, a clipping box still
  // reaches past the whole stage from its corner.
  const big = Math.ceil(3 * Math.max(stage.width, stage.height));
  const objectY = isPoster ? 0 : 0.5;

  const sources = useMemo(
    () => [m.x, m.y, m.scale, m.dim, m.titleScale, m.titleY, m.trailer],
    [m],
  );
  useBake(
    opacity ? [...sources, opacity] : sources,
    (at): BakedFrame => {
      const scale = m.scale.get(at);
      const toStage = stageness(scale, slotScale);
      const height = queueHeight + (stage.height - queueHeight) * toStage;
      const radius = heroFrameRadius(scale, slotScale) * scale;
      const frame = frameAt(
        {
          x: m.x.get(at),
          y: m.y.get(at),
          s: scale,
          width: stage.width,
          height,
        },
        radius,
        big,
      );
      const rise = m.titleY.get(at);
      const titleScale =
        queueMove.scale + (m.titleScale.get(at) - queueMove.scale) * toStage;
      // The title stands on the frame's foot, which a short frame raises.
      const titleY =
        queueMove.y * (1 - toStage) + rise * toStage - (stage.height - height);
      const trailer = m.trailer.get(at);
      // A hairline that stays one pixel on screen in a slot, gone by the
      // time the frame fills the stage.
      const hairline = Math.min(1, Math.max(0, (0.55 - scale) / 0.35));
      const footPresence = Math.min(
        1,
        Math.max(
          0,
          (scale - slotScale) / (Math.max(slotScale + 0.01, 0.6) - slotScale),
        ),
      );
      const logoPresence = isPoster
        ? Math.min(1, Math.max(0, (toStage - 0.35) / 0.5))
        : 1;
      return [
        ...CORNERS.map(
          (corner) =>
            [
              clipRefs.current[corner],
              { transform: frame.clips[corner] },
            ] as const,
        ),
        [pictureRef.current, { transform: frame.picture }],
        [
          artworkRef.current,
          {
            transform: natural
              ? coverFit(natural, stage, height, objectY).transform
              : "none",
          },
        ],
        [
          hairlineRef.current,
          {
            transform: `scaleY(${height / queueHeight})`,
            opacity: hairline,
          },
        ],
        [trailerRef.current, { opacity: trailer }],
        [
          footRef.current,
          {
            transform: `scaleY(${height / stage.height})`,
            opacity: footPresence,
          },
        ],
        [
          titleRef.current,
          {
            transform: `translate(${queueMove.x * (1 - toStage)}px, ${titleY}px) scale(${titleScale})`,
            opacity: 1 - 0.08 * trailer,
          },
        ],
        [silhouetteRef.current, { opacity: isPoster ? 0 : 1 - toStage }],
        [presenceRef.current, { opacity: logoPresence }],
        [haloRef.current, { opacity: stageShadow.strength * toStage }],
        [dimRef.current, { opacity: m.dim.get(at) }],
        [frameRef.current, { opacity: opacity ? opacity.get(at) : 1 }],
      ];
    },
    [
      stage,
      slotScale,
      queueHeight,
      queueMove,
      big,
      natural,
      objectY,
      isPoster,
      stageShadow.strength,
      Boolean(trailerUrl),
      Boolean(logoUrl),
      Boolean(baked.queue),
      Boolean(baked.halo),
      form,
    ],
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isTrailerPlaying) {
      video.muted = isTrailerMuted;
      void video.play().catch(() => onTrailerEnded?.());
    } else {
      video.pause();
    }
  }, [isTrailerMuted, isTrailerPlaying, onTrailerEnded]);

  // The picture, at the stage's full size, inside the innermost clip.
  const picture = (
    <div
      ref={pictureRef}
      className="absolute left-0 top-0 origin-top-left bg-[#050607]"
      style={{ width: stage.width, height: stage.height }}
    >
      {/* A hairline round a miniature, a pixel wide on screen in its slot,
          drawn at the slot's size and stretched with the frame's crop. It
          lies under the artwork, as the frame's inset shadow did, so it shows
          only where there is no picture yet. */}
      <div
        ref={hairlineRef}
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 origin-top"
        style={{
          width: stage.width,
          height: queueHeight,
          borderRadius: 12 / slotScale,
          boxShadow: `inset 0 0 0 ${1 / slotScale}px rgba(205,211,219,0.38)`,
        }}
      />
      {artwork ? (
        <img
          ref={artworkRef}
          src={artwork.url}
          alt=""
          draggable={false}
          loading="eager"
          decoding="async"
          fetchPriority={isStage ? "high" : "auto"}
          className={`absolute origin-top-left select-none transition-opacity duration-500 ${
            natural ? "max-w-none" : "inset-0 h-full w-full object-cover"
          } ${isArtworkLoaded && isRevealed ? "opacity-100" : "opacity-0"} ${
            artwork.type === "primary" ? "blur-2xl" : ""
          }`}
          // A poster cut to a stage shorter than itself keeps its top, where
          // the faces are, and loses its foot, where the lettering is.
          style={
            natural
              ? coverFit(natural, stage, stage.height, objectY).rect
              : isPoster
                ? { objectPosition: "50% 0%" }
                : undefined
          }
          onLoad={(event) => {
            const image = event.currentTarget;
            setNatural({
              width: image.naturalWidth,
              height: image.naturalHeight,
            });
            setIsArtworkLoaded(true);
            onArtworkReady?.();
          }}
          onError={() => setFailed((current) => [...current, artwork.url])}
        />
      ) : null}

      {trailerUrl ? (
        <video
          ref={videoRef}
          src={trailerUrl}
          muted={isTrailerMuted}
          playsInline
          preload="auto"
          className="absolute inset-0 h-full w-full object-cover opacity-0"
          onEnded={onTrailerEnded}
          onError={onTrailerEnded}
        />
      ) : null}

      {/* On a tall stage the copy fills the lower third, over a poster's own
          lettering: the picture sinks into the room behind it there, eased
          so no line marks where the fall begins. A miniature shows its
          poster whole and gains the fall as it grows. */}
      {form === "tall" ? (
        <div
          ref={footRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 origin-top"
          style={{ background: footGradient }}
        />
      ) : null}

      <div
        ref={titleRef}
        className="absolute flex items-end"
        style={{
          left: titleBox.left,
          bottom: titleBox.bottom,
          width: titleBox.width,
          height: titleBox.height,
          transformOrigin: "0% 100%",
        }}
      >
        {logoUrl ? (
          <div
            className={`relative w-full transition-opacity duration-500 ${
              isLogoLoaded && isRevealed ? "opacity-100" : "opacity-0"
            }`}
          >
            <div
              className="relative"
              style={{
                width: baked.aspect
                  ? `min(100%, ${logoMaxHeight * baked.aspect}px)`
                  : "100%",
              }}
            >
              {baked.queue ? (
                <div
                  ref={silhouetteRef}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0"
                >
                  <img
                    src={baked.queue.url}
                    alt=""
                    draggable={false}
                    className="absolute"
                    style={{ ...baked.queue.style, opacity: shadow.strength }}
                  />
                </div>
              ) : null}
              <div ref={presenceRef} className="relative">
                {baked.base ? (
                  <img
                    src={baked.base.url}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                    className="pointer-events-none absolute"
                    style={baked.base.style}
                  />
                ) : null}
                {baked.halo ? (
                  <img
                    ref={haloRef}
                    src={baked.halo.url}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                    className="pointer-events-none absolute"
                    style={baked.halo.style}
                  />
                ) : null}
                <img
                  ref={logoRef}
                  src={logoUrl}
                  alt={isStage ? title : ""}
                  draggable={false}
                  onLoad={() => setIsLogoLoaded(true)}
                  className="relative block h-auto w-full select-none object-contain object-left-bottom"
                  style={{ maxHeight: logoMaxHeight }}
                />
              </div>
            </div>
          </div>
        ) : (
          <div ref={presenceRef}>
            <h2
              ref={letteringRef}
              className="text-cinematic-title font-black uppercase leading-[0.9] text-white"
              style={{
                fontSize:
                  form === "tall"
                    ? Math.min(stage.width * 0.1, 64)
                    : stage.height * 0.085,
              }}
            >
              {title}
            </h2>
          </div>
        )}
      </div>

      <div
        ref={dimRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[#050607]"
      />
    </div>
  );

  // The four clipping boxes, nested: their intersection is the frame.
  const framed = CORNERS.reduceRight<ReactNode>(
    (inside, corner) => (
      <div
        ref={(element) => {
          clipRefs.current[corner] = element;
        }}
        className="absolute left-0 top-0 origin-top-left overflow-hidden"
        style={{
          width: big,
          height: big,
          [CORNER_RADIUS[corner]]: CLIP_RADIUS,
        }}
      >
        {inside}
      </div>
    ),
    picture,
  );

  return (
    <div
      ref={frameRef}
      className="pointer-events-none absolute left-0 top-0"
      style={{ zIndex }}
      aria-hidden={isStage ? undefined : true}
    >
      {framed}
    </div>
  );
}
