-- The part of an image that has to stay in view when a frame of another shape
-- crops it: a point in the picture, as fractions of its width and height.
--
-- A 2.39:1 film still shown in a 16:9 hero, or a near-square phone hero,
-- loses its sides, and a centred cut can lose the very face the picture is
-- of. With a focus, the hero keeps that point as near its middle as the crop
-- allows.
--
-- On the image row rather than the item: a focus chosen for one picture means
-- nothing for another, so replacing the image clears it (the repository's
-- upserts do that whenever the content hash changes). Both null means the
-- picture's own centre, which is how every image was drawn before.
ALTER TABLE item_images ADD COLUMN IF NOT EXISTS focus_x real;
ALTER TABLE item_images ADD COLUMN IF NOT EXISTS focus_y real;

ALTER TABLE item_images
  ADD CONSTRAINT item_images_focus_complete
    CHECK ((focus_x IS NULL) = (focus_y IS NULL));

ALTER TABLE item_images
  ADD CONSTRAINT item_images_focus_in_range
    CHECK (
      focus_x IS NULL
      OR (focus_x BETWEEN 0 AND 1 AND focus_y BETWEEN 0 AND 1)
    );
