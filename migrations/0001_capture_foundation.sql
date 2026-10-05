PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  credential_hash TEXT NOT NULL UNIQUE,
  user_id TEXT,
  display_name TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS capture_tasks (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
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
  FOREIGN KEY (device_id) REFERENCES devices(id),
  UNIQUE (device_id, create_idempotency_key)
);

CREATE TABLE IF NOT EXISTS capture_stages (
  task_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, stage),
  FOREIGN KEY (task_id) REFERENCES capture_tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audio_assets (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  expected_size_bytes INTEGER,
  actual_size_bytes INTEGER,
  etag TEXT,
  status TEXT NOT NULL DEFAULT 'awaiting_upload'
    CHECK (status IN ('awaiting_upload', 'uploaded', 'confirmed', 'rejected')),
  upload_expires_at TEXT NOT NULL,
  confirm_idempotency_key TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  FOREIGN KEY (task_id) REFERENCES capture_tasks(id) ON DELETE CASCADE,
  UNIQUE (task_id, confirm_idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_capture_tasks_device_created
  ON capture_tasks(device_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_capture_stages_status
  ON capture_stages(stage, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_audio_assets_task
  ON audio_assets(task_id, created_at DESC);
