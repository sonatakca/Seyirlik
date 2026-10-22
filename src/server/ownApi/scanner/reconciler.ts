import type { ScanResult, ScannedItem, ScannedSubtitle } from "./libraryScan";

/**
 * Reconciliation turns a scan snapshot into durable catalogue state.
 *
 * Two invariants drive the design:
 *
 * 1. It is idempotent. Rescanning an unchanged library performs no writes that
 *    change observable state, so a scheduled scan is safe to run continuously.
 * 2. Disappearance is never immediately destructive. An unmounted volume makes
 *    every file "missing" at once; items are only deleted after they have been
 *    missing for a grace period, so a mount failure cannot erase watch history.
 */

export interface ExistingItemRow {
  id: string;
  sourceKey: string;
  kind: string;
  lockedFields: string[];
  missingSince: Date | null;
  /**
   * The item exists because somebody wants it, not because a file was found.
   *
   * Such an item is absent from every scan by definition, so without this it
   * would be marked missing on the first pass and deleted on the second —
   * taking the monitoring, the profile and the intent with it.
   */
  desired?: boolean;
}

export interface ExistingFileRow {
  id: string;
  itemId: string;
  relativePath: string;
  fingerprint: string;
  missingSince: Date | null;
}

export interface UpsertItemInput {
  libraryId: string;
  sourceKey: string;
  kind: string;
  title: string;
  sortTitle: string;
  year: number | undefined;
  indexNumber: number | undefined;
  parentIndexNumber: number | undefined;
  /** Field names the reconciler must not overwrite because an admin edited them. */
  lockedFields: string[];
  /** `title` is a stand-in; it names a new item but never replaces a title. */
  titleIsPlaceholder?: boolean;
}

export interface UpsertFileInput {
  itemId: string;
  relativePath: string;
  container: string;
  size: number;
  mtimeMs: number;
  fingerprint: string;
  isPrimary: boolean;
}

export interface CatalogueScanStore {
  listItems(libraryId: string): Promise<ExistingItemRow[]>;
  listFiles(libraryId: string): Promise<ExistingFileRow[]>;
  upsertItem(input: UpsertItemInput): Promise<string>;
  setItemRelations(
    itemId: string,
    relations: { parentId: string | null; seriesId: string | null },
  ): Promise<void>;
  /** Returns true when the file content changed and must be re-probed. */
  upsertFile(input: UpsertFileInput): Promise<{ id: string; changed: boolean }>;
  replaceExternalSubtitles(
    itemId: string,
    subtitles: ScannedSubtitle[],
  ): Promise<void>;
  markItemsSeen(itemIds: string[]): Promise<void>;
  markFilesSeen(fileIds: string[]): Promise<void>;
  markItemsMissing(itemIds: string[], missingSince: Date): Promise<void>;
  markFilesMissing(fileIds: string[], missingSince: Date): Promise<void>;
  deleteItems(itemIds: string[]): Promise<void>;
  deleteFiles(fileIds: string[]): Promise<void>;
  queueProbe(fileIds: string[]): Promise<void>;
  /**
   * Records that these files' titles are served from a complete package and
   * their source bytes are gone on purpose, so no probe will ever read them.
   */
  markPackaged(fileIds: string[]): Promise<void>;
  refreshItemCounts(libraryId: string): Promise<void>;
}

export interface ReconcileOptions {
  store: CatalogueScanStore;
  libraryId: string;
  scan: ScanResult;
  /** How long a vanished item is retained before deletion. */
  missingGraceMs?: number;
  /**
   * Fraction of the library that may disappear in one scan before the run is
   * treated as a mount failure and no removals are applied at all.
   */
  massDisappearanceRatio?: number;
  /**
   * Set by an administrator who really did delete most of a library, to run the
   * removal pass that the mass-disappearance guard would otherwise suppress.
   */
  allowMassRemoval?: boolean;
  /**
   * Whether a title missing for longer than the grace period is deleted.
   *
   * Off on a host whose library is a partial copy — the Google Drive mount
   * that stood in for the failed Expansion drive held a fraction of the
   * catalogue. There a missing title is one waiting to be uploaded again, so
   * the scan only hides it (and shows it again when its files come back), and
   * its watch history, metadata and identity survive however long that takes.
   */
  deleteMissing?: boolean;
  now?: () => Date;
}

