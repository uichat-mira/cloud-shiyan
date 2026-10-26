import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CaptureTaskOwnerError,
  captureTaskCreateIdempotencyScope,
  captureTaskOwnerColumns,
  captureTaskOwnerFromRow,
  captureTaskOwnerScope,
  findCaptureTaskIdByCreateIdempotencyKey,
  type CaptureTaskOwner,
  type CaptureTaskOwnerDatabase,
  type CaptureTaskOwnerFailure,
  type CaptureTaskOwnerRowLike,
} from '../src/shared/captureTaskOwner';

const legacyOwner: CaptureTaskOwner = {
  kind: 'legacy-device',
  legacyDeviceId: 'legacy-device-a',
};

const cloudOwner = (accountId: string, deviceId: string): CaptureTaskOwner => ({
  kind: 'cloud-account',
  cloudAccountId: accountId,
  cloudDeviceId: deviceId,
});

const expectOwnerFailure = (
  action: () => unknown,
  code: CaptureTaskOwnerFailure,
): void => {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof CaptureTaskOwnerError);
    assert.equal(error.code, code);
    return true;
  });
};

const row = (overrides: Partial<CaptureTaskOwnerRowLike>): CaptureTaskOwnerRowLike => ({
  owner_kind: 'legacy-device',
  device_id: 'legacy-device-a',
  cloud_account_id: null,
  cloud_device_id: null,
  ...overrides,
});

test('owner kinds map to exactly one persisted identity column', () => {
  assert.deepEqual(captureTaskOwnerColumns(legacyOwner), {
    owner_kind: 'legacy-device',
    device_id: 'legacy-device-a',
    cloud_account_id: null,
    cloud_device_id: null,
  });

  assert.deepEqual(captureTaskOwnerColumns(cloudOwner('account-a', 'mira-device-1')), {
    owner_kind: 'cloud-account',
    device_id: null,
    cloud_account_id: 'account-a',
    cloud_device_id: 'mira-device-1',
  });
});

test('owner identities reject empty, whitespace-only and unknown values', () => {
  expectOwnerFailure(
    () => captureTaskOwnerColumns({ kind: 'legacy-device', legacyDeviceId: ' ' }),
    'legacy_device_id_invalid',
  );
  expectOwnerFailure(
    () => captureTaskOwnerColumns(cloudOwner('', 'mira-device-1')),
    'cloud_account_id_invalid',
  );
  expectOwnerFailure(
    () => captureTaskOwnerColumns(cloudOwner('account-a', '\t')),
    'cloud_device_id_invalid',
  );
  expectOwnerFailure(
    () =>
      captureTaskOwnerColumns({
        kind: 'unknown',
      } as unknown as CaptureTaskOwner),
    'owner_kind_invalid',
  );
});

test('owner row parsing round-trips and rejects ambiguous owner states', () => {
  assert.deepEqual(captureTaskOwnerFromRow(row({})), legacyOwner);
  assert.deepEqual(
    captureTaskOwnerFromRow(
      row({
        owner_kind: 'cloud-account',
        device_id: null,
        cloud_account_id: 'account-a',
        cloud_device_id: 'mira-device-1',
      }),
    ),
    cloudOwner('account-a', 'mira-device-1'),
  );

  expectOwnerFailure(
    () => captureTaskOwnerFromRow(row({ cloud_account_id: 'account-a' })),
    'owner_conflict',
  );
  expectOwnerFailure(
    () => captureTaskOwnerFromRow(row({ cloud_device_id: 'mira-device-1' })),
    'owner_conflict',
  );
  expectOwnerFailure(
    () =>
      captureTaskOwnerFromRow(
        row({
          owner_kind: 'cloud-account',
          device_id: 'legacy-device-a',
          cloud_account_id: 'account-a',
          cloud_device_id: 'mira-device-1',
        }),
      ),
    'owner_conflict',
  );
  expectOwnerFailure(
    () =>
      captureTaskOwnerFromRow(
        row({
          owner_kind: 'cloud-account',
          device_id: null,
          cloud_account_id: null,
          cloud_device_id: 'mira-device-1',
        }),
      ),
    'owner_conflict',
  );
  expectOwnerFailure(
    () => captureTaskOwnerFromRow(row({ owner_kind: 'shared-device' })),
    'owner_kind_invalid',
  );
});

test('cloud idempotency namespace is account-scoped, not cloud-device-scoped', () => {
  const firstDevice = captureTaskOwnerScope(cloudOwner('account-a', 'mira-device-1'));
  const secondDevice = captureTaskOwnerScope(cloudOwner('account-a', 'mira-device-2'));
  const otherAccount = captureTaskOwnerScope(cloudOwner('account-b', 'mira-device-1'));

  assert.deepEqual(firstDevice, secondDevice);
  assert.deepEqual(firstDevice, {
    whereSql: "owner_kind = 'cloud-account' AND cloud_account_id = ?",
    parameters: ['account-a'],
  });
  assert.notDeepEqual(firstDevice, otherAccount);

  assert.deepEqual(captureTaskOwnerScope(legacyOwner), {
    whereSql: "owner_kind = 'legacy-device' AND device_id = ?",
    parameters: ['legacy-device-a'],
  });
});

test('create idempotency scope binds owner identity and key as parameters', () => {
  assert.deepEqual(
    captureTaskCreateIdempotencyScope(cloudOwner('account-a', 'mira-device-1'), "key' OR 1=1"),
    {
      whereSql:
        "owner_kind = 'cloud-account' AND cloud_account_id = ? AND create_idempotency_key = ?",
      parameters: ['account-a', "key' OR 1=1"],
    },
  );

  expectOwnerFailure(
    () => captureTaskCreateIdempotencyScope(legacyOwner, ' '),
    'idempotency_key_invalid',
  );
  expectOwnerFailure(
    () => captureTaskCreateIdempotencyScope(legacyOwner, 'x'.repeat(129)),
    'idempotency_key_invalid',
  );
});

test('D1 idempotency lookup uses the owner scope and returns a task id', async () => {
  const calls: Array<{ query: string; values: string[] }> = [];
  const db: CaptureTaskOwnerDatabase = {
    prepare(query) {
      const statement = {
        bind(...values: string[]) {
          calls.push({ query, values });
          return statement;
        },
        async first<T = Record<string, unknown>>() {
          return { id: 'task-a' } as T;
        },
      };
      return statement;
    },
  };

  assert.equal(
    await findCaptureTaskIdByCreateIdempotencyKey(
      db,
      cloudOwner('account-a', 'mira-device-2'),
      'create-key',
    ),
    'task-a',
  );
  assert.deepEqual(calls, [
    {
      query:
        "SELECT id FROM capture_tasks WHERE owner_kind = 'cloud-account' AND cloud_account_id = ? AND create_idempotency_key = ? LIMIT 1",
      values: ['account-a', 'create-key'],
    },
  ]);
});
