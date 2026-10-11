import { useLanguage } from "../i18n/LanguageContext";
import { HomeHeroSkeleton, TitleHeroSkeleton } from "./home/HomeHeroSkeleton";
import type { MediaItem } from "../lib/types";
import { useIsPhoneView } from "../hooks/useIsPhoneView";
import { HeroBackButtonPlaceholder } from "./mobile/HeroBackButton";
import { PhoneTitleHeroSkeleton } from "./mobile/PhoneTitleHeroSkeleton";
import { PhoneHomeHeroSkeleton } from "./mobile/phoneHomeHeroFrame";
import { isOfflineSupported } from "../lib/offline/offlineLibrary";
import { AnimatedText } from "./AnimatedText";
import { AnimatedWidth } from "./AnimatedWidth";
import { LibraryBarcodePlaceholder } from "./LibraryHeaderArt";

export function BackButtonSkeleton({ className = "" }: { className?: string }) {
  const mask =
    "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)";

  return (
    <div className={`relative isolate h-12 w-[6rem] ${className}`}>
      <div
        aria-hidden="true"
        className="
          pointer-events-none
          absolute
          -inset-px
          z-0
          rounded-full
          bg-gradient-to-b
          from-white/20
          to-transparent
          p-px
        "
        style={{
          mask,
          maskComposite: "exclude",
          WebkitMask: mask,
          WebkitMaskComposite: "xor",
        }}
      />

      <div className="shimmer relative z-10 h-full w-full rounded-full" />
    </div>
  );
}

export function MediaCardSkeleton({
  variant = "poster",
  fluid = false,
}: {
  variant?: "poster" | "landscape";
  showEpisodeCount?: boolean;
  fluid?: boolean;
}) {
  const isLandscape = variant === "landscape";

  const widthClasses = fluid
    ? "w-full min-w-0"
    : isLandscape
      ? "w-72 shrink-0 sm:w-80 lg:w-96"
      : "w-44 shrink-0 sm:w-52 lg:w-60";

  return (
    <div className={widthClasses}>
      <div
        className={`relative overflow-hidden rounded-xl border border-white/10 bg-white/[0.055] ${
          isLandscape ? "aspect-video" : "aspect-[2/3]"
        }`}
      >
        <div className="shimmer absolute inset-0" />

        <div
          className={`shimmer !absolute left-1/2 z-[20] -translate-x-1/2 overflow-hidden rounded-lg ${
            isLandscape ? "bottom-12 h-10 w-1/2" : " h-28 bottom-3 w-11/12"
          }`}
        >
          <div className="shimmer absolute inset-0" />
        </div>
      </div>
    </div>
  );
}

/**
 * An episode card while its season loads: the card's own shell (width steps,
 * border, 16:9 still and the text panel with its padding and minimum height)
 * with a placeholder on each line the card will draw, so the row does not
 * change size or shape when the episodes arrive. Mirrors the episode layout
 * in `MediaCard`.
 */
