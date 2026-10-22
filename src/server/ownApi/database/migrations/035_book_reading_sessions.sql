-- Which open copy of a book keeps the reader's place in it. A book open on
-- two devices at once used to have two writers, and the later write won by
-- the clock it carried: a window left open could save an old place over a
-- newer one read elsewhere. Now the copy opened last owns the place, and a
-- save from any other copy is refused, so that copy can say why and offer
-- to take the book back.
--
-- "Opened last" goes by when each copy was opened, not by when the server
-- heard of it: a phone that opened the book offline and read for an hour
-- still owns the place when it comes back, against a desktop opened earlier.

CREATE TABLE user_book_sessions (
  user_id uuid NOT NULL REFERENCES native_users(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  -- One per opening of the book in a page; made up by the client.
  session_id uuid NOT NULL,
  -- When that copy was opened, by its device's clock and never later than
  -- the server's.
  opened_at timestamptz NOT NULL,
  -- What kind of device it is, to say where the book went. NULL: unknown.
  device text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id),
  CONSTRAINT user_book_sessions_device
    CHECK (
      device IS NULL
      OR device IN ('iphone', 'ipad', 'android', 'mac', 'windows', 'linux')
    )
);

CREATE INDEX user_book_sessions_item_idx ON user_book_sessions (item_id);

-- The copy that wrote the place. Its own saves are ordered by its own clock;
-- a save from the copy that has since taken the book wins whatever the two
-- clocks say. NULL: written before copies were told apart.
ALTER TABLE user_book_positions ADD COLUMN session_id uuid;
