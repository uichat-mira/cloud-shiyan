import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CloudAuthError,
  CLOUD_AUTH_JWKS_CACHE_SECONDS,
  isCloudCredentialCandidate,
  loadCloudAuthJwks,
  resolveShiyanRequestAuth,
  verifyCloudShiyanCredential,
  type CloudAuthFailureReason,
  type ShiyanAuthResolution,
} from '../src/shared/cloudAuth';
import {
  CLOUD_AUTH_TEST_NOW,
  createTestSigningKey,
  replaceJwtPayload,
  shiyanClaims,
  signTestCredential,
  trustedKeyMap,
} from './helpers/cloud-auth';

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

const verifyConfig = async (key: Awaited<ReturnType<typeof createTestSigningKey>>) => ({
  publicKeys: await trustedKeyMap([key]),
  now: () => new Date(CLOUD_AUTH_TEST_NOW * 1000),
});

const requestWith = (authorization?: string): Request =>
  new Request('https://shiyan.test/v1/capture-tasks', {
    headers: authorization ? { authorization } : {},
  });

test('valid Shiyan credential maps explicit Cloud Account and Mira Device principals', async () => {
  const key = await createTestSigningKey();
  const verified = await verifyCloudShiyanCredential(
    await signTestCredential(shiyanClaims(), key),
    await verifyConfig(key),
  );

  assert.deepEqual(verified.principal, {
    kind: 'cloud-shiyan',
    cloudAccountId: 'cloud-account-1',
    cloudDeviceId: 'mira-device-1',
  });
  assert.equal(verified.keyId, key.kid);
  assert.equal(verified.issuedAt.toISOString(), '2026-09-21T14:13:20.000Z');
  assert.equal(verified.expiresAt.toISOString(), '2026-09-21T14:18:20.000Z');
});

test('compact JWS candidates and opaque legacy credentials are selected explicitly', async () => {
  assert.equal(isCloudCredentialCandidate('aaa.bbb.ccc'), true);
  assert.equal(isCloudCredentialCandidate('opaque-legacy-device-credential'), false);
  assert.equal(isCloudCredentialCandidate('legacy.with.dot.and.more'), false);

  let legacyLookups = 0;
  const cloudResult: ShiyanAuthResolution = await resolveShiyanRequestAuth(
    requestWith('Bearer aaa.bbb.ccc'),
    {
      authenticateCloud: async () => {
        throw new CloudAuthError('invalid_signature', 'signature rejected');
      },
      lookupLegacyDevice: async () => {
        legacyLookups += 1;
        return {
          kind: 'legacy-device',
          legacyDeviceId: 'legacy-device-1',
          userId: null,
        };
      },
    },
  );

  assert.deepEqual(cloudResult, {
    kind: 'cloud-credential-rejected',
    reason: 'invalid_signature',
  });
  assert.equal(legacyLookups, 0);

  const legacyResult = await resolveShiyanRequestAuth(
    requestWith('Bearer opaque-legacy-device-credential'),
    {
      authenticateCloud: async () => {
        throw new Error('must_not_verify_legacy_as_cloud');
      },
      lookupLegacyDevice: async (credential) => ({
        kind: 'legacy-device',
        legacyDeviceId: `legacy:${credential}`,
        userId: 'legacy-user-1',
      }),
    },
  );

  assert.deepEqual(legacyResult, {
    kind: 'legacy-device',
    principal: {
      kind: 'legacy-device',
      legacyDeviceId: 'legacy:opaque-legacy-device-credential',
      userId: 'legacy-user-1',
    },
  });
});