export function EpisodeCardSkeleton() {
  return (
    <div className="h-full w-60 min-w-0 shrink-0 sm:w-80 lg:w-96">
      <div className="relative flex h-full w-full min-w-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-[var(--surface)] shadow-cinematic-card">
        <div className="shimmer aspect-video w-full shrink-0 [--shimmer-base:rgb(var(--shimmer-color)/1.5%)]" />
        <div className="relative flex min-h-[8.5rem] flex-col border-t border-white/16 bg-black/40 px-4 pb-4 pt-3 sm:min-h-[9.75rem] sm:px-5 sm:pb-5 sm:pt-4">
          {/* Episode number, title, two lines of story, then the runtime. */}
          <div className="mb-1 flex h-[0.99rem] items-center sm:h-4">
            <div className="shimmer h-2.5 w-16 rounded-md" />
          </div>
          <div className="flex h-5 items-center sm:h-6">
            <div className="shimmer h-3.5 w-3/5 rounded-md sm:h-4" />
          </div>
          <div className="mt-1.5 flex h-[1.8225rem] flex-col justify-around sm:h-[2.025rem]">
            <div className="shimmer h-2.5 w-full rounded-md" />
            <div className="shimmer h-2.5 w-4/5 rounded-md" />
          </div>
          <div className="mt-auto flex h-[1.4375rem] items-end justify-between gap-3 pt-2 sm:h-6">
            <div className="flex h-4 items-center">
              <div className="shimmer h-3 w-12 rounded-md" />
            </div>
            <div className="flex h-4 items-center">
              <div className="shimmer h-1.5 w-4 rounded-full" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ContinueWatchingCardSkeleton() {
  return (
    <div className="w-80 shrink-0 sm:w-[24rem] lg:w-[30rem]">
      <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-white/[0.055]">
        <div className=" absolute inset-0" />
        <div className="absolute inset-y-0 right-0 w-1/2 bg-black/20" />
        <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-gradient-to-t from-transparent via-white/30 to-transparent" />

        <div className="shimmer !absolute inset-y-0 right-1/2 left-0 flex flex-col p-3 sm:p-4"></div>
        <div className="absolute inset-y-0 left-1/2 right-0 flex flex-col p-3 sm:p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="shimmer h-4 w-20 mt-3 rounded-md" />

            <div className="flex items-center gap-4">
              <div className="shimmer size-8 rounded-full" />
              <div className="shimmer size-8 rounded-full" />
            </div>
          </div>

          <div className="shimmer mt-4 h-5 w-full rounded-md" />
          <div className="shimmer mt-1 h-3 w-full rounded-md" />

          <div className="mt-3 space-y-1">
            <div className="shimmer h-4 w-full rounded-md" />
            <div className="shimmer h-4 w-11/12 rounded-md" />
            <div className="shimmer h-4 w-11/12 rounded-md" />
            <div className="shimmer h-4 w-4/5 rounded-md" />
          </div>

          <div className="mt-auto flex items-center gap-2 pb-1">
            <div className="shimmer h-4 w-12 rounded-full" />
            <div className="shimmer h-4 w-14 rounded-full" />
          </div>
        </div>

        {/* Playback progress */}
        <div className="absolute inset-x-0 bottom-0 h-[0.2rem] bg-[#555556]">
          <div className="h-full w-2/5 rounded-r-full bg-white/30" />
        </div>
      </div>
    </div>
  );
}

function SkeletonRow({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="py-6">
      <div className="flex items-end justify-between gap-4">
        <h2 className="text-xl font-black text-white sm:text-2xl">
          <AnimatedWidth value={title}>
            <AnimatedText value={title} />
          </AnimatedWidth>
        </h2>
      </div>

      <div className="media-scroll flex snap-x gap-5 overflow-x-auto overflow-y-visible pb-8 pt-6">
        {children}
      </div>
    </section>
  );
}

export function MediaRowSkeleton({ title }: { title: string }) {
  return (
    <SkeletonRow title={title}>
      {Array.from({ length: 7 }, (_, index) => (
        <MediaCardSkeleton key={index} />
      ))}
    </SkeletonRow>
  );
}

export function ShowRowSkeleton({ title }: { title: string }) {
  return (
    <SkeletonRow title={title}>
      {Array.from({ length: 7 }, (_, index) => (
        <MediaCardSkeleton key={index} showEpisodeCount />
      ))}
    </SkeletonRow>
  );
}

export function BookRowSkeleton({ title }: { title: string }) {
  return (
    <SkeletonRow title={title}>
      {Array.from({ length: 7 }, (_, index) => (
        <MediaCardSkeleton key={index} />
      ))}
    </SkeletonRow>
  );
}

export function EpisodeRowSkeleton({ title }: { title: string }) {
  return (
    <SkeletonRow title={title}>
      {Array.from({ length: 6 }, (_, index) => (
        <EpisodeCardSkeleton key={index} />
      ))}
    </SkeletonRow>
  );
}

export function ContinueWatchingRowSkeleton({ title }: { title: string }) {
  return (
    <SkeletonRow title={title}>
      {Array.from({ length: 5 }, (_, index) => (
        <ContinueWatchingCardSkeleton key={index} />
      ))}
    </SkeletonRow>
  );
}

export function HomeSkeleton() {
  const { t } = useLanguage();

  return (
    <div className="layout-no-offset">
      <div className="full-bleed flow-root">
        {/* Placed from the hero's own geometry, so nothing moves when it
            arrives. */}
        <HomeHeroSkeleton />
      </div>

      <div className="mx-auto w-full  max-w-[1600px] px-4 sm:px-6 lg:px-8 2xl:mt-0">
        <ContinueWatchingRowSkeleton title={t("home.continueWatching")} />
        <MediaRowSkeleton title={t("home.latestAddedMovies")} />
        <ShowRowSkeleton title={t("home.latestAddedShows")} />
        <BookRowSkeleton title={t("home.latestAddedBooks")} />
      </div>
    </div>
  );
}

/**
 * The page while it has no data: the hero's own skeleton, built from the
 * hero's own frame, so nothing moves when the hero mounts over it, and the
 * rows' placeholders under it.
 */
export function MobileHomeSkeleton({ isPhone }: { isPhone: boolean }) {
  return (
    <div className="layout-no-offset min-h-screen pb-[calc(5.75rem+env(safe-area-inset-bottom))]">
      {isPhone ? (
        <PhoneHomeHeroSkeleton />
      ) : (
        <div className="full-bleed">
          <HomeHeroSkeleton fit="mobile" />
        </div>
      )}

      <div className="mx-auto w-full px-4 pt-5">
        <div className="mb-8">
          <div className="shimmer mb-4 h-5 w-40 rounded-full" />
          <div className="flex gap-4 overflow-hidden">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="w-56 shrink-0 sm:w-64">
                <div className="shimmer aspect-video w-full rounded-xl" />
                <div className="mt-3 space-y-2">
                  <div className="shimmer h-4 w-3/4 rounded-full" />
                  <div className="shimmer h-3 w-1/2 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mb-8">
          <div className="shimmer mb-4 h-5 w-32 rounded-full" />
          <div className="flex gap-4 overflow-hidden">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="w-32 shrink-0 sm:w-40">
                <div className="shimmer aspect-[2/3] w-full rounded-xl" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function DetailsSkeleton() {
  return (
    <article className="relative -mx-4 -mt-6 min-h-[calc(100vh-4rem)] overflow-hidden px-4 pb-16 pt-6 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
      <div className="absolute inset-0 bg-[linear-gradient(145deg,#18181b,#050506)]" />
      <div className="absolute inset-0 bg-gradient-to-r from-black via-black/[0.78] to-black/[0.28]" />
      <div className="absolute inset-0 bg-gradient-to-t from-[var(--background)] via-black/[0.34] to-black/40" />

      <div className="relative mx-auto max-w-[1500px]">
        <BackButtonSkeleton className="mb-10" />

        <div className="grid gap-8 md:grid-cols-[minmax(16rem,22rem)_1fr] md:items-end lg:gap-12">
          <div className="shimmer aspect-[2/3] overflow-hidden rounded-2xl border border-white/[0.12] bg-zinc-900 shadow-[0_30px_120px_rgba(0,0,0,0.64)]" />

          <div className="max-w-4xl">
            <div className="shimmer h-5 w-28 rounded-full" />
            <div className="shimmer mt-3 h-20 w-[min(42rem,92vw)] rounded-2xl sm:h-28 lg:h-32" />

            <div className="mt-5 flex flex-wrap gap-2">
              <div className="shimmer h-9 w-20 rounded-full" />
              <div className="shimmer h-9 w-20 rounded-full" />
              <div className="shimmer h-9 w-16 rounded-full" />
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <div className="shimmer h-8 w-20 rounded-full" />
              <div className="shimmer h-8 w-24 rounded-full" />
              <div className="shimmer h-8 w-28 rounded-full" />
            </div>

            <div className="mt-8">
              <div className="shimmer h-12 w-28 rounded-full" />
            </div>
          </div>
        </div>

        <div className="mt-12 grid gap-5 lg:grid-cols-[1.4fr_0.8fr]">
          <section className="rounded-2xl border border-white/10 bg-white/[0.055] p-5 backdrop-blur-xl sm:p-6">
            <div className="shimmer h-7 w-28 rounded-full" />
            <div className="mt-4 space-y-3">
              <div className="shimmer h-5 w-full rounded-full" />
              <div className="shimmer h-5 w-11/12 rounded-full" />
              <div className="shimmer h-5 w-4/5 rounded-full" />
            </div>
          </section>

          <section className="rounded-2xl border border-white/10 bg-white/[0.055] p-5 backdrop-blur-xl sm:p-6">
            <div className="shimmer h-7 w-36 rounded-full" />
            <div className="mt-4 grid gap-3">
              <div className="shimmer h-8 w-full rounded-lg" />
              <div className="shimmer h-8 w-full rounded-lg" />
              <div className="shimmer h-8 w-full rounded-lg" />
            </div>
          </section>
        </div>
      </div>
    </article>
  );
}

export function LibrarySkeleton() {
  return (
    <div>
      {/* The library page's header, piece for piece: the barcode's
          placeholder across it, the back button and the count at its foot. */}
      <div className="relative mb-4 grid min-h-20 grid-cols-[auto_1fr_auto] items-end gap-4">
        <LibraryBarcodePlaceholder />
        <div className="relative z-10 justify-self-start pb-1">
          <BackButtonSkeleton />
        </div>
        <div className="min-h-28" />
        <div className="relative z-10 justify-self-end pb-2">
          <div className="shimmer h-5 w-32 rounded-full" />
        </div>
      </div>

      <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="shimmer min-h-12 flex-1 rounded-full" />
        <div className="shimmer min-h-12 w-full rounded-full md:w-40" />
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-6">
        {Array.from({ length: 12 }, (_, index) => (
          <MediaCardSkeleton key={index} variant="poster" fluid />
        ))}
      </div>
    </div>
  );
}

function EpisodeShelfSkeleton({ mobile }: { mobile: boolean }) {
  return (
    <section className={mobile ? "py-3" : "py-5"}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="shimmer h-10 w-32 rounded-xl" />
        {!mobile && <div className="shimmer h-9 w-20 rounded-full" />}
      </div>
      <div className="flex gap-4 overflow-hidden pb-5">
        {Array.from({ length: 5 }, (_, index) =>
          mobile ? (
            <div
              key={index}
              className={`shrink-0 overflow-hidden rounded-xl border border-white/10 ${
                mobile ? "w-[78vw]" : "w-60 sm:w-80 lg:w-96"
              }`}
            >
              <div className="shimmer aspect-video w-full [--shimmer-base:rgb(var(--shimmer-color)/1.5%)]" />
              <div className="min-h-[8.5rem] space-y-2 p-4 sm:min-h-[9.75rem] sm:p-5">
                <div className="shimmer h-3 w-20 rounded-md" />
                <div className="shimmer h-5 w-3/5 rounded-md" />
                <div className="shimmer h-3 w-full rounded-md" />
                <div className="shimmer h-3 w-4/5 rounded-md" />
                <div className="shimmer mt-4 h-3 w-14 rounded-md" />
              </div>
            </div>
          ) : (
            <EpisodeCardSkeleton key={index} />
          ),
        )}
      </div>
    </section>
  );
}

function TrailerShelfSkeleton({ mobile }: { mobile: boolean }) {
  return (
    <section className={mobile ? "py-3" : "py-5"}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="shimmer h-7 w-28 rounded-lg" />
        {!mobile && <div className="shimmer h-9 w-20 rounded-full" />}
      </div>
      <div
        className={`shimmer aspect-video rounded-xl ${
          mobile ? "w-[78vw]" : "w-60 sm:w-80"
        }`}
      />
    </section>
  );
}

function CastSkeleton({ mobile }: { mobile: boolean }) {
  return (
    <section className={mobile ? "py-4" : "py-6"}>
      <div className="shimmer mb-5 h-7 w-44 rounded-lg" />
      <div className="flex gap-4 overflow-hidden pb-3 sm:gap-5">
        {Array.from({ length: 12 }, (_, index) => (
          <div
            key={index}
            className={mobile ? "w-24 shrink-0" : "w-28 shrink-0"}
          >
            <div
              className={`shimmer mx-auto rounded-full ${
                mobile ? "h-20 w-20" : "h-24 w-24"
              }`}
            />
            <div className="shimmer mx-auto mt-2 h-3 w-20 rounded-md" />
            <div className="shimmer mx-auto mt-1 h-3 w-16 rounded-md" />
          </div>
        ))}
      </div>
    </section>
  );
}

function AboutSkeleton({ mobile }: { mobile: boolean }) {
  return (
    <section className={mobile ? "pt-4" : "pt-6"}>
      <div className="shimmer mb-5 h-7 w-28 rounded-lg" />
      <div
        className={
          mobile ? "space-y-3" : "grid grid-cols-[minmax(0,1fr)_15rem] gap-4"
        }
      >
        <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-5 sm:p-6">
          <div className="shimmer h-5 w-32 rounded-md" />
          <div className="shimmer mt-3 h-3 w-64 max-w-full rounded-md" />
          <div className="mt-4 space-y-2">
            <div className="shimmer h-4 w-full rounded-md" />
            <div className="shimmer h-4 w-11/12 rounded-md" />
            <div className="shimmer h-4 w-4/5 rounded-md" />
          </div>
        </div>
        <div className="flex min-h-40 flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/[0.045] p-5">
          <div className="shimmer h-3 w-16 rounded-md" />
          <div className="shimmer mt-4 h-10 w-24 rounded-lg" />
          <div className="shimmer mt-4 h-3 w-20 rounded-md" />
        </div>
      </div>
    </section>
  );
}

function InformationSkeleton({ mobile }: { mobile: boolean }) {
  return (
    <section className={mobile ? "mt-6" : "mt-8"}>
      <div className="shimmer mb-4 h-7 w-28 rounded-lg" />
      <div
        className={
          mobile
            ? "grid grid-cols-2 gap-x-5 gap-y-4"
            : "grid max-w-3xl grid-cols-3 gap-x-8 gap-y-5"
        }
      >
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index}>
            <div className="shimmer h-3 w-20 rounded-md" />
            <div className="shimmer mt-2 h-4 w-28 rounded-md" />
          </div>
        ))}
      </div>
    </section>
  );
}