export interface ReconcileSummary {
  itemsCreated: number;
  itemsUpdated: number;
  itemsMarkedMissing: number;
  itemsDeleted: number;
  filesCreated: number;
  filesChanged: number;
  filesMarkedMissing: number;
  filesDeleted: number;
  probesQueued: number;
  /** True when removals were suppressed because too much vanished at once. */
  removalsSuppressed: boolean;
}

const DEFAULT_MISSING_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MASS_DISAPPEARANCE_RATIO = 0.5;

function orderByDependency(items: ScannedItem[]): ScannedItem[] {
  // Parents must exist before children can reference them.
  const rank: Record<string, number> = {
    series: 0,
    season: 1,
    movie: 0,
    book: 0,
    episode: 2,
    trailer: 2,
    collection: 3,
  };
  return [...items].sort(
    (left, right) => (rank[left.kind] ?? 9) - (rank[right.kind] ?? 9),
  );
}

export async function reconcileLibraryScan({
  store,
  libraryId,
  scan,
  missingGraceMs = DEFAULT_MISSING_GRACE_MS,
  massDisappearanceRatio = DEFAULT_MASS_DISAPPEARANCE_RATIO,
  allowMassRemoval = false,
  deleteMissing = true,
  now = () => new Date(),
}: ReconcileOptions): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    itemsCreated: 0,
    itemsUpdated: 0,
    itemsMarkedMissing: 0,
    itemsDeleted: 0,
    filesCreated: 0,
    filesChanged: 0,
    filesMarkedMissing: 0,
    filesDeleted: 0,
    probesQueued: 0,
    removalsSuppressed: false,
  };

  const currentTime = now();
  const existingItems = await store.listItems(libraryId);
  const existingFiles = await store.listFiles(libraryId);
  const existingItemsByKey = new Map(
    existingItems.map((item) => [item.sourceKey, item]),
  );
  const existingFilesByPath = new Map(
    existingFiles.map((file) => [file.relativePath, file]),
  );
  const existingFilesByItem = new Map<string, ExistingFileRow[]>();
  for (const file of existingFiles) {
    const itemFiles = existingFilesByItem.get(file.itemId) ?? [];
    itemFiles.push(file);
    existingFilesByItem.set(file.itemId, itemFiles);
  }

  const itemIdBySourceKey = new Map<string, string>();
  const seenItemIds: string[] = [];
  const seenFileIds: string[] = [];
  const probeFileIds: string[] = [];

  for (const scanned of orderByDependency(scan.items)) {
    const existing = existingItemsByKey.get(scanned.sourceKey);
    const existingIdentityFiles = existing
      ? (existingFilesByItem.get(existing.id) ?? [])
      : [];
    // Version 1 title manifests intentionally do not contain enough original
    // source provenance to create a fresh media_files row. A complete package can
    // therefore preserve/revive an existing catalogue identity, but must not
    // create a visible item that has no playable file identity.
    if (
      scanned.renditionBacked &&
      (!existing || existingIdentityFiles.length === 0)
    ) {
      continue;
    }

    const itemId = await store.upsertItem({
      libraryId,
      sourceKey: scanned.sourceKey,
      kind: scanned.kind,
      title: scanned.title,
      sortTitle: scanned.sortTitle,
      year: scanned.year,
      indexNumber: scanned.indexNumber,
      parentIndexNumber: scanned.parentIndexNumber,
      lockedFields: existing?.lockedFields ?? [],
      ...(scanned.titleIsPlaceholder ? { titleIsPlaceholder: true } : {}),
    });

    itemIdBySourceKey.set(scanned.sourceKey, itemId);
    seenItemIds.push(itemId);
    if (existing) summary.itemsUpdated += 1;
    else summary.itemsCreated += 1;

    if (scanned.renditionBacked) {
      // Playback and adaptive-asset authorization resolve through the original
      // media file row. Keep that row active after the source bytes are removed;
      // the scanner has already proven the replacement package is complete.
      seenFileIds.push(...existingIdentityFiles.map((file) => file.id));
      // And say why the file is not there, or the prober finds nothing, marks
      // it failed, and availability drops a fully playable title.
      await store.markPackaged(existingIdentityFiles.map((file) => file.id));
    }

    for (const [index, file] of scanned.files.entries()) {
      const previous = existingFilesByPath.get(file.relativePath);
      const { id, changed } = await store.upsertFile({
        itemId,
        relativePath: file.relativePath,
        container: file.container,
        size: file.size,
        mtimeMs: file.mtimeMs,
        fingerprint: file.fingerprint,
        isPrimary: index === 0,
      });

      seenFileIds.push(id);
      // `changed` comes from the store rather than from a comparison against the
      // pre-scan snapshot, which the store is free to have mutated by now.
      if (!previous) summary.filesCreated += 1;
      else if (changed) summary.filesChanged += 1;

      // A new file, or one whose bytes changed, needs a fresh technical probe.
      if (changed) probeFileIds.push(id);
    }

    if (scanned.files.length > 0 || scanned.subtitles.length > 0) {
      await store.replaceExternalSubtitles(itemId, scanned.subtitles);
    }
  }

  for (const scanned of scan.items) {
    const itemId = itemIdBySourceKey.get(scanned.sourceKey);
    if (!itemId) continue;

    const parentId = scanned.parentSourceKey
      ? (itemIdBySourceKey.get(scanned.parentSourceKey) ?? null)
      : null;
    const seriesId = scanned.seriesSourceKey
      ? (itemIdBySourceKey.get(scanned.seriesSourceKey) ?? null)
      : null;

    await store.setItemRelations(itemId, { parentId, seriesId });
  }

  await store.markItemsSeen(seenItemIds);
  await store.markFilesSeen(seenFileIds);

  if (probeFileIds.length > 0) {
    await store.queueProbe(probeFileIds);
    summary.probesQueued = probeFileIds.length;
  }

  const seenItemIdSet = new Set(seenItemIds);
  const seenFileIdSet = new Set(seenFileIds);
  /*
   * A desired item is not missing; it was never expected on disk. It drops out
   * of the removal path entirely rather than being given a longer grace, because
   * no amount of grace makes "never had a file" eventually true — the item would
   * simply be deleted a week later instead of a minute later.
   */
  const vanishedItems = existingItems.filter(
    (item) => !seenItemIdSet.has(item.id) && item.desired !== true,
  );
  const vanishedFiles = existingFiles.filter(
    (file) => !seenFileIdSet.has(file.id),
  );

  // A scan that finds almost nothing is far more likely to be a storage failure
  // than a real deletion, so it must not propagate into the catalogue.
  //
  // Measured against the files that were present before this scan. Files that
  // were already missing did not disappear now, and counting them made a
  // library that is mostly absent — a partial copy on a cloud mount — look like
  // a mount failure on every scan, so nothing that vanished afterwards was ever
  // marked missing again.
  const presentBefore = existingFiles.filter(
    (file) => file.missingSince === null,
  );
  const newlyVanished = vanishedFiles.filter(
    (file) => file.missingSince === null,
  );
  const disappearanceRatio =
    presentBefore.length === 0
      ? 0
      : newlyVanished.length / presentBefore.length;
  if (!allowMassRemoval && disappearanceRatio > massDisappearanceRatio) {
    summary.removalsSuppressed = true;
    await store.refreshItemCounts(libraryId);
    return summary;
  }

  const graceCutoff = new Date(currentTime.getTime() - missingGraceMs);

  const filesToMark = vanishedFiles
    .filter((file) => file.missingSince === null)
    .map((file) => file.id);
  const filesToDelete = vanishedFiles
    .filter(
      (file) =>
        deleteMissing &&
        file.missingSince !== null &&
        file.missingSince <= graceCutoff,
    )
    .map((file) => file.id);
  const itemsToMark = vanishedItems
    .filter((item) => item.missingSince === null)
    .map((item) => item.id);
  const itemsToDelete = vanishedItems
    .filter(
      (item) =>
        deleteMissing &&
        item.missingSince !== null &&
        item.missingSince <= graceCutoff,
    )
    .map((item) => item.id);

  if (filesToMark.length > 0) {
    await store.markFilesMissing(filesToMark, currentTime);
    summary.filesMarkedMissing = filesToMark.length;
  }
  if (itemsToMark.length > 0) {
    await store.markItemsMissing(itemsToMark, currentTime);
    summary.itemsMarkedMissing = itemsToMark.length;
  }
  if (filesToDelete.length > 0) {
    await store.deleteFiles(filesToDelete);
    summary.filesDeleted = filesToDelete.length;
  }
  if (itemsToDelete.length > 0) {
    await store.deleteItems(itemsToDelete);
    summary.itemsDeleted = itemsToDelete.length;
  }

  await store.refreshItemCounts(libraryId);
  return summary;
}
