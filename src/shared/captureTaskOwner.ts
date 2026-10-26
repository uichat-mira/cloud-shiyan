export type CaptureTaskOwnerKind = 'legacy-device' | 'cloud-account';

export type CaptureTaskOwner =
  | {
      readonly kind: 'legacy-device';
      readonly legacyDeviceId: string;
    }
  | {
      readonly kind: 'cloud-account';
      readonly cloudAccountId: string;
      readonly cloudDeviceId: string;
    };

export type CaptureTaskOwnerColumns = {
  readonly owner_kind: CaptureTaskOwnerKind;
  readonly device_id: string | null;
  readonly cloud_account_id: string | null;
  readonly cloud_device_id: string | null;
};

export type CaptureTaskOwnerRowLike = {
  readonly owner_kind: string;
  readonly device_id: string | null;
  readonly cloud_account_id: string | null;
  readonly cloud_device_id: string | null;
};

export type CaptureTaskOwnerFailure =
  | 'owner_kind_invalid'
  | 'legacy_device_id_invalid'
  | 'cloud_account_id_invalid'
  | 'cloud_device_id_invalid'
  | 'owner_conflict'
  | 'idempotency_key_invalid';

export class CaptureTaskOwnerError extends Error {
  readonly code: CaptureTaskOwnerFailure;

  constructor(code: CaptureTaskOwnerFailure, message: string) {
    super(message);
    this.name = 'CaptureTaskOwnerError';
    this.code = code;
  }
}

export interface CaptureTaskOwnerQuery {
  readonly whereSql: string;
  readonly parameters: readonly string[];
}

export interface CaptureTaskOwnerStatement {
  bind(...values: string[]): CaptureTaskOwnerStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface CaptureTaskOwnerDatabase {
  prepare(query: string): CaptureTaskOwnerStatement;
}

const isNonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const fail = (code: CaptureTaskOwnerFailure, message: string): never => {
  throw new CaptureTaskOwnerError(code, message);
};

export const isCaptureTaskOwnerKind = (
  value: unknown,
): value is CaptureTaskOwnerKind =>
  value === 'legacy-device' || value === 'cloud-account';

export function assertCaptureTaskOwner(
  owner: CaptureTaskOwner,
): asserts owner is CaptureTaskOwner {
  if (owner.kind === 'legacy-device') {
    if (!isNonEmpty(owner.legacyDeviceId)) {
      fail('legacy_device_id_invalid', 'A legacy-device owner requires a device id');
    }
    return;
  }

  if (owner.kind === 'cloud-account') {
    if (!isNonEmpty(owner.cloudAccountId)) {
      fail('cloud_account_id_invalid', 'A cloud-account owner requires an account id');
    }
    if (!isNonEmpty(owner.cloudDeviceId)) {
      fail('cloud_device_id_invalid', 'A cloud-account owner requires a cloud device id');
    }
    return;
  }

  fail('owner_kind_invalid', 'CaptureTask owner kind is invalid');
}

export function captureTaskOwnerColumns(
  owner: CaptureTaskOwner,
): CaptureTaskOwnerColumns {
  assertCaptureTaskOwner(owner);

  if (owner.kind === 'legacy-device') {
    return {
      owner_kind: 'legacy-device',
      device_id: owner.legacyDeviceId,
      cloud_account_id: null,
      cloud_device_id: null,
    };
  }

  return {
    owner_kind: 'cloud-account',
    device_id: null,
    cloud_account_id: owner.cloudAccountId,
    cloud_device_id: owner.cloudDeviceId,
  };
}

export function captureTaskOwnerFromRow(row: CaptureTaskOwnerRowLike): CaptureTaskOwner {
  if (!isCaptureTaskOwnerKind(row.owner_kind)) {
    return fail('owner_kind_invalid', 'CaptureTask owner kind is invalid');
  }

  if (row.owner_kind === 'legacy-device') {
    if (
      !isNonEmpty(row.device_id) ||
      row.cloud_account_id !== null ||
      row.cloud_device_id !== null
    ) {
      return fail('owner_conflict', 'CaptureTask legacy-device owner columns conflict');
    }
    return { kind: 'legacy-device', legacyDeviceId: row.device_id };
  }

  if (
    row.device_id !== null ||
    !isNonEmpty(row.cloud_account_id) ||
    !isNonEmpty(row.cloud_device_id)
  ) {
    return fail('owner_conflict', 'CaptureTask cloud-account owner columns conflict');
  }
  return {
    kind: 'cloud-account',
    cloudAccountId: row.cloud_account_id,
    cloudDeviceId: row.cloud_device_id,
  };
}

export function captureTaskOwnerScope(owner: CaptureTaskOwner): CaptureTaskOwnerQuery {
  assertCaptureTaskOwner(owner);

  if (owner.kind === 'legacy-device') {
    return {
      whereSql: "owner_kind = 'legacy-device' AND device_id = ?",
      parameters: [owner.legacyDeviceId],
    };
  }

  return {
    whereSql: "owner_kind = 'cloud-account' AND cloud_account_id = ?",
    parameters: [owner.cloudAccountId],
  };
}

export function captureTaskCreateIdempotencyScope(
  owner: CaptureTaskOwner,
  createIdempotencyKey: string,
): CaptureTaskOwnerQuery {
  if (!isNonEmpty(createIdempotencyKey) || createIdempotencyKey.length > 128) {
    return fail('idempotency_key_invalid', 'CaptureTask create idempotency key is invalid');
  }

  const scope = captureTaskOwnerScope(owner);
  return {
    whereSql: `${scope.whereSql} AND create_idempotency_key = ?`,
    parameters: [...scope.parameters, createIdempotencyKey],
  };
}

export async function findCaptureTaskIdByCreateIdempotencyKey(
  db: CaptureTaskOwnerDatabase,
  owner: CaptureTaskOwner,
  createIdempotencyKey: string,
): Promise<string | null> {
  const scope = captureTaskCreateIdempotencyScope(owner, createIdempotencyKey);
  const row = await db
    .prepare(`SELECT id FROM capture_tasks WHERE ${scope.whereSql} LIMIT 1`)
    .bind(...scope.parameters)
    .first<{ id: string }>();
  return typeof row?.id === 'string' ? row.id : null;
}
