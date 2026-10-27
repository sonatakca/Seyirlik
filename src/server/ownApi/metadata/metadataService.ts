import type { CollectionRepository } from "../collections/collectionRepository";
import type { ImageRepository } from "../images/imageRepository";
import type { ImageStorage } from "../images/imageStorage";
import { selectBestMatch, type MatchCandidate } from "./matcher";
import type { MetadataRepository, MetadataTarget } from "./metadataRepository";
import { PROVIDER_ARTWORK_SIZES } from "./providerArtworkSizes";
import {
  TmdbError,
  type TmdbClient,
  type TmdbTitleDetails,
} from "./tmdbClient";

export interface MetadataServiceOptions {
  metadata: MetadataRepository;
  images: ImageRepository;
  imageStorage: ImageStorage;
  tmdb: TmdbClient;
  /**
   * Confidence below which a match is recorded but not applied. Defaults to
   * applying medium and above, because a personal library's folder names are
   * usually deliberate.
   */
  minimumConfidence?: "high" | "medium";
  /**
   * Where a film's box set is recorded. Absent, films are matched exactly as
   * before and no collection is ever made.
   */
  collections?: CollectionRepository;
}

export interface IdentifyResult {
  itemId: string;
  status: "matched" | "ambiguous" | "not-found" | "skipped" | "failed";
  providerId?: string;
  confidence?: "high" | "medium" | "low";
}

const POSTER_SIZE = PROVIDER_ARTWORK_SIZES.poster;
const BACKDROP_SIZE = PROVIDER_ARTWORK_SIZES.backdrop;
const LOGO_SIZE = PROVIDER_ARTWORK_SIZES.logo;
const STILL_SIZE = PROVIDER_ARTWORK_SIZES.still;

/**
 * Identification and metadata application.
 *
 * Two rules shape everything here: a locked field is never overwritten, and a
 * low-confidence match is recorded rather than applied. Metadata that silently
 * renames the wrong film is worse than metadata that is missing.
 */
