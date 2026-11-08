import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database/databasePool";
import type { ImageFocus, ImageRecord } from "../catalogue/itemDto";

export interface StoredImage extends ImageRecord {
  contentType: string;
  storageKey: string;
  sizeBytes: number;
  isLocked: boolean;
}

export interface ImageRepository {
  listForItems(itemIds: string[]): Promise<ImageRecord[]>;
  /**
   * Artwork of the items' series and seasons, so an episode card can fall back
   * to series poster and backdrops without a second round trip.
   */
  listInheritedForItems(itemIds: string[]): Promise<Map<string, ImageRecord[]>>;
  getById(imageId: string): Promise<StoredImage | null>;
  /** The item an image belongs to, for the authorization check on delivery. */
  getOwningItemId(imageId: string): Promise<string | null>;
  findByItemAndType(
    itemId: string,
    imageType: string,
    imageIndex: number,
  ): Promise<StoredImage | null>;
  upsert(input: {
    itemId: string;
    imageType: string;
    imageIndex: number;
    contentHash: string;
    contentType: string;
    width: number | null;
    height: number | null;
    sizeBytes: number;
    storageKey: string;
    source: string;
    sourceUrl: string | null;
  }): Promise<string>;
  deleteForItem(itemId: string, imageType?: string): Promise<void>;
  /**
   * Stores an image an administrator chose and locks it.
   *
   * Separate from {@link upsert} because that one refuses to overwrite a locked
   * row — which is right for an automatic refresh and wrong for the operator
   * who owns the lock in the first place.
   */
  replaceLocked(input: {
    itemId: string;
    imageType: string;
    imageIndex: number;
    contentHash: string;
    contentType: string;
    width: number | null;
    height: number | null;
    sizeBytes: number;
    storageKey: string;
    source: string;
    sourceUrl: string | null;
  }): Promise<string>;
  /**
   * Drops an image whether or not it is locked, returning whether a row went.
   * This is how a type is handed back to the automatic pass.
   */
  clear(
    itemId: string,
    imageType: string,
    imageIndex: number,
  ): Promise<boolean>;
  listLockedTypes(itemId: string): Promise<string[]>;
  /**
   * Sets the point of an image that a crop keeps in view, or clears it with
   * null. Returns false when there is no such image.
   */
  setFocus(
    itemId: string,
    imageType: string,
    imageIndex: number,
    focus: ImageFocus | null,
  ): Promise<boolean>;
}

interface RawImageRow {
  id: string;
  item_id: string;
  image_type: string;
  image_index: number;
  content_hash: string;
  content_type: string;
  width: number | null;
  height: number | null;
  size_bytes: string;
  storage_key: string;
  is_locked: boolean;
  focus_x: number | null;
  focus_y: number | null;
}

function toRecord(row: RawImageRow): ImageRecord {
  return {
    id: row.id,
    itemId: row.item_id,
    imageType: row.image_type,
    imageIndex: row.image_index,
    contentHash: row.content_hash,
    width: row.width,
    height: row.height,
    focus:
      row.focus_x === null || row.focus_y === null
        ? null
        : { x: row.focus_x, y: row.focus_y },
  };
}

function toStored(row: RawImageRow): StoredImage {
  return {
    ...toRecord(row),
    contentType: row.content_type,
    storageKey: row.storage_key,
    sizeBytes: Number(row.size_bytes),
    isLocked: row.is_locked,
  };
}

// Table-qualified throughout: the inherited-artwork query joins `items`, which
// also has an `id`, and an unqualified list makes that reference ambiguous.
const IMAGE_COLUMNS = `
  item_images.id, item_images.item_id, item_images.image_type,
  item_images.image_index, item_images.content_hash, item_images.content_type,
  item_images.width, item_images.height, item_images.size_bytes,
  item_images.storage_key, item_images.is_locked,
  item_images.focus_x, item_images.focus_y
`;

/*
 * A focus belongs to one picture. When a write brings different bytes, the
 * old point would land on whatever happens to be there in the new image, so
 * it is cleared; the same bytes written again keep it.
 */
const KEEP_FOCUS_FOR_SAME_IMAGE = `
           focus_x = CASE WHEN item_images.content_hash = EXCLUDED.content_hash
                          THEN item_images.focus_x END,
           focus_y = CASE WHEN item_images.content_hash = EXCLUDED.content_hash
                          THEN item_images.focus_y END,`;

