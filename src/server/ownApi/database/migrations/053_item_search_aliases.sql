-- Names an administrator adds so search finds a title by them too, such as a
-- release title the provider does not list: "Salazar's Revenge" for the film
-- TMDB knows only as "Dead Men Tell No Tales".
--
-- Kept apart from localized_titles because that column belongs to the
-- provider and every metadata refresh rewrites it; these belong to the
-- administrator and nothing but the editor writes them. Search aids only,
-- never shown as the title. '{}' means none.

ALTER TABLE items ADD COLUMN IF NOT EXISTS search_aliases text[] NOT NULL DEFAULT '{}'::text[];
