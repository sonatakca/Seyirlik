import { useLanguage } from "../../i18n/LanguageContext";
import { getItemDisplayMetadata } from "../../lib/itemMetadataPreferences";
import type { MediaItem } from "../../lib/types";
import { canStartOverFromHero } from "../HeroSection";
import { isOfflineSupported } from "../../lib/offline/offlineLibrary";
import {
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
  phoneTitleFacts,
} from "./phoneTitleHeroRows";

/**
 * A phone's title page hero while it loads, from the hero's own rows
 * (`PhoneTitleHero`): the backdrop's frame with the logo's box at its foot,
 * the facts, the overview and the actions, each in the same classes, so each placeholder
 * lands where its piece will. Once the page has the title, the rows it lacks
 * are left out and the facts take their own, unseen, width.
 */
export function PhoneTitleHeroSkeleton({
  kind,
  item,
}: {
  kind: "movie" | "show";
  item?: MediaItem;
}) {
  const { language, t } = useLanguage();
  const facts = item
    ? phoneTitleFacts(item, {
        season: t("media.seasonNumber"),
        hourShort: t("format.hourShort"),
        minuteShort: t("format.minuteShort"),
      })
    : null;
  const overview = item
    ? (getItemDisplayMetadata(item, language).overview ?? item.Overview ?? null)
    : "";
  // Start over (a film knows its own place; a series' next episode is not
  // known yet), My List, watched, and download on a film where it can be.
  const canStartOver = item?.Type === "Movie" && canStartOverFromHero(item);
  const actions = 3 + Number(kind === "movie" && isOfflineSupported());

  return (
    <section className={PHONE_TITLE_HERO_SECTION}>
      <div className={PHONE_TITLE_HERO_FRAME}>
        <div className={PHONE_TITLE_HERO_PICTURE}>
          <div className="shimmer absolute inset-0" />
        </div>
        <div className={PHONE_TITLE_HERO_COPY}>
          <div className={PHONE_TITLE_HERO_LOGO_BOX}>
            <div className="shimmer h-20 w-full rounded-lg" />
          </div>
          {facts !== "" ? (
            <div className={PHONE_TITLE_HERO_FACTS}>
              <span className="shimmer max-w-full truncate rounded-md text-[0.8125rem] font-bold leading-4 tracking-[0.04em]">
                <span className="invisible">
                  {facts ?? "2014  ·  2sa 44dk  ·  Action, Adventure"}
                </span>
              </span>
            </div>
          ) : null}
          {overview !== null ? (
            <div
              className={`${PHONE_TITLE_HERO_OVERVIEW} relative min-h-[4.5rem]`}
            >
              {overview ? (
                <p className="invisible text-[0.9375rem] font-semibold leading-6">
                  {overview}
                </p>
              ) : null}
              <div className="absolute inset-0 flex flex-col justify-center gap-[0.625rem]">
                <div className="shimmer h-3.5 w-full rounded-md" />
                <div className="shimmer h-3.5 w-[94%] rounded-md" />
                <div className="shimmer h-3.5 w-3/5 rounded-md" />
              </div>
            </div>
          ) : null}
          <div
            className={`${PHONE_TITLE_HERO_ACTIONS} hero-dock hero-dock-compact`}
          >
            <div className={`shimmer rounded-full ${PHONE_TITLE_HERO_PLAY}`} />
            {canStartOver ? (
              <div className="shimmer hero-dock-action hero-dock-restart" />
            ) : null}
            <div className={PHONE_TITLE_HERO_ROW}>
              {Array.from({ length: actions }, (_, index) => (
                <span key={index} className={PHONE_TITLE_HERO_ACTION_SLOT}>
                  <span className="flex flex-col items-center gap-[9px] pt-0.5">
                    <span className="shimmer h-[23px] w-[23px] rounded-full" />
                    <span className="shimmer h-2.5 w-11 rounded-md" />
                  </span>
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
