export type DestinationKind = 'github';
export type DeliveryStatus = 'pending' | 'succeeded' | 'failed';
export type DestinationFailureKind = 'retryable' | 'terminal';

export interface ConfirmedFinalDraftSnapshot {
  id: string;
  taskId: string;
  title: string;
  markdown: string;
  confirmedAt: string;
}

export interface DestinationDeliveryInput {
  taskId: string;
  finalDraftId: string;
  idempotencyKey: string;
  title: string;
  markdown: string;
  confirmedAt: string;
}

export interface DestinationSuccess {
  destination: DestinationKind;
  repository: string;
  path: string;
  commitSha: string;
  fileUrl: string;
  deliveredAt: string;
}

export interface DestinationFailure {
  kind: DestinationFailureKind;
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

export type DestinationResult =
  | { ok: true; value: DestinationSuccess }
  | { ok: false; error: DestinationFailure };

export interface DestinationAdapter {
  deliver(input: DestinationDeliveryInput): Promise<DestinationResult>;
}

export interface DeliveryRecordView {
  id: string;
  taskId: string;
  finalDraftId: string;
  destination: DestinationKind;
  idempotencyKey: string;
  status: DeliveryStatus;
  retryable: boolean;
  retryCount: number;
  repository: string | null;
  path: string | null;
  commitSha: string | null;
  fileUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}