function MobileEpisodeCardSkeleton() {
  return (
    <div className="flex h-[14.6875rem] w-60 shrink-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-[#141416] min-[390px]:h-[15.234375rem] min-[390px]:w-64">
      <div className="shimmer aspect-video w-full shrink-0" />
      <div className="flex flex-1 flex-col justify-center px-3 py-2.5 min-[390px]:px-3.5 min-[390px]:py-3">
        <div className="shimmer h-7 w-24 rounded-md" />
        <div className="shimmer mt-1 h-4 w-32 rounded-md" />
        <div className="mt-1.5 flex gap-2">
          <div className="shimmer h-5 w-10 rounded border border-white/10" />
          <div className="shimmer h-5 w-14 rounded border border-white/10" />
        </div>
      </div>
    </div>
  );
}

function MobilePosterCardSkeleton() {
  return (
    <div className="shimmer h-[13.4375rem] w-[9rem] shrink-0 overflow-hidden rounded-lg border border-white/10 min-[390px]:h-[14.1875rem] min-[390px]:w-[9.5rem]" />
  );
}

function MobileEpisodeShelfSkeleton() {
  return (
    <section className="py-3">
      <div className="mb-3 flex h-9 items-center justify-between gap-3">
        <div className="shimmer h-9 w-[7.25rem] rounded-lg border border-white/10" />
      </div>
      <div className="flex gap-3 overflow-hidden pb-5 pt-1">
        {Array.from({ length: 3 }, (_, index) => (
          <MobileEpisodeCardSkeleton key={index} />
        ))}
      </div>
    </section>
  );
}