test('resolver reports missing credentials and verification configuration separately', async () => {
  const missing = await resolveShiyanRequestAuth(requestWith(), {
    authenticateCloud: async () => {
      throw new Error('unused');
    },
    lookupLegacyDevice: async () => null,
  });
  assert.deepEqual(missing, { kind: 'missing' });

  const unavailable = await resolveShiyanRequestAuth(requestWith('Bearer aaa.bbb.ccc'), {
    authenticateCloud: async () => {
      throw new CloudAuthError('configuration_unavailable', 'JWKS missing');
    },
    lookupLegacyDevice: async () => null,
  });
  assert.deepEqual(unavailable, { kind: 'cloud-auth-unavailable' });

  const unexpected = await resolveShiyanRequestAuth(requestWith('Bearer aaa.bbb.ccc'), {
    authenticateCloud: async () => {
      throw new TypeError('unexpected verifier failure');
    },
    lookupLegacyDevice: async () => null,
  });
  assert.deepEqual(unexpected, { kind: 'cloud-auth-unavailable' });
});

test('resolver never falls back to legacy for a rejected compact JWS', async () => {
  let legacyLookups = 0;
  const resolution = await resolveShiyanRequestAuth(
    requestWith('Bearer valid-shaped.rejected.signature'),
    {
      authenticateCloud: async () => {
        throw new CloudAuthError('unknown_key', 'unknown kid');
      },
      lookupLegacyDevice: async () => {
        legacyLookups += 1;
        return {
          kind: 'legacy-device',
          legacyDeviceId: 'legacy-device-1',
          userId: null,
        };
      },
    },
  );

  assert.equal(legacyLookups, 0);
  assert.deepEqual(resolution, {
    kind: 'cloud-credential-rejected',
    reason: 'unknown_key',
  });
});

test('malformed three-segment Cloud candidates cannot fall through to legacy lookup', async () => {
  const key = await createTestSigningKey();
  const config = await verifyConfig(key);
  let legacyLookups = 0;

  for (const malformed of ['aaa..ccc', 'aaa.bbb.!', '.bbb.ccc', 'aaa.bbb.']) {
    assert.equal(isCloudCredentialCandidate(malformed), true);

    const result = await resolveShiyanRequestAuth(requestWith(`Bearer ${malformed}`), {
      authenticateCloud: (token) => verifyCloudShiyanCredential(token, config),
      lookupLegacyDevice: async () => {
        legacyLookups += 1;
        return {
          kind: 'legacy-device',
          legacyDeviceId: 'should-never-authorize',
          userId: null,
        };
      },
    });
    assert.deepEqual(result, {
      kind: 'cloud-credential-rejected',
      reason: 'malformed_token',
    });
  }
  assert.equal(legacyLookups, 0);
});

test('JWKS loader uses the trusted URL, caches for at most 300 seconds, and refreshes after expiry', async () => {
  const key = await createTestSigningKey();
  const url = `https://cloud-auth.test/${crypto.randomUUID()}/.well-known/jwks.json`;
  let nowMilliseconds = CLOUD_AUTH_TEST_NOW * 1000;
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls += 1;
    return Response.json({ keys: [key.publicJwk] });
  }) as typeof fetch;
  const now = () => new Date(nowMilliseconds);

  const first = await loadCloudAuthJwks(url, { fetchImpl, now });
  assert.equal(fetchCalls, 1);
  assert.equal(first.has(key.kid), true);

  const cached = await loadCloudAuthJwks(url, {
    fetchImpl: (async () => {
      throw new Error('cache_must_not_fetch');
    }) as typeof fetch,
    now,
  });
  assert.equal(cached.has(key.kid), true);
  assert.equal(fetchCalls, 1);

  nowMilliseconds += CLOUD_AUTH_JWKS_CACHE_SECONDS * 1000 + 1;
  const refreshed = await loadCloudAuthJwks(url, { fetchImpl, now });
  assert.equal(refreshed.has(key.kid), true);
  assert.equal(fetchCalls, 2);
});

