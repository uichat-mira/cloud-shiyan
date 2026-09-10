PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS delivery_records (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  final_draft_id TEXT NOT NULL,
  destination TEXT NOT NULL CHECK (destination IN ('github')),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  retryable INTEGER NOT NULL DEFAULT 1 CHECK (retryable IN (0, 1)),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  content_sha256 TEXT NOT NULL,
  repository TEXT,
  path TEXT,
  commit_sha TEXT,
  file_url TEXT,
  error_code TEXT,
  error_message TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES capture_tasks(id) ON DELETE CASCADE,
  UNIQUE (task_id, destination, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_delivery_records_task_created
  ON delivery_records(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_records_status_retryable
  ON delivery_records(status, retryable, updated_at);
