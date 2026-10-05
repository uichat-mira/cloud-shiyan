PRAGMA foreign_keys = ON;

-- MOB-020: AI Draft / Final Draft persistence and custom scenes.
--
-- `drafts` is the shared content contract for the Shiyan MVP:
-- - kind 'ai'    : AI-organized drafts (organize + repeated user adjustments).
-- - kind 'final' : the user-edited Final Draft (single working state, v1).
--
-- AI adjustments only ever append new 'ai' versions; they never overwrite a
-- Final Draft or the read-only Transcript. The Final Draft row carries
-- title/markdown/confirmed_at so the MOB-022 delivery layer can consume a
-- confirmed snapshot without trusting client-submitted markdown.

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ai', 'final')),
  version INTEGER NOT NULL CHECK (version >= 1),
  source TEXT NOT NULL CHECK (source IN ('organize', 'adjust', 'user-edit')),
  base_version INTEGER,
  instruction TEXT,
  idempotency_key TEXT,
  title TEXT,
  markdown TEXT NOT NULL,
  structured_json TEXT,
  scene_id TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  provider_request_id TEXT,
  fallback_used INTEGER NOT NULL DEFAULT 0 CHECK (fallback_used IN (0, 1)),
  correlation_id TEXT NOT NULL,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES capture_tasks(id) ON DELETE CASCADE,
  UNIQUE (task_id, kind, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_drafts_task_idempotency
  ON drafts(task_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_drafts_task_kind_version
  ON drafts(task_id, kind, version DESC);

-- Custom scenes are limited to name + organize instruction + output
-- structure; complete system prompts stay server-side (PRD 4.2).

CREATE TABLE IF NOT EXISTS scenes (
  id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  user_id TEXT,
  name TEXT NOT NULL,
  instruction TEXT NOT NULL,
  sections_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (device_id, id),
  FOREIGN KEY (device_id) REFERENCES devices(id)
);

CREATE INDEX IF NOT EXISTS idx_scenes_device_created
  ON scenes(device_id, created_at ASC);
