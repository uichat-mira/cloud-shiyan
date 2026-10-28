PRAGMA foreign_keys = ON;

-- SHY-012: Cloud custom scenes belong to the verified Mira Cloud Account.
-- Historical scenes(device_id, id) and its devices FK are intentionally
-- untouched: a Cloud Device must never be manufactured as a legacy device.
CREATE TABLE IF NOT EXISTS cloud_scenes (
  cloud_account_id TEXT NOT NULL CHECK (length(trim(cloud_account_id)) > 0),
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  name TEXT NOT NULL,
  instruction TEXT NOT NULL,
  sections_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (cloud_account_id, id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_scenes_account_created
  ON cloud_scenes(cloud_account_id, created_at ASC);