export function createImageRepository(pool: DatabasePool): ImageRepository {
  return {
    listForItems: async (itemIds) => {
      if (itemIds.length === 0) return [];
      const result = await pool.query<RawImageRow>(
        `SELECT ${IMAGE_COLUMNS} FROM item_images
         WHERE item_id = ANY($1)
         ORDER BY item_id, image_type, image_index`,
        [itemIds],
      );
      return result.rows.map(toRecord);
    },

    listInheritedForItems: async (itemIds) => {
      const inherited = new Map<string, ImageRecord[]>();
      if (itemIds.length === 0) return inherited;

      const result = await pool.query<RawImageRow & { for_item_id: string }>(
        `SELECT child.id AS for_item_id, ${IMAGE_COLUMNS}
         FROM items child
         JOIN item_images ON item_images.item_id IN (child.series_id, child.parent_id)
         WHERE child.id = ANY($1)
         ORDER BY child.id, item_images.image_type, item_images.image_index`,
        [itemIds],
      );

      for (const row of result.rows) {
        const existing = inherited.get(row.for_item_id);
        const record = toRecord(row);
        if (existing) existing.push(record);
        else inherited.set(row.for_item_id, [record]);
      }
      return inherited;
    },

    getById: async (imageId) => {
      const result = await pool.query<RawImageRow>(
        `SELECT ${IMAGE_COLUMNS} FROM item_images WHERE id = $1`,
        [imageId],
      );
      const row = result.rows[0];
      return row ? toStored(row) : null;
    },

    getOwningItemId: async (imageId) => {
      const result = await pool.query<{ item_id: string }>(
        `SELECT item_id FROM item_images WHERE id = $1`,
        [imageId],
      );
      return result.rows[0]?.item_id ?? null;
    },

    findByItemAndType: async (itemId, imageType, imageIndex) => {
      const result = await pool.query<RawImageRow>(
        `SELECT ${IMAGE_COLUMNS} FROM item_images
         WHERE item_id = $1 AND image_type = $2 AND image_index = $3`,
        [itemId, imageType, imageIndex],
      );
      const row = result.rows[0];
      return row ? toStored(row) : null;
    },

    upsert: async (input) => {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO item_images (
           id, item_id, image_type, image_index, content_hash, content_type,
           width, height, size_bytes, storage_key, source, source_url
         )
         VALUES ($12, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (item_id, image_type, image_index) DO UPDATE SET${KEEP_FOCUS_FOR_SAME_IMAGE}
           content_hash = EXCLUDED.content_hash,
           content_type = EXCLUDED.content_type,
           width = EXCLUDED.width,
           height = EXCLUDED.height,
           size_bytes = EXCLUDED.size_bytes,
           storage_key = EXCLUDED.storage_key,
           source = EXCLUDED.source,
           source_url = EXCLUDED.source_url
         -- A locked image was chosen deliberately by an administrator and must
         -- survive an automated refresh.
         WHERE item_images.is_locked = false
         RETURNING id`,
        [
          input.itemId,
          input.imageType,
          input.imageIndex,
          input.contentHash,
          input.contentType,
          input.width,
          input.height,
          input.sizeBytes,
          input.storageKey,
          input.source,
          input.sourceUrl,
          randomUUID(),
        ],
      );

      const inserted = result.rows[0]?.id;
      if (inserted) return inserted;

      // The upsert was suppressed by the lock; return the existing id.
      const existing = await pool.query<{ id: string }>(
        `SELECT id FROM item_images
         WHERE item_id = $1 AND image_type = $2 AND image_index = $3`,
        [input.itemId, input.imageType, input.imageIndex],
      );
      const row = existing.rows[0];
      if (!row) throw new Error("Image upsert returned no row.");
      return row.id;
    },

    replaceLocked: async (input) => {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO item_images (
           id, item_id, image_type, image_index, content_hash, content_type,
           width, height, size_bytes, storage_key, source, source_url, is_locked
         )
         VALUES ($12, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
         ON CONFLICT (item_id, image_type, image_index) DO UPDATE SET${KEEP_FOCUS_FOR_SAME_IMAGE}
           content_hash = EXCLUDED.content_hash,
           content_type = EXCLUDED.content_type,
           width = EXCLUDED.width,
           height = EXCLUDED.height,
           size_bytes = EXCLUDED.size_bytes,
           storage_key = EXCLUDED.storage_key,
           source = EXCLUDED.source,
           source_url = EXCLUDED.source_url,
           is_locked = true
         RETURNING id`,
        [
          input.itemId,
          input.imageType,
          input.imageIndex,
          input.contentHash,
          input.contentType,
          input.width,
          input.height,
          input.sizeBytes,
          input.storageKey,
          input.source,
          input.sourceUrl,
          randomUUID(),
        ],
      );

      const row = result.rows[0];
      if (!row) throw new Error("Locked image upsert returned no row.");
      return row.id;
    },

    clear: async (itemId, imageType, imageIndex) => {
      const result = await pool.query(
        `DELETE FROM item_images
         WHERE item_id = $1 AND image_type = $2 AND image_index = $3`,
        [itemId, imageType, imageIndex],
      );
      return (result.rowCount ?? 0) > 0;
    },

    listLockedTypes: async (itemId) => {
      const result = await pool.query<{ image_type: string }>(
        `SELECT DISTINCT image_type FROM item_images
         WHERE item_id = $1 AND is_locked = true
         ORDER BY image_type`,
        [itemId],
      );
      return result.rows.map((row) => row.image_type);
    },

    setFocus: async (itemId, imageType, imageIndex, focus) => {
      const result = await pool.query(
        `UPDATE item_images SET focus_x = $4, focus_y = $5
         WHERE item_id = $1 AND image_type = $2 AND image_index = $3`,
        [itemId, imageType, imageIndex, focus?.x ?? null, focus?.y ?? null],
      );
      return (result.rowCount ?? 0) > 0;
    },

    deleteForItem: async (itemId, imageType) => {
      if (imageType) {
        await pool.query(
          `DELETE FROM item_images WHERE item_id = $1 AND image_type = $2 AND is_locked = false`,
          [itemId, imageType],
        );
        return;
      }
      await pool.query(
        `DELETE FROM item_images WHERE item_id = $1 AND is_locked = false`,
        [itemId],
      );
    },
  };
}
