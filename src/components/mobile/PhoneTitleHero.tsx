import { useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Info, Play, RotateCcw } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Link, useNavigate } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";
import { useCroppedTransparentImage } from "../../hooks/useCroppedTransparentImage";
import {
  getItemDisplayMetadata,
  getItemLogoUrl,
} from "../../lib/itemMetadataPreferences";
import { getLogoImageUrl } from "../../lib/mediaApi";
import { getPlayTargetForItem } from "../../lib/playTarget";
import { getRouteForItem } from "../../lib/routes";
import type { MediaItem } from "../../lib/types";
import { getHeroImageCandidates } from "../hero/heroModel";
import { FavouriteButton } from "../FavouriteButton";
import { DownloadButton } from "../offline/DownloadButton";
import { isOfflineSupported } from "../../lib/offline/offlineLibrary";
import {
  HERO_FOCUS,
  HERO_PLAY,
  HERO_PRESS,
  PLAY_TIME_LEFT,
  heroPlayState,
} from "../home/HeroActions";
import { HERO_MOTION } from "../home/homeHeroModel";
import {
  stageLogoFilter,
  stageLogoReach,
  useLogoShadow,
} from "../home/logoShadowStyle";
import { useSmartContinueItems } from "../home/useSmartContinueItems";
import {
  PHONE_TITLE_HERO_ACTION,
  PHONE_TITLE_HERO_ACTION_SLOT,
  PHONE_TITLE_HERO_ACTIONS,
  PHONE_TITLE_HERO_COPY,
  PHONE_TITLE_HERO_FACTS,
  PHONE_TITLE_HERO_FRAME,
  PHONE_TITLE_HERO_LOGO_BOX,
  PHONE_TITLE_HERO_OVERVIEW,
  PHONE_TITLE_HERO_PICTURE,
  PHONE_TITLE_HERO_PLAY,
  PHONE_TITLE_HERO_ROW,
  PHONE_TITLE_HERO_SECTION,
  PHONE_TITLE_ACTION_ICON,
  PHONE_TITLE_LOGO_REGION,
  phoneTitleFacts,
} from "./phoneTitleHeroRows";
import { AnimatedText } from "../AnimatedText";
import { AnimatedWidth } from "../AnimatedWidth";