function MobileTrailerShelfSkeleton() {
  return (
    <section className="py-3">
      <div className="mb-3 flex items-center justify-between gap-3" />
      <div className="flex gap-3 overflow-hidden pb-5 pt-1">
        <div className="shimmer aspect-video w-[78vw] shrink-0 rounded-xl border border-white/10" />
      </div>
    </section>
  );
}

function MobileSimilarShelfSkeleton() {
  return (
    <section className="py-3">
      <div className="mb-3 flex items-center justify-between gap-3" />
      <div className="flex gap-3 overflow-hidden pb-5 pt-1">
        {Array.from({ length: 4 }, (_, index) => (
          <MobilePosterCardSkeleton key={index} />
        ))}
      </div>
    </section>
  );
}

function MobileCastSkeleton() {
  return (
    <section className="py-4">
      <div className="shimmer mb-4 h-7 w-44 rounded-lg" />
      <div className="flex gap-4 overflow-hidden pb-3">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="h-[9.6875rem] w-24 shrink-0 text-center">
            <div className="shimmer mx-auto h-20 w-20 rounded-full border border-white/10" />
            <div className="shimmer mx-auto mt-2 h-4 w-20 rounded-md" />
            <div className="shimmer mx-auto mt-1 h-8 w-16 rounded-md" />
          </div>
        ))}
      </div>
    </section>
  );
}

