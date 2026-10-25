import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CloudAuthError,
  authenticateCloudShiyanCredential,
  loadCloudAuthJwks,
  resolveShiyanRequestAuth,
  verifyCloudShiyanCredential,
  type CloudAuthFailureReason,
} from '../src/shared/cloudAuth';
import {
  CLOUD_AUTH_TEST_NOW,
  createTestSigningKey,
  shiyanClaims,
  signTestCredential,
  trustedKeyMap,
} from './helpers/cloud-auth';

const now = () => new Date(CLOUD_AUTH_TEST_NOW * 1000);

const jwksFetch = (
  keys: Array<{ kid: string; x: string; kty: 'OKP'; crv: 'Ed25519'; use: 'sig'; alg: 'EdDSA' }>,
): typeof fetch =>
  (async () => Response.json({ keys })) as typeof fetch;

const expectReason = async (
  promise: Promise<unknown>,
  reason: CloudAuthFailureReason,
): Promise<void> => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CloudAuthError);
    assert.equal(error.reason, reason);
    return true;
  });
};

test('a valid aud=shiyan Mira Cloud credential authenticates as a Cloud principal', async () => {
  const key = await createTestSigningKey('cloud-auth-contract-key');
  const verified = await authenticateCloudShiyanCredential(
    await signTestCredential(shiyanClaims(), key),
    {
      jwksUrl: `https://cloud-auth.test/${crypto.randomUUID()}/.well-known/jwks.json`,
      fetchImpl: jwksFetch([key.publicJwk]),
      now,
    },
  );

  assert.deepEqual(verified.principal, {
    kind: 'cloud-shiyan',
    cloudAccountId: 'cloud-account-1',
    cloudDeviceId: 'mira-device-1',
  });
  assert.equal(verified.keyId, 'cloud-auth-contract-key');
});

test('wrong audience, scope, expiry, signature and malformed identity fail closed', async () => {
  const key = await createTestSigningKey();
  const jwksUrl = `https://cloud-auth.test/${crypto.randomUUID()}/.well-known/jwks.json`;
  const fetchImpl = jwksFetch([key.publicJwk]);
  const options = { jwksUrl, fetchImpl, now };

  await expectReason(
    authenticateCloudShiyanCredential(
      await signTestCredential(
        shiyanClaims({
          aud: 'mira:cloud-relay-transport',
          scope: ['relay:transport'],
          relay: { room: 'room-1', role: 'client' },
        }),
        key,
      ),
      options,
    ),
    'audience_mismatch',
  );
  await expectReason(
    authenticateCloudShiyanCredential(
      await signTestCredential(shiyanClaims({ scope: ['relay:transport'] }), key),
      options,
    ),
    'invalid_claims',
  );
  await expectReason(
    authenticateCloudShiyanCredential(
      await signTestCredential(
        shiyanClaims({
          iat: CLOUD_AUTH_TEST_NOW - 600,
          nbf: CLOUD_AUTH_TEST_NOW - 600,
          exp: CLOUD_AUTH_TEST_NOW - 1,
        }),
        key,
      ),
      options,
    ),
    'expired',
  );
  const otherKey = await createTestSigningKey(key.kid);
  await expectReason(
    authenticateCloudShiyanCredential(
      await signTestCredential(shiyanClaims(), otherKey),
      options,
    ),
    'invalid_signature',
  );
  await expectReason(
    authenticateCloudShiyanCredential(
      `${await signTestCredential(shiyanClaims(), key)}tampered`,
      options,
    ),
    'malformed_token',
  );
  await expectReason(
    authenticateCloudShiyanCredential(
      await signTestCredential(shiyanClaims({ device_id: '' }), key),
      options,
    ),
    'invalid_claims',
  );
  await expectReason(
    authenticateCloudShiyanCredential(
      await signTestCredential(shiyanClaims(), key, {
        alg: 'EdDSA',
        typ: 'JWT',
        kid: 'not-published',
      }),
      options,
    ),
    'unknown_key',
  );
});

test('missing trusted JWKS configuration rejects Cloud credentials but not legacy ones', async () => {
  const key = await createTestSigningKey();
  const token = await signTestCredential(shiyanClaims(), key);

  await expectReason(
    authenticateCloudShiyanCredential(token, {
      jwksUrl: undefined,
      fetchImpl: jwksFetch([key.publicJwk]),
      now,
    }),
    'configuration_unavailable',
  );

  const legacy = await resolveShiyanRequestAuth(
    new Request('https://shiyan.test/v1/capture-tasks', {
      headers: { authorization: 'Bearer opaque-device-secret' },
    }),
    {
      authenticateCloud: (credential) =>
        authenticateCloudShiyanCredential(credential, {
          jwksUrl: undefined,
          fetchImpl: jwksFetch([key.publicJwk]),
          now,
        }),
      lookupLegacyDevice: async (credential) => ({
        kind: 'legacy-device',
        legacyDeviceId: `legacy:${credential}`,
        userId: 'legacy-user',
      }),
    },
  );

  assert.equal(legacy.kind, 'legacy-device');
});

test('Cloud identity and legacy device identity remain distinct principals', async () => {
  const key = await createTestSigningKey();
  const token = await signTestCredential(shiyanClaims(), key);

  const cloud = await resolveShiyanRequestAuth(
    new Request('https://shiyan.test/v1/capture-tasks', {
      headers: { authorization: `Bearer ${token}` },
    }),
    {
      authenticateCloud: (credential) =>
        authenticateCloudShiyanCredential(credential, {
          jwksUrl: `https://cloud-auth.test/${crypto.randomUUID()}/.well-known/jwks.json`,
          fetchImpl: jwksFetch([key.publicJwk]),
          now,
        }),
      lookupLegacyDevice: async () => {
        throw new Error('legacy_lookup_must_not_run_for_cloud_credentials');
      },
    },
  );

  assert.equal(cloud.kind, 'cloud-shiyan');
  assert.notEqual(cloud.kind, 'legacy-device');
  assert.deepEqual(cloud.principal, {
    kind: 'cloud-shiyan',
    cloudAccountId: 'cloud-account-1',
    cloudDeviceId: 'mira-device-1',
  });
});

test('pre-published key rotation accepts old and new kids, then retires the old key', async () => {
  const oldKey = await createTestSigningKey('cloud-auth-old');
  const newKey = await createTestSigningKey('cloud-auth-new');
  const url = `https://cloud-auth.test/${crypto.randomUUID()}/.well-known/jwks.json`;
  const nowSeconds = () => CLOUD_AUTH_TEST_NOW;

  const cachedBoth = await loadCloudAuthJwks(url, {
    fetchImpl: jwksFetch([oldKey.publicJwk, newKey.publicJwk]),
    now: () => new Date(nowSeconds() * 1000),
  });
  assert.equal(cachedBoth.has(oldKey.kid), true);
  assert.equal(cachedBoth.has(newKey.kid), true);

  const oldToken = await signTestCredential(shiyanClaims(), oldKey);
  const newToken = await signTestCredential(shiyanClaims(), newKey);
  const baseConfig = {
    publicKeys: cachedBoth,
    now: () => new Date(nowSeconds() * 1000),
  };

  assert.equal((await verifyCloudShiyanCredential(oldToken, baseConfig)).keyId, oldKey.kid);
  assert.equal((await verifyCloudShiyanCredential(newToken, baseConfig)).keyId, newKey.kid);

  const retired = await trustedKeyMap([newKey]);
  await expectReason(
    verifyCloudShiyanCredential(oldToken, { ...baseConfig, publicKeys: retired }),
    'unknown_key',
  );
});
