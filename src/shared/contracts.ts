export type TaskLifecycle = 'active' | 'ready' | 'completed' | 'cancelled';
export type StageStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
export type AudioAssetStatus =
  | 'awaiting_upload'
  | 'uploaded'
  | 'confirmed'
  | 'rejected';

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
  requestId: string;
  taskId?: string;
}

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
  requestId: string;
}

export type ApiEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export interface CreateCaptureTaskInput {
  idempotencyKey: string;
  title: string;
  sceneId: string;
  audio: {
    contentType: string;
    sizeBytes?: number;
  };
}

export interface UploadGrant {
  assetId: string;
  objectKey: string;
  method: 'PUT';
  url: string;
  expiresAt: string;
  headers: {
    'content-type': string;
  };
}

export interface CaptureStageView {
  stage: string;
  status: StageStatus;
  retryable: boolean;
  retryCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface CaptureTaskView {
  id: string;
  deviceId: string;
  userId: string | null;
  title: string;
  sceneId: string;
  lifecycle: TaskLifecycle;
  currentStage: string;
  createdAt: string;
  updatedAt: string;
  stages: CaptureStageView[];
}

export interface TranscriptSegmentView {
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscriptView {
  id: string;
  taskId: string;
  sourceAssetId: string;
  text: string;
  language: string | null;
  durationMs: number | null;
  segments: TranscriptSegmentView[];
  provider: string;
  model: string;
  providerRequestId: string | null;
  providerMetadata: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface AudioRetentionView {
  assetId: string;
  retained: boolean;
  deleteAfter: string | null;
  deletedAt: string | null;
}

export interface SttRetryView {
  taskId: string;
  stage: 'transcribe';
  retryCount: number;
}
