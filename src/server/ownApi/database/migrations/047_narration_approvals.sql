-- Lines a person listened to and found right as they are. An approval is of
-- one reading: it holds what was heard in it and for how long, and a line
-- read again (asked for, or for a new pronunciation) is heard otherwise and
-- is no longer approved, without anything having to take the row away.
CREATE TABLE book_narration_approvals (
  item_id uuid NOT NULL REFERENCES book_narrations(item_id) ON DELETE CASCADE,
  chunk text NOT NULL,
  heard text NOT NULL,
  duration integer NOT NULL,
  approved_by uuid REFERENCES native_users(id) ON DELETE SET NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, chunk),
  CONSTRAINT book_narration_approvals_chunk
    CHECK (chunk ~ '^[0-9]{1,6}-[0-9]{1,7}-[0-9]{1,5}$'),
  CONSTRAINT book_narration_approvals_heard CHECK (length(heard) <= 5000),
  CONSTRAINT book_narration_approvals_duration CHECK (duration >= 0)
);
