PRAGMA foreign_keys = ON;

-- SHY-004: make CaptureTask ownership explicit while preserving every
-- historical legacy-device row unchanged.
--
-- Owner identity stays on capture_tasks instead of moving to a side table so
-- existing stage/asset/transcript/draft/delivery references keep pointing at
-- one stable task id. device_id must become nullable for Cloud-owned tasks,
-- which requires rebuilding the table.
--
-- D1 always enforces foreign keys and ignores connection-level attempts to
-- disable them, so dropping the old parent table would cascade-delete all
-- task children. The rebuild therefore parks child rows in unconstrained
-- backup tables first and restores them in dependency order after the new
-- table exists. The whole migration runs as one D1 batch and is atomic.

CREATE TABLE _capture_stages_0006_backup AS SELECT * FROM capture_stages;
CREATE TABLE _audio_assets_0006_backup AS SELECT * FROM audio_assets;
CREATE TABLE _transcripts_0006_backup AS SELECT * FROM transcripts;
CREATE TABLE _transcript_segments_0006_backup AS SELECT * FROM transcript_segments;
CREATE TABLE _delivery_records_0006_backup AS SELECT * FROM delivery_records;
CREATE TABLE _drafts_0006_backup AS SELECT * FROM drafts;

CREATE TABLE capture_tasks_v2 (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  device_id TEXT,
  cloud_account_id TEXT,
  cloud_device_id TEXT,
  user_id TEXT,
  title TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN ('active', 'ready', 'completed', 'cancelled')),
  current_stage TEXT NOT NULL DEFAULT 'upload',
  create_idempotency_key TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT capture_tasks_owner_kind_check
    CHECK (owner_kind IN ('legacy-device', 'cloud-account')),
  CONSTRAINT capture_tasks_owner_shape_check CHECK (
    (
      owner_kind = 'legacy-device'
      AND device_id IS NOT NULL
      AND length(trim(device_id)) > 0
      AND cloud_account_id IS NULL
      AND cloud_device_id IS NULL
    )
    OR (
      owner_kind = 'cloud-account'
      AND device_id IS NULL
      AND cloud_account_id IS NOT NULL
      AND length(trim(cloud_account_id)) > 0
      AND cloud_device_id IS NOT NULL
      AND length(trim(cloud_device_id)) > 0
    )
  ),
  FOREIGN KEY (device_id) REFERENCES devices(id),
  UNIQUE (device_id, create_idempotency_key)
);

INSERT INTO capture_tasks_v2
  (id, owner_kind, device_id, cloud_account_id, cloud_device_id, user_id, title,
   scene_id, lifecycle_status, current_stage, create_idempotency_key,
   correlation_id, created_at, updated_at)
SELECT
  id, 'legacy-device', device_id, NULL, NULL, user_id, title, scene_id,
  lifecycle_status, current_stage, create_idempotency_key, correlation_id,
  created_at, updated_at
FROM capture_tasks;

DROP TABLE capture_tasks;

ALTER TABLE capture_tasks_v2 RENAME TO capture_tasks;

INSERT INTO capture_stages SELECT * FROM _capture_stages_0006_backup;
INSERT INTO audio_assets SELECT * FROM _audio_assets_0006_backup;
INSERT INTO transcripts SELECT * FROM _transcripts_0006_backup;
INSERT INTO transcript_segments SELECT * FROM _transcript_segments_0006_backup;
INSERT INTO delivery_records SELECT * FROM _delivery_records_0006_backup;
INSERT INTO drafts SELECT * FROM _drafts_0006_backup;

DROP TABLE _capture_stages_0006_backup;
DROP TABLE _audio_assets_0006_backup;
DROP TABLE _transcripts_0006_backup;
DROP TABLE _transcript_segments_0006_backup;
DROP TABLE _delivery_records_0006_backup;
DROP TABLE _drafts_0006_backup;

CREATE INDEX idx_capture_tasks_device_created
  ON capture_tasks(device_id, created_at DESC);

CREATE UNIQUE INDEX idx_capture_tasks_cloud_account_idempotency
  ON capture_tasks(cloud_account_id, create_idempotency_key)
  WHERE owner_kind = 'cloud-account';

CREATE INDEX idx_capture_tasks_cloud_account_created
  ON capture_tasks(cloud_account_id, created_at DESC)
  WHERE owner_kind = 'cloud-account';
