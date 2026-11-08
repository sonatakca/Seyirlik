-- A title's name in each language TMDB knows it by, keyed by ISO 639-1:
-- {"tr": "Para Avcısı", "en": "The Wolf of Wall Street"}.
--
-- `title` is the one name a title is shown under, and an administrator may
-- replace it with a wording of their own. Search must still find the title
-- under every name someone might type, so the provider's names are kept here
-- beside it rather than being lost the moment `title` is edited.
--
-- Written by every metadata refresh and by the catalogue enrich back-fill on
-- movies and series. Never locked: these are search aids, not what is shown.
-- '{}' means not yet read, and search then behaves as before.

ALTER TABLE items ADD COLUMN IF NOT EXISTS localized_titles jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE items DROP CONSTRAINT IF EXISTS items_localized_titles_object;
ALTER TABLE items ADD CONSTRAINT items_localized_titles_object
  CHECK (jsonb_typeof(localized_titles) = 'object');
