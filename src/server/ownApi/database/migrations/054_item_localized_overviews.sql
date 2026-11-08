-- A title's overview in each interface language, keyed by ISO 639-1, beside
-- the names `localized_titles` already keeps: {"tr": "Viserys, ...", "en": ...}.
--
-- Episodes are shown by these. An episode's `title` and `overview` are the
-- provider's English, and the language button switches an episode's name and
-- synopsis to the stored Turkish, falling back to them when TMDB has no
-- translation. An administrator's own wording wins in every language: a locked
-- title or overview is shown as written, whatever these hold.
--
-- Written by every series refresh and by the catalogue enrich back-fill.
-- '{}' means not yet read, and the episode then shows as before.

ALTER TABLE items ADD COLUMN IF NOT EXISTS localized_overviews jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE items DROP CONSTRAINT IF EXISTS items_localized_overviews_object;
ALTER TABLE items ADD CONSTRAINT items_localized_overviews_object
  CHECK (jsonb_typeof(localized_overviews) = 'object');
