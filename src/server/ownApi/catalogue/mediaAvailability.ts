import { FILE_PLAYABLE } from "./fileEpisodes";

/** True when some present file plays the item `itemAlias` names. */
export function itemHeldSql(itemAlias: string): string {
  return `(EXISTS (SELECT 1 FROM media_files held_file WHERE held_file.item_id = ${itemAlias}.id
          AND ${FILE_PLAYABLE("held_file")}
          AND NOT EXISTS (SELECT 1 FROM media_file_episodes held_whole WHERE held_whole.media_file_id = held_file.id))
        OR EXISTS (SELECT 1 FROM media_file_episodes held_part
          JOIN media_files held_file ON held_file.id = held_part.media_file_id
          WHERE held_part.item_id = ${itemAlias}.id AND ${FILE_PLAYABLE("held_file")}))`;
}

/** The item itself and the items whose files hold it, for job lookups. */
function itemAndHostsSql(itemAlias: string): string {
  return `(SELECT ${itemAlias}.id UNION ALL SELECT host_file.item_id FROM media_file_episodes host_part
    JOIN media_files host_file ON host_file.id = host_part.media_file_id WHERE host_part.item_id = ${itemAlias}.id)`;
}

/** Catalogue truth shared by browse queries and the administrator's status list.
 * A wanted metadata row is not a playable item. Groups need an available child.
 *
 * Available means a file row the last scan found on disk: present, non-empty
 * and not rejected by the prober. A title whose source was replaced by its
 * package keeps its row in that state (probe_state `packaged`), because the
 * scanner only keeps it alive after proving the package complete. How a
 * processing job ended is deliberately not consulted: a succeeded job says
 * nothing about whether the files are still there — on a cloud mount they may
 * never have finished uploading — and a failed one says nothing about a
 * package that is sitting complete on disk.
 *
 * A file that holds several episodes (`media_file_episodes`) makes exactly
 * those available, and not the item it is filed under unless that is one of
 * them: a half-hour filed as S10E11 that plays 9x2 holds 9x2.
 *
 * Aliases here are code-owned SQL identifiers, never request input.
 */
export function mediaAvailableSql(alias = "item"): string {
  // One branch per way an item can be available, each on its own index: the
  // item itself, its episodes (series_id), its children (parent_id), and a
  // collection's members. Written as one EXISTS whose WHERE joined these with
  // OR, no index applied and every row checked scanned all of items — over
  // three seconds to list a few thousand titles for search.
  return `(${itemHeldSql(alias)}
    OR EXISTS (SELECT 1 FROM items available_item
      WHERE available_item.series_id = ${alias}.id AND ${itemHeldSql("available_item")})
    OR EXISTS (SELECT 1 FROM items available_item
      WHERE available_item.parent_id = ${alias}.id AND ${itemHeldSql("available_item")})
    OR EXISTS (SELECT 1 FROM collection_members member
      JOIN items available_item ON available_item.id = member.item_id
      WHERE member.collection_id = ${alias}.id AND ${itemHeldSql("available_item")}))`;
}

/** An episode held inside another item's file is processed under that item. */
export const MEDIA_STATUS_SQL = `CASE
  WHEN EXISTS (SELECT 1 FROM processing_jobs p WHERE p.item_id IN ${itemAndHostsSql("item")} AND p.state = 'succeeded' AND p.published_version IS NOT NULL) THEN 'ready'
  WHEN EXISTS (SELECT 1 FROM processing_jobs p WHERE p.item_id IN ${itemAndHostsSql("item")} AND p.state = 'paused') THEN 'paused'
  WHEN EXISTS (SELECT 1 FROM processing_jobs p WHERE p.item_id IN ${itemAndHostsSql("item")} AND p.state IN ('running', 'queued', 'pending')) THEN 'processing'
  WHEN ${mediaAvailableSql()} THEN 'downloaded'
  WHEN EXISTS (SELECT 1 FROM acquisitions a WHERE a.target_item_id = item.id AND a.state NOT IN ('downloaded', 'cancelled', 'superseded', 'failed')) THEN 'downloading'
  WHEN EXISTS (SELECT 1 FROM acquisitions a WHERE a.target_item_id = item.id AND a.state = 'downloaded') THEN 'awaiting-import'
  WHEN item.desired THEN 'wanted'
  ELSE 'missing' END`;
