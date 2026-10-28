import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveOwnedScene } from '../src/shared/sceneOwner';
import type { CaptureTaskOwnerDatabase } from '../src/shared/captureTaskOwner';

const validSections = [{ id: 'notes', title: 'Notes', description: 'Important notes' }];
const a = { kind: 'cloud-account', cloudAccountId: 'account-a', cloudDeviceId: 'device-a1' } as const;
const b = { kind: 'cloud-account', cloudAccountId: 'account-b', cloudDeviceId: 'device-b1' } as const;
const legacy = { kind: 'legacy-device', legacyDeviceId: 'legacy-1' } as const;
type SceneRow = { id: string; name: string; instruction: string; sections_json: string };

function fakeDb(rows: Map<string, SceneRow>, queries: string[]): CaptureTaskOwnerDatabase {
  return {
    prepare(sql) {
      queries.push(sql);
      return {
        bind(...args: string[]) {
          const [ownerId, sceneId] = args;
          return {
            async first<T>() {
              const table = sql.includes('FROM cloud_scenes') ? 'cloud' : 'legacy';
              return (rows.get(`${table}/${ownerId}/${sceneId}`) ?? null) as T | null;
            },
            bind: (..._args: string[]) => { throw Error('Unexpected repeated bind'); },
          };
        },
        async first<T>() { return null as T | null; },
      };
    },
  } as unknown as CaptureTaskOwnerDatabase;
}

test('built-ins win before stored custom scenes for both owner kinds', async () => {
  const queries: string[] = [];
  const db = fakeDb(new Map(), queries);
  assert.equal((await resolveOwnedScene(db, a, 'meeting'))?.id, 'meeting');
  assert.equal((await resolveOwnedScene(db, legacy, 'meeting'))?.id, 'meeting');
  assert.deepEqual(queries, []);
});

test('Cloud scene selection uses account, never Cloud Device or a legacy identity', async () => {
  const queries: string[] = [];
  const rows = new Map<string, SceneRow>([
    ['cloud/account-a/custom', { id: 'custom', name: 'A', instruction: 'Owned A', sections_json: JSON.stringify(validSections) }],
    ['cloud/account-b/custom', { id: 'custom', name: 'B', instruction: 'Owned B', sections_json: JSON.stringify(validSections) }],
    ['legacy/legacy-1/custom', { id: 'custom', name: 'Legacy', instruction: 'Owned legacy', sections_json: JSON.stringify(validSections) }],
  ]);
  const db = fakeDb(rows, queries);
  assert.equal((await resolveOwnedScene(db, a, 'custom'))?.instruction, 'Owned A');
  assert.equal((await resolveOwnedScene(db, { ...a, cloudDeviceId: 'device-a2' }, 'custom'))?.instruction, 'Owned A');
  assert.equal((await resolveOwnedScene(db, b, 'custom'))?.instruction, 'Owned B');
  assert.equal((await resolveOwnedScene(db, legacy, 'custom'))?.instruction, 'Owned legacy');
  assert.equal(await resolveOwnedScene(db, { ...a, cloudAccountId: 'unknown' }, 'custom'), null);
  assert.equal(queries.filter(q => q.includes('FROM cloud_scenes')).length, 4);
  assert.equal(queries.filter(q => q.includes('FROM scenes ')).length, 1);
});

test('invalid JSON, invalid scene shape and malformed identifiers fail closed', async () => {
  const rows = new Map<string, SceneRow>([
    ['cloud/account-a/invalid-json', { id: 'invalid-json', name: 'Broken', instruction: 'Nope', sections_json: '{oops' }],
    ['cloud/account-a/invalid-shape', { id: 'invalid-shape', name: 'Broken', instruction: 'Nope', sections_json: '[]' }],
  ]);
  const db = fakeDb(rows, []);
  assert.equal(await resolveOwnedScene(db, a, 'invalid-json'), null);
  assert.equal(await resolveOwnedScene(db, a, 'invalid-shape'), null);
  assert.equal(await resolveOwnedScene(db, a, '../../legacy'), null);
  await assert.rejects(
    resolveOwnedScene(db, { ...a, cloudAccountId: '   ' }, 'meeting'),
    /requires an account id/,
  );
});