test('JWKS loader fails closed for unavailable or malformed trust material', async () => {
  const key = await createTestSigningKey();
  const url = `https://cloud-auth.test/${crypto.randomUUID()}/.well-known/jwks.json`;
  const now = () => new Date(CLOUD_AUTH_TEST_NOW * 1000);
  const respond = (body: unknown, status = 200): typeof fetch =>
    (async () => Response.json(body, { status })) as typeof fetch;

  await expectReason(
    loadCloudAuthJwks(undefined, { fetchImpl: respond({ keys: [] }), now }),
    'configuration_unavailable',
  );
  await expectReason(
    loadCloudAuthJwks('http://cloud-auth.test/.well-known/jwks.json', {
      fetchImpl: respond({ keys: [key.publicJwk] }),
      now,
    }),
    'configuration_unavailable',
  );
  await expectReason(
    loadCloudAuthJwks(url, { fetchImpl: respond({ keys: [key.publicJwk] }, 503), now }),
    'configuration_unavailable',
  );
  await expectReason(
    loadCloudAuthJwks(url, { fetchImpl: respond({ keys: [] }), now }),
    'configuration_unavailable',
  );
  await expectReason(
    loadCloudAuthJwks(url, { fetchImpl: respond({ keys: [key.publicJwk, key.publicJwk] }), now }),
    'configuration_unavailable',
  );
  await expectReason(
    loadCloudAuthJwks(url, {
      fetchImpl: respond({ keys: [{ ...key.publicJwk, d: 'private-material' }] }),
      now,
    }),
    'configuration_unavailable',
  );
});

test('JWKS loader does not trust token-supplied key material or redirects', async () => {
  const key = await createTestSigningKey();
  const url = `https://cloud-auth.test/${crypto.randomUUID()}/.well-known/jwks.json`;
  let observedInit: RequestInit | undefined;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    observedInit = init;
    return Response.json({ keys: [key.publicJwk] });
  }) as typeof fetch;

  await loadCloudAuthJwks(url, {
    fetchImpl,
    now: () => new Date(CLOUD_AUTH_TEST_NOW * 1000),
  });

  assert.equal(observedInit?.redirect, 'error');
});

test('token tampering, malformed headers and unknown kids are rejected before claims trust', async () => {
  const key = await createTestSigningKey();
  const config = await verifyConfig(key);

  await expectReason(verifyCloudShiyanCredential('not-a-jwt', config), 'malformed_token');
  await expectReason(
    verifyCloudShiyanCredential(
      await signTestCredential(shiyanClaims(), key, {
        alg: 'HS256',
        typ: 'JWT',
        kid: key.kid,
      }),
      config,
    ),
    'invalid_header',
  );
  await expectReason(
    verifyCloudShiyanCredential(
      await signTestCredential(shiyanClaims(), key, {
        alg: 'EdDSA',
        typ: 'JWT',
        kid: key.kid,
        jku: 'https://attacker.invalid/jwks.json',
      }),
      config,
    ),
    'invalid_header',
  );
  await expectReason(
    verifyCloudShiyanCredential(
      await signTestCredential(shiyanClaims(), key, {
        alg: 'EdDSA',
        typ: 'JWT',
        kid: 'unknown-key',
      }),
      config,
    ),
    'unknown_key',
  );

  const valid = await signTestCredential(shiyanClaims(), key);
  await expectReason(
    verifyCloudShiyanCredential(
      replaceJwtPayload(valid, shiyanClaims({ sub: 'tampered-account' })),
      config,
    ),
    'invalid_signature',
  );
});