function MobileAboutInformationSkeleton({ kind }: { kind: "movie" | "show" }) {
  const isMovie = kind === "movie";

  return (
    <section className="pt-4">
      <div className="shimmer mb-4 h-7 w-28 rounded-lg" />
      <div className="space-y-3">
        <div
          className={`rounded-2xl border border-white/10 bg-white/[0.055] p-5 ${
            isMovie ? "h-[15.375rem]" : "h-[13.875rem]"
          }`}
        >
          <div className="shimmer h-5 w-32 rounded-md" />
          <div className="shimmer mt-2 h-3 w-48 rounded-md" />
          <div className="mt-3 space-y-2">
            <div className="shimmer h-4 w-full rounded-md" />
            <div className="shimmer h-4 w-full rounded-md" />
            <div className="shimmer h-4 w-11/12 rounded-md" />
            <div className="shimmer h-4 w-4/5 rounded-md" />
            {isMovie ? <div className="shimmer h-4 w-3/5 rounded-md" /> : null}
          </div>
        </div>

        <div className="flex h-40 flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/[0.055] p-5 text-center">
          <div className="shimmer h-3 w-16 rounded-md" />
          <div className="shimmer mt-3 h-10 w-24 rounded-lg" />
          <div className="shimmer mt-3 h-3 w-20 rounded-md" />
        </div>
      </div>

      <div className="mt-6">
        <div className="shimmer mb-3 h-7 w-28 rounded-lg" />
        <div className="grid grid-cols-2 gap-x-5 gap-y-4">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index}>
              <div className="shimmer h-3 w-20 rounded-md" />
              <div
                className={`shimmer mt-2 w-28 rounded-md ${
                  isMovie && index === 0 ? "h-[3.75rem]" : "h-5"
                }`}
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function MobileDetailsSkeleton({
  kind,
  item,
}: {
  kind: "movie" | "show";
  item?: MediaItem;
}) {
  // A phone or an upright tablet has the phone's title hero; a tablet on its
  // side gets the desktop's.
  const isPhone = useIsPhoneView();
  return (
    <div className="layout-no-offset min-w-0 pb-7">
      {/* A phone's back button is pinned over its hero, and its watched
          button sits in the hero's action row; the wider title hero's
          skeleton holds both itself, as the hero does. */}
      {isPhone ? <HeroBackButtonPlaceholder /> : null}
      <div className="full-bleed relative">
        {isPhone ? (
          <PhoneTitleHeroSkeleton kind={kind} item={item} />
        ) : (
          <TitleHeroSkeleton
            fit="mobile"
            kind={kind}
            item={item}
            canDownload={kind === "movie" && isOfflineSupported()}
          />
        )}
      </div>
      {kind === "show" ? (
        <MobileEpisodeShelfSkeleton />
      ) : (
        <MobileTrailerShelfSkeleton />
      )}
      <MobileCastSkeleton />
      <MobileAboutInformationSkeleton kind={kind} />
      <MobileSimilarShelfSkeleton />
    </div>
  );
}

function HeroLibrarySkeleton({
  kind,
  mobile = false,
  item,
}: {
  kind: "movie" | "show";
  mobile?: boolean;
  /** The title, when the page has it and waits only on its details. */
  item?: MediaItem;
}) {
  if (mobile) {
    return <MobileDetailsSkeleton kind={kind} item={item} />;
  }

  return (
    <div className="layout-no-offset min-w-0 pb-7">
      <div className="full-bleed relative flow-root">
        <TitleHeroSkeleton
          kind={kind}
          item={item}
          canDownload={kind === "movie" && isOfflineSupported()}
        />
      </div>
      <div
        className={`mx-auto w-full max-w-[1600px] ${
          mobile ? "px-4" : "px-4 sm:px-6 lg:px-8"
        }`}
      >
        {kind === "show" && <EpisodeShelfSkeleton mobile={mobile} />}
        <TrailerShelfSkeleton mobile={mobile} />
        <CastSkeleton mobile={mobile} />
        <AboutSkeleton mobile={mobile} />
        <InformationSkeleton mobile={mobile} />
      </div>
    </div>
  );
}

export function MovieLibrarySkeleton({
  mobile = false,
  item,
}: {
  mobile?: boolean;
  item?: MediaItem;
}) {
  return <HeroLibrarySkeleton kind="movie" mobile={mobile} item={item} />;
}

export function ShowLibrarySkeleton({
  mobile = false,
  item,
}: {
  mobile?: boolean;
  item?: MediaItem;
}) {
  return <HeroLibrarySkeleton kind="show" mobile={mobile} item={item} />;
}
