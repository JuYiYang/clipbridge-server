CREATE TABLE IF NOT EXISTS clipboard_items (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  application TEXT,
  first_copied_at TEXT NOT NULL,
  last_copied_at TEXT NOT NULL,
  number_of_copies INTEGER NOT NULL DEFAULT 1,
  pin TEXT,
  contents_json TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  updated_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clipboard_items_updated_at
  ON clipboard_items (updated_at);

CREATE INDEX IF NOT EXISTS idx_clipboard_items_source_device_id
  ON clipboard_items (source_device_id);