test('wrong issuer, audience, scope and unexpected claims fail closed', async () => {
  const key = await createTestSigningKey();
  const config = await verifyConfig(key);

  await expectReason(
    verifyCloudShiyanCredential(
      await signTestCredential(shiyanClaims({ iss: 'mira:other-issuer' }), key),
      config,
    ),
    'issuer_mismatch',
  );
  await expectReason(
    verifyCloudShiyanCredential(
      await signTestCredential(
        shiyanClaims({
          aud: 'mira:cloud-relay-transport',
          scope: ['relay:transport'],
          relay: { room: 'room-1', role: 'client' },
        }),
        key,
      ),
      config,
    ),
    'audience_mismatch',
  );
  await expectReason(
    verifyCloudShiyanCredential(
      await signTestCredential(shiyanClaims({ scope: ['relay:transport'] }), key),
      config,
    ),
    'invalid_claims',
  );
  await expectReason(
    verifyCloudShiyanCredential(
      await signTestCredential(
        shiyanClaims({ scope: ['shiyan:authenticate', 'shiyan:extra'] }),
        key,
      ),
      config,
    ),
    'invalid_claims',
  );
  await expectReason(
    verifyCloudShiyanCredential(
      await signTestCredential(shiyanClaims({ extra_claim: true }), key),
      config,
    ),
    'invalid_claims',
  );
  await expectReason(
    verifyCloudShiyanCredential(await signTestCredential(shiyanClaims({ sub: '' }), key), config),
    'invalid_claims',
  );
  await expectReason(
    verifyCloudShiyanCredential(
      await signTestCredential(shiyanClaims({ device_id: '' }), key),
      config,
    ),
    'invalid_claims',
  );
});

test('future, not-yet-valid, expired and over-long credentials are rejected', async () => {
  const key = await createTestSigningKey();
  const config = await verifyConfig(key);

  await expectReason(
    verifyCloudShiyanCredential(
      await signTestCredential(
        shiyanClaims({
          iat: CLOUD_AUTH_TEST_NOW + 1,
          nbf: CLOUD_AUTH_TEST_NOW + 1,
          exp: CLOUD_AUTH_TEST_NOW + 300,
        }),
        key,
      ),
      config,
    ),
    'issued_in_future',
  );
  await expectReason(
    verifyCloudShiyanCredential(
      await signTestCredential(
        shiyanClaims({
          iat: CLOUD_AUTH_TEST_NOW,
          nbf: CLOUD_AUTH_TEST_NOW + 1,
          exp: CLOUD_AUTH_TEST_NOW + 300,
        }),
        key,
      ),
      config,
    ),
    'not_yet_valid',
  );
  await expectReason(
    verifyCloudShiyanCredential(
      await signTestCredential(
        shiyanClaims({
          iat: CLOUD_AUTH_TEST_NOW - 300,
          nbf: CLOUD_AUTH_TEST_NOW - 300,
          exp: CLOUD_AUTH_TEST_NOW,
        }),
        key,
      ),
      config,
    ),
    'expired',
  );
  await expectReason(
    verifyCloudShiyanCredential(
      await signTestCredential(
        shiyanClaims({
          iat: CLOUD_AUTH_TEST_NOW,
          nbf: CLOUD_AUTH_TEST_NOW,
          exp: CLOUD_AUTH_TEST_NOW + 601,
        }),
        key,
      ),
      config,
    ),
    'ttl_exceeded',
  );
  await expectReason(
    verifyCloudShiyanCredential(
      await signTestCredential(
        shiyanClaims({
          iat: CLOUD_AUTH_TEST_NOW,
          nbf: CLOUD_AUTH_TEST_NOW + 1,
          exp: CLOUD_AUTH_TEST_NOW,
        }),
        key,
      ),
      config,
    ),
    'invalid_claims',
  );
});

test('verifier configuration fails closed without trusted keys or a valid clock', async () => {
  const key = await createTestSigningKey();
  const token = await signTestCredential(shiyanClaims(), key);

  await expectReason(
    verifyCloudShiyanCredential(token, {
      publicKeys: new Map(),
      now: () => new Date(CLOUD_AUTH_TEST_NOW * 1000),
    }),
    'configuration_unavailable',
  );
  await expectReason(
    verifyCloudShiyanCredential(token, {
      publicKeys: await trustedKeyMap([key]),
      now: () => new Date(Number.NaN),
    }),
    'configuration_unavailable',
  );
  await expectReason(
    verifyCloudShiyanCredential(token, {
      publicKeys: await trustedKeyMap([key]),
      now: () => new Date(CLOUD_AUTH_TEST_NOW * 1000),
      clockSkewSeconds: 61,
    }),
    'configuration_unavailable',
  );
});
