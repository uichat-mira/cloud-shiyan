export const CLOUD_AUTH_TEST_NOW = 1_790_000_000;

export interface TestSigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  readonly publicJwk: {
    readonly kty: 'OKP';
    readonly crv: 'Ed25519';
    readonly use: 'sig';
    readonly alg: 'EdDSA';
    readonly kid: string;
    readonly x: string;
  };
}

export interface ShiyanClaimsOverrides {
  readonly [key: string]: unknown;
}

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function encodeJson(value: unknown): string {
  return base64Url(encoder.encode(JSON.stringify(value)));
}

export async function createTestSigningKey(
  kid = 'cloud-auth-test-key-1',
): Promise<TestSigningKey> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ]);
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  if (typeof exported.x !== 'string') {
    throw new Error('test_ed25519_public_key_export_failed');
  }
  return {
    kid,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicJwk: {
      kty: 'OKP',
      crv: 'Ed25519',
      use: 'sig',
      alg: 'EdDSA',
      kid,
      x: exported.x,
    },
  };
}

export async function importTestPublicKey(
  publicJwk: TestSigningKey['publicJwk'],
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x },
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
}

export async function trustedKeyMap(
  keys: readonly TestSigningKey[],
): Promise<Map<string, CryptoKey>> {
  return new Map(
    await Promise.all(
      keys.map(async (key) => [key.kid, await importTestPublicKey(key.publicJwk)] as const),
    ),
  );
}

export function shiyanClaims(
  overrides: ShiyanClaimsOverrides = {},
): Record<string, unknown> {
  return {
    iss: 'mira:cloud-auth',
    sub: 'cloud-account-1',
    device_id: 'mira-device-1',
    aud: 'mira:cloud-shiyan',
    scope: ['shiyan:authenticate'],
    iat: CLOUD_AUTH_TEST_NOW,
    nbf: CLOUD_AUTH_TEST_NOW,
    exp: CLOUD_AUTH_TEST_NOW + 300,
    ...overrides,
  };
}

export async function signTestCredential(
  claims: Record<string, unknown>,
  key: TestSigningKey,
  header: Record<string, unknown> = {
    alg: 'EdDSA',
    typ: 'JWT',
    kid: key.kid,
  },
): Promise<string> {
  const signingInput = `${encodeJson(header)}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    key.privateKey,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

export function replaceJwtPayload(
  token: string,
  claims: Record<string, unknown>,
): string {
  const parts = token.split('.');
  return `${parts[0]}.${encodeJson(claims)}.${parts[2]}`;
}
