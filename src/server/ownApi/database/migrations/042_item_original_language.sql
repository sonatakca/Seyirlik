-- The language a film or series was made in, as TMDB records it (`en`, `ja`).
--
-- The encoder keeps a source's default audio track whatever its language,
-- because that is usually the original. Some releases flag a dub instead: the
-- Rick and Morty episodes in this library default to Brazilian Portuguese. With
-- the original language known, the audio policy keeps that track and leads with
-- it, and the dub is judged like any other language.
--
-- Set by every metadata refresh on movies and series; episodes read their
-- series'. NULL means not yet known, and the policy then behaves as before.

ALTER TABLE items ADD COLUMN IF NOT EXISTS original_language text;
