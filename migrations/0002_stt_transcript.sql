PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  source_asset_id TEXT NOT NULL,
  text TEXT NOT NULL,
  language TEXT,
  duration_ms INTEGER,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_request_id TEXT,
  provider_metadata_json TEXT,
  stt_artifact_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES capture_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (source_asset_id) REFERENCES audio_assets(id)
);

CREATE TABLE IF NOT EXISTS transcript_segments (
  transcript_id TEXT NOT NULL,
  segment_index INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (transcript_id, segment_index),
  FOREIGN KEY (transcript_id) REFERENCES transcripts(id) ON DELETE CASCADE
);

ALTER TABLE audio_assets ADD COLUMN retained INTEGER NOT NULL DEFAULT 0 CHECK (retained IN (0, 1));
ALTER TABLE audio_assets ADD COLUMN delete_after TEXT;
ALTER TABLE audio_assets ADD COLUMN deleted_at TEXT;

UPDATE audio_assets
SET delete_after = strftime('%Y-%m-%dT%H:%M:%fZ', confirmed_at, '+3 days')
WHERE confirmed_at IS NOT NULL AND delete_after IS NULL;

CREATE INDEX IF NOT EXISTS idx_audio_assets_cleanup
  ON audio_assets(retained, deleted_at, delete_after, status);

CREATE INDEX IF NOT EXISTS idx_transcripts_task
  ON transcripts(task_id);