/** A floating artwork card: clean backdrop, then its reflected copy, with a fixed centre dock. */
export function PhoneTitleHero({
  item,
  onWatchedSlot,
  onShowDetails,
  isRevealed = true,
}: {
  item: MediaItem;
  /**
   * The action row's place for the watched button, which the page's details
   * render there, since they hold whether the title is watched.
   */
  onWatchedSlot?: (element: HTMLSpanElement | null) => void;
  onShowDetails?: () => void;
  /**
   * False while the page keeps the hero hidden behind its skeleton, so the
   * fades are not spent unseen.
   */
  isRevealed?: boolean;
}) {
  const { language, t } = useLanguage();
  const navigate = useNavigate();
  const reduceMotion = Boolean(useReducedMotion());
  const smartContinueItems = useSmartContinueItems();
  const [failed, setFailed] = useState<string[]>([]);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [isLogoLoaded, setIsLogoLoaded] = useState(false);

  const labels = {
    season: t("media.seasonNumber"),
    hourShort: t("format.hourShort"),
    minuteShort: t("format.minuteShort"),
  };
  const metadata = getItemDisplayMetadata(item, language);
  const title = metadata.title ?? item.Name;
  const overview = metadata.overview ?? item.Overview ?? null;
  const facts = phoneTitleFacts(item, labels);

  const artwork = getHeroImageCandidates(item).find(
    (candidate) => !failed.includes(candidate.url),
  );
  const isArtworkShown = Boolean(
    isRevealed && artwork && loadedUrl === artwork.url,
  );
  const fallbackLogoUrl = item.ImageTags?.Logo
    ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 1100)
    : "";
  const logoUrl = useCroppedTransparentImage(
    getItemLogoUrl(item, language, fallbackLogoUrl),
  );
  const logoShadow = useLogoShadow(
    logoUrl,
    artwork?.url,
    PHONE_TITLE_LOGO_REGION,
  );
  const logoReach = stageLogoReach(logoShadow);

  const { playItem, playLabel, shortPlayLabel, canStartOver, progress } =
    heroPlayState(item, smartContinueItems, t);
  const playTo =
    playItem.Type === "Series"
      ? getRouteForItem(playItem)
      : `/watch/${playItem.Id}`;
  const handlePlay = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    navigate(await getPlayTargetForItem(playItem));
  };

  const line = (index: number) => ({
    initial: { opacity: 0 },
    animate: {
      opacity: 1,
      transition: {
        duration: reduceMotion ? 0.2 : HERO_MOTION.copyEnterS,
        delay: reduceMotion ? 0 : index * HERO_MOTION.copyEnterStaggerS,
        ease: "easeOut" as const,
      },
    },
  });

  return (
    <>
      <section className={PHONE_TITLE_HERO_SECTION}>
        <div className={PHONE_TITLE_HERO_FRAME}>
          <div className={PHONE_TITLE_HERO_PICTURE}>
            <div className="absolute inset-0 bg-white/[0.04]">
              {artwork?.type === "backdrop" ? (
                <motion.img
                  key={artwork.url}
                  src={artwork.url}
                  alt=""
                  loading="eager"
                  decoding="async"
                  draggable={false}
                  className="absolute inset-0 h-full w-full select-none object-cover"
                  initial={false}
                  animate={{ opacity: isArtworkShown ? 1 : 0 }}
                  transition={{
                    duration: reduceMotion ? 0 : 0.45,
                    ease: "easeOut",
                  }}
                  onLoad={() => setLoadedUrl(artwork.url)}
                  onError={() =>
                    setFailed((current) => [...current, artwork.url])
                  }
                />
              ) : artwork ? (
                // A title without a backdrop: its poster, whole, on a wash of its
                // own colours rather than cropped to a strip of its middle.
                <motion.div
                  key={artwork.url}
                  aria-hidden="true"
                  className="absolute inset-0"
                  initial={false}
                  animate={{ opacity: isArtworkShown ? 1 : 0 }}
                  transition={{
                    duration: reduceMotion ? 0 : 0.45,
                    ease: "easeOut",
                  }}
                >
                  <img
                    src={artwork.url}
                    alt=""
                    className="absolute inset-0 h-full w-full scale-125 object-cover blur-2xl saturate-150"
                  />
                  <img
                    src={artwork.url}
                    alt=""
                    draggable={false}
                    className="absolute inset-0 h-full w-full select-none object-contain"
                    onLoad={() => setLoadedUrl(artwork.url)}
                    onError={() =>
                      setFailed((current) => [...current, artwork.url])
                    }
                  />
                </motion.div>
              ) : null}
            </div>
          </div>

          <motion.div
            className={PHONE_TITLE_HERO_COPY}
            initial="initial"
            animate={isRevealed ? "animate" : "initial"}
          >
            <div className="phone-title-reflection" aria-hidden="true">
              {artwork ? <img src={artwork.url} alt="" /> : null}
            </div>
            <motion.h1
              className={PHONE_TITLE_HERO_LOGO_BOX}
              initial={{ opacity: 0 }}
              animate={{ opacity: isRevealed ? 1 : 0 }}
              transition={{
                duration: reduceMotion ? 0.2 : HERO_MOTION.copyEnterS,
                ease: "easeOut",
              }}
            >
              {logoUrl ? (
                // The halo goes on a frame padded by its reach over the whole
                // logo box, never on the image: iOS WebKit can clip a filtered
                // element to its own box. Its content box is the logo box, so
                // max-h-full and max-w-full still measure against it. The fade
                // stays on the image: on the frame, WebKit drew the logo's
                // edges a fraction of a pixel differently once it had settled.
                <div
                  className="relative flex w-full items-end"
                  style={{
                    width: `calc(100% + ${logoReach * 2}px)`,
                    flexShrink: 0,
                    padding: logoReach,
                    margin: -logoReach,
                    filter: stageLogoFilter(logoShadow, 1),
                  }}
                >
                  <img
                    src={logoUrl}
                    alt={title}
                    draggable={false}
                    onLoad={() => setIsLogoLoaded(true)}
                    onError={() => setIsLogoLoaded(false)}
                    className={`block h-auto max-h-36 w-full select-none object-contain object-bottom transition-opacity duration-300 ${
                      isLogoLoaded ? "opacity-100" : "opacity-0"
                    }`}
                  />
                </div>
              ) : (
                <span className="text-cinematic-title line-clamp-2 text-center text-[1.375rem] font-black uppercase leading-[0.9] text-white [font-stretch:78%]">
                  {title}
                </span>
              )}
            </motion.h1>
            {facts ? (
              <motion.div variants={line(0)} className={PHONE_TITLE_HERO_FACTS}>
                <p className="text-[0.8125rem] font-bold leading-5 tracking-[0.04em] text-white/[0.72]">
                  {facts}
                </p>
              </motion.div>
            ) : null}
            {overview ? (
              <motion.p
                variants={line(1)}
                className={`${PHONE_TITLE_HERO_OVERVIEW} text-[0.9375rem] font-semibold leading-6 text-white/[0.9]`}
              >
                {overview}
              </motion.p>
            ) : null}
          </motion.div>
        </div>
      </section>
      {typeof document !== "undefined"
        ? createPortal(
            <AnimatePresence>
              {isRevealed ? (
                <motion.div
                  className={PHONE_TITLE_HERO_ACTIONS}
                  initial={{ opacity: 0 }}
                  animate={{
                    opacity: 1,
                    transition: {
                      duration: reduceMotion ? 0 : HERO_MOTION.copyEnterS,
                    },
                  }}
                  exit={{
                    opacity: 0,
                    transition: {
                      duration: reduceMotion ? 0 : HERO_MOTION.copyExitS,
                    },
                  }}
                >
                  <div className="hero-dock hero-dock-compact">
                    <span
                      className={`flex ${PHONE_TITLE_HERO_PLAY} ${HERO_PRESS}`}
                    >
                      <Link
                        to={playTo}
                        onClick={handlePlay}
                        aria-label={
                          progress
                            ? `${playLabel}, ${t("hero.timeLeft").replace("{time}", progress.left)}`
                            : playLabel
                        }
                        className={`hero-dock-play ${HERO_PLAY} ${HERO_FOCUS}`}
                      >
                        <Play
                          size={18}
                          fill="currentColor"
                          className="relative shrink-0"
                        />
                        {/* No truncating wrapper: its clip would cut the outgoing words. */}
                        <AnimatedWidth
                          value={progress ? shortPlayLabel : playLabel}
                        >
                          <AnimatedText
                            value={progress ? shortPlayLabel : playLabel}
                          />
                        </AnimatedWidth>
                        {progress ? (
                          <>
                            <span
                              className={`${PLAY_TIME_LEFT} relative shrink-0 text-xs text-zinc-500`}
                            >
                              <span aria-hidden="true">·&nbsp; </span>
                              <AnimatedWidth
                                value={t("hero.timeLeft").replace(
                                  "{time}",
                                  progress.left,
                                )}
                              >
                                <AnimatedText
                                  value={t("hero.timeLeft").replace(
                                    "{time}",
                                    progress.left,
                                  )}
                                />
                              </AnimatedWidth>
                            </span>
                            <span
                              aria-hidden="true"
                              className="hero-dock-watched"
                              style={{
                                width: `${Math.min(100, Math.max(0, progress.share * 100))}%`,
                              }}
                            />
                          </>
                        ) : null}
                      </Link>
                    </span>
                    {canStartOver ? (
                      <span className="hero-dock-restart">
                        <Link
                          to={`${playTo}${playTo.includes("?") ? "&" : "?"}start=0`}
                          aria-label={t("details.playFromBeginning")}
                          className={PHONE_TITLE_HERO_ACTION}
                        >
                          <RotateCcw
                            size={PHONE_TITLE_ACTION_ICON}
                            strokeWidth={2}
                          />
                          <AnimatedWidth value={t("details.restartWatching")}>
                            <AnimatedText
                              value={t("details.restartWatching")}
                            />
                          </AnimatedWidth>
                        </Link>
                      </span>
                    ) : null}
                    <div className={PHONE_TITLE_HERO_ROW}>
                      {onShowDetails ? (
                        <button
                          type="button"
                          onClick={onShowDetails}
                          className={PHONE_TITLE_HERO_ACTION}
                        >
                          <Info size={PHONE_TITLE_ACTION_ICON} />
                          <AnimatedWidth value={t("common.details")}>
                            <AnimatedText value={t("common.details")} />
                          </AnimatedWidth>
                        </button>
                      ) : null}
                      <span className={PHONE_TITLE_HERO_ACTION_SLOT}>
                        <FavouriteButton
                          item={item}
                          iconSize={PHONE_TITLE_ACTION_ICON}
                          showLabel
                          shortLabel={t("myList.title")}
                          className={PHONE_TITLE_HERO_ACTION}
                        />
                      </span>
                      {/* The page's details own whether the title is watched; they
                put their button here. */}
                      <span
                        ref={onWatchedSlot}
                        className={PHONE_TITLE_HERO_ACTION_SLOT}
                      />
                      {item.Type === "Movie" && isOfflineSupported() ? (
                        <span className="hero-dock-extra">
                          <DownloadButton
                            item={item}
                            iconSize={PHONE_TITLE_ACTION_ICON}
                            className={PHONE_TITLE_HERO_ACTION}
                          />
                        </span>
                      ) : null}
                    </div>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </>
  );
}