export function createMetadataService({
  metadata,
  images,
  imageStorage,
  tmdb,
  minimumConfidence = "medium",
  collections,
}: MetadataServiceOptions) {
  /**
   * Collections described recently, so a batch of six Harry Potter films asks
   * TMDB about the collection once rather than six times.
   */
  const describedCollections = new Map<string, number>();
  const COLLECTION_DESCRIBE_INTERVAL_MS = 12 * 60 * 60 * 1_000;
  async function storeArtwork(
    target: MetadataTarget,
    imageType: "cover" | "backdrop" | "logo" | "thumb",
    imagePath: string,
    size: string,
    imageIndex = 0,
  ): Promise<void> {
    const existing = await images.findByItemAndType(
      target.id,
      imageType,
      imageIndex,
    );
    if (existing?.isLocked) return;

    try {
      const sourceUrl = tmdb.buildImageUrl(imagePath, size);
      const stored =
        target.titleRoot && imageType !== "thumb"
          ? await imageStorage.fetchAndStoreTitleArtwork(
              sourceUrl,
              target.titleRoot,
              imageType,
            )
          : await imageStorage.fetchAndStore(sourceUrl);

      // Identical bytes mean nothing changed; skip the write so an ETag stays
      // stable and clients keep their cached copy.
      if (existing?.contentHash === stored.contentHash) return;

      await images.upsert({
        itemId: target.id,
        imageType,
        imageIndex,
        contentHash: stored.contentHash,
        contentType: stored.contentType,
        width: null,
        height: null,
        sizeBytes: stored.sizeBytes,
        storageKey: stored.storageKey,
        source: "tmdb",
        sourceUrl: null,
      });
    } catch {
      // Artwork is best-effort: a title with metadata and no poster is far more
      // useful than a failed refresh.
    }
  }

  async function applyTitle(
    target: MetadataTarget,
    details: TmdbTitleDetails,
  ): Promise<void> {
    await metadata.applyTitleMetadata(target.id, {
      title: details.title,
      ...(details.originalTitle
        ? { originalTitle: details.originalTitle }
        : {}),
      ...(details.originalLanguage
        ? { originalLanguage: details.originalLanguage }
        : {}),
      ...(details.overview ? { overview: details.overview } : {}),
      ...(details.tagline ? { tagline: details.tagline } : {}),
      ...(details.releaseDate ? { premiereDate: details.releaseDate } : {}),
      ...(details.endDate ? { endDate: details.endDate } : {}),
      ...(details.releaseDate
        ? { productionYear: Number(details.releaseDate.slice(0, 4)) }
        : {}),
      ...(details.officialRating
        ? { officialRating: details.officialRating }
        : {}),
      ...(details.communityRating === undefined
        ? {}
        : { communityRating: details.communityRating }),
      ...(details.runtimeMs === undefined
        ? {}
        : { runtimeMs: details.runtimeMs }),
      providerIds: {
        tmdb: details.providerId,
        ...(details.imdbId ? { imdb: details.imdbId } : {}),
      },
      metadataState: "matched",
    });

    await metadata.replaceGenres(target.id, details.genres);
    await metadata.replacePeople(target.id, details.people);

    if (details.posterPath) {
      await storeArtwork(target, "cover", details.posterPath, POSTER_SIZE);
    }
    if (details.logoPath) {
      await storeArtwork(target, "logo", details.logoPath, LOGO_SIZE);
    }
    for (const backdropPath of details.backdropPaths.slice(0, 1)) {
      await storeArtwork(target, "backdrop", backdropPath, BACKDROP_SIZE, 0);
    }
  }

  /**
   * Puts a film in the box set the provider says it belongs to, or takes it
   * out of one it no longer belongs to.
   *
   * Best-effort in the same way artwork is: a film whose collection could not
   * be recorded is still a matched film.
   */
  async function syncFilmCollection(
    target: MetadataTarget,
    details: TmdbTitleDetails,
  ): Promise<void> {
    if (!collections || target.kind !== "movie") return;
    try {
      if (!details.collection) {
        await collections.detach(target.id);
        return;
      }
      const collectionId = await collections.attach(
        target.id,
        details.collection,
      );

      const describedAt = describedCollections.get(
        details.collection.providerId,
      );
      if (
        !tmdb.getCollection ||
        (describedAt !== undefined &&
          Date.now() - describedAt < COLLECTION_DESCRIBE_INTERVAL_MS)
      ) {
        return;
      }
      const described = await tmdb.getCollection(details.collection.providerId);
      describedCollections.set(details.collection.providerId, Date.now());
      if (described.overview) {
        await metadata.applyTitleMetadata(collectionId, {
          overview: described.overview,
        });
      }
      // A collection owns no folder, so its artwork lives in generated storage.
      const collectionTarget = { id: collectionId } as MetadataTarget;
      if (described.posterPath) {
        await storeArtwork(
          collectionTarget,
          "cover",
          described.posterPath,
          POSTER_SIZE,
        );
      }
      if (described.backdropPath) {
        await storeArtwork(
          collectionTarget,
          "backdrop",
          described.backdropPath,
          BACKDROP_SIZE,
        );
      }
    } catch {
      // Recorded next time the film is refreshed.
    }
  }

  async function applySeriesChildren(
    target: MetadataTarget,
    providerId: string,
  ): Promise<void> {
    const episodes = await metadata.listEpisodesForSeries(target.id);
    const seasonNumbers = [
      ...new Set(
        episodes
          .map((episode) => episode.parentIndexNumber)
          .filter((season): season is number => season !== null),
      ),
    ];

    const described = new Set<string>();
    for (const seasonNumber of seasonNumbers) {
      let providerEpisodes;
      try {
        providerEpisodes = await tmdb.getSeasonEpisodes(
          providerId,
          seasonNumber,
        );
      } catch (error) {
        // A season the provider does not know about is not a failure of the
        // series refresh.
        if (error instanceof TmdbError && error.kind === "not-found") continue;
        throw error;
      }

      for (const providerEpisode of providerEpisodes) {
        const local = episodes.find(
          (episode) =>
            episode.parentIndexNumber === providerEpisode.seasonNumber &&
            episode.indexNumber === providerEpisode.episodeNumber,
        );
        if (!local) continue;
        described.add(local.id);

        await metadata.applyTitleMetadata(local.id, {
          ...(providerEpisode.title ? { title: providerEpisode.title } : {}),
          ...(providerEpisode.overview
            ? { overview: providerEpisode.overview }
            : {}),
          ...(providerEpisode.airDate
            ? { premiereDate: providerEpisode.airDate }
            : {}),
          ...(providerEpisode.communityRating === undefined
            ? {}
            : { communityRating: providerEpisode.communityRating }),
          metadataState: "matched",
        });

        if (providerEpisode.stillPath) {
          await storeArtwork(
            local,
            "thumb",
            providerEpisode.stillPath,
            STILL_SIZE,
          );
        }
      }
    }

    /*
     * An episode the provider does not list stays as the scan named it, and is
     * settled rather than left pending, or its series would be refreshed again
     * on every scan for an answer the provider does not have.
     */
    for (const episode of episodes) {
      if (episode.metadataState === "pending" && !described.has(episode.id)) {
        await metadata.applyTitleMetadata(episode.id, {
          metadataState: "unmatched",
        });
      }
    }
  }

  async function identify(target: MetadataTarget): Promise<IdentifyResult> {
    const isSeries = target.kind === "series";
    const existingProviderId = target.providerIds.tmdb;

    // A locked identity only forbids choosing a different match. A title an
    // administrator matched by hand is still described from that match, its
    // episodes included; the fields they edited carry locks of their own.
    const identityLocked = target.lockedFields.includes("identity");
    if (identityLocked && !existingProviderId) {
      // Move it out of the pending set as well, otherwise the batch scan would
      // keep selecting the same locked item and never terminate.
      await metadata.applyTitleMetadata(target.id, { metadataState: "locked" });
      return { itemId: target.id, status: "skipped" };
    }

    try {
      let providerId = existingProviderId;
      let confidence: IdentifyResult["confidence"];

      if (!providerId) {
        const candidates: MatchCandidate[] = isSeries
          ? await tmdb.searchSeries(
              target.title,
              target.productionYear ?? undefined,
            )
          : await tmdb.searchMovies(
              target.title,
              target.productionYear ?? undefined,
            );

        const match = selectBestMatch(
          {
            title: target.title,
            ...(target.productionYear === null
              ? {}
              : { year: target.productionYear }),
          },
          candidates,
        );

        if (!match) {
          await metadata.applyTitleMetadata(target.id, {
            metadataState: "unmatched",
          });
          return { itemId: target.id, status: "not-found" };
        }

        confidence = match.confidence;
        const meetsThreshold =
          match.confidence === "high" ||
          (minimumConfidence === "medium" && match.confidence === "medium");

        if (!meetsThreshold) {
          // Recorded so an administrator can confirm it, but nothing is written
          // over the scanned title.
          await metadata.applyTitleMetadata(target.id, {
            metadataState: "unmatched",
          });
          return {
            itemId: target.id,
            status: "ambiguous",
            providerId: match.candidate.providerId,
            confidence: match.confidence,
          };
        }

        providerId = match.candidate.providerId;
      }

      const details = isSeries
        ? await tmdb.getSeries(providerId)
        : await tmdb.getMovie(providerId);

      await applyTitle(target, details);
      if (isSeries) {
        await applySeriesChildren(target, providerId);
      } else {
        await syncFilmCollection(target, details);
      }

      return {
        itemId: target.id,
        status: "matched",
        providerId,
        ...(confidence ? { confidence } : {}),
      };
    } catch (error) {
      if (error instanceof TmdbError && error.kind === "not-found") {
        // A match chosen by hand stays the administrator's to undo.
        await metadata.applyTitleMetadata(target.id, {
          metadataState: identityLocked ? "locked" : "unmatched",
        });
        return { itemId: target.id, status: "not-found" };
      }
      // A rate limit or an outage must stay retryable, so the item is left
      // pending rather than marked failed.
      if (error instanceof TmdbError) throw error;

      await metadata.markFailed(target.id);
      return { itemId: target.id, status: "failed" };
    }
  }

  return {
    identify,

    /** Refreshes one item on demand, ignoring its current metadata state. */
    refreshItem: async (itemId: string): Promise<IdentifyResult> => {
      const target = await metadata.getTarget(itemId);
      if (!target) {
        return { itemId, status: "not-found" };
      }
      return identify(target);
    },

    /**
     * Records the facts a matched title was matched without: its age rating,
     * and a film's box set. Nothing else about it is re-applied — this is the
     * back-fill for a library matched before either was read, and it must not
     * redo artwork a person has chosen.
     */
    enrich: async (
      itemId: string,
    ): Promise<{ rated: boolean; inCollection: boolean } | null> => {
      const target = await metadata.getTarget(itemId);
      const providerId = target?.providerIds.tmdb;
      if (
        !target ||
        !providerId ||
        (target.kind !== "movie" && target.kind !== "series")
      ) {
        return null;
      }
      const details =
        target.kind === "series"
          ? await tmdb.getSeries(providerId)
          : await tmdb.getMovie(providerId);
      if (details.officialRating) {
        // Locked ratings are kept by the repository, as for every field.
        await metadata.applyTitleMetadata(target.id, {
          officialRating: details.officialRating,
        });
      }
      await syncFilmCollection(target, details);
      return {
        rated: Boolean(details.officialRating),
        inCollection: target.kind === "movie" && Boolean(details.collection),
      };
    },

    /** Processes a batch of never-identified items. */
    processPending: async (
      limit: number,
      libraryId?: string,
    ): Promise<IdentifyResult[]> => {
      const targets = await metadata.listPendingItems(limit, libraryId);
      const results: IdentifyResult[] = [];
      for (const target of targets) {
        results.push(await identify(target));
      }
      return results;
    },
  };
}

export type MetadataService = ReturnType<typeof createMetadataService>;
