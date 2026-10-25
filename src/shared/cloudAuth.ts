/**
 * Cloud Shiyan's verifier for Mira Cloud service credentials.
 *
 * The canonical contract is owned by:
 * - uichat-mira/.github/docs/engineering/mira-cloud-auth.md
 * - uichat-mira/cloud-auth/docs/service-credentials-v0.md
 *
 * Trust is explicit: the issuer, audience, scope and JWKS URL are never derived
 * from a token. A valid credential only establishes a Cloud Account/Mira Device
 * principal; it does not grant any Shiyan business-resource authorization.
 */

export const CLOUD_AUTH_ISSUER = 'mira:cloud-auth';
export const CLOUD_SHIYAN_AUDIENCE = 'mira:cloud-shiyan';
export const SHIYAN_AUTHENTICATE_SCOPE = 'shiyan:authenticate';
export const CLOUD_AUTH_JWKS_CACHE_SECONDS = 300;

const MAX_CREDENTIAL_TTL_SECONDS = 600;
const MAX_CLOCK_SKEW_SECONDS = 60;
const JWKS_CACHE_MAX_ENTRIES = 4;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;
const COMPACT_JWS_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const SHIYAN_CLAIM_NAMES = new Set([
  'iss',
  'sub',
  'device_id',
  'aud',
  'scope',
  'iat',
  'nbf',
  'exp',
]);

export type CloudAuthFailureReason =
  | 'configuration_unavailable'
  | 'malformed_token'
  | 'invalid_header'
  | 'unknown_key'
  | 'invalid_signature'
  | 'invalid_claims'
  | 'issuer_mismatch'
  | 'audience_mismatch'
  | 'expired'
  | 'not_yet_valid'
  | 'issued_in_future'
  | 'ttl_exceeded';

export class CloudAuthError extends Error {
  readonly reason: CloudAuthFailureReason;

  constructor(reason: CloudAuthFailureReason, message: string) {
    super(message);
    this.name = 'CloudAuthError';
    this.reason = reason;
  }
}

export interface CloudShiyanPrincipal {
  readonly kind: 'cloud-shiyan';
  readonly cloudAccountId: string;
  readonly cloudDeviceId: string;
}

export interface DevicePrincipal {
  readonly kind: 'legacy-device';
  readonly legacyDeviceId: string;
  readonly userId: string | null;
}

export type ShiyanPrincipal = CloudShiyanPrincipal | DevicePrincipal;

export interface VerifiedCloudShiyanCredential {
  readonly principal: CloudShiyanPrincipal;
  readonly keyId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface VerifyCloudShiyanCredentialConfig {
  /** Explicit trusted key set. It is never populated from token contents. */
  readonly publicKeys: ReadonlyMap<string, CryptoKey>;
  readonly now?: () => Date;
  readonly clockSkewSeconds?: number;
  readonly maxTtlSeconds?: number;
}

export interface LoadCloudAuthJwksOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

export interface AuthenticateCloudShiyanCredentialOptions {
  /** Trusted JWKS address. Must be configured per deployment. */
  readonly jwksUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly clockSkewSeconds?: number;
}

export interface ShiyanAuthDependencies {
  authenticateCloud(credential: string): Promise<VerifiedCloudShiyanCredential>;
  lookupLegacyDevice(credential: string): Promise<DevicePrincipal | null>;
}

export type ShiyanAuthResolution =
  | {
      readonly kind: 'cloud-shiyan';
      readonly principal: CloudShiyanPrincipal;
      readonly keyId: string;
      readonly expiresAt: Date;
    }
  | { readonly kind: 'legacy-device'; readonly principal: DevicePrincipal }
  | { readonly kind: 'missing' }
  | { readonly kind: 'legacy-invalid' }
  | {
      readonly kind: 'cloud-credential-rejected';
      readonly reason: CloudAuthFailureReason;
    }
  | { readonly kind: 'cloud-auth-unavailable' };

interface ParsedCompactJwt {
  readonly headerBytes: Uint8Array;
  readonly payloadBytes: Uint8Array;
  readonly signature: Uint8Array;
  readonly signingInput: string;
}

interface CommonClaims {
  readonly iss: string;
  readonly sub: string;
  readonly device_id: string;
  readonly aud: string;
  readonly scope: readonly string[];
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
}

interface JwksCacheEntry {
  readonly keys: ReadonlyMap<string, CryptoKey>;
  readonly expiresAtMs: number;
}

const jwksCache = new Map<string, JwksCacheEntry>();

function fail(reason: CloudAuthFailureReason, message: string): never {
  throw new CloudAuthError(reason, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function decodeBase64Url(
  segment: string,
  reason: CloudAuthFailureReason,
): Uint8Array {
  if (!BASE64URL_SEGMENT.test(segment)) {
    fail(reason, 'Value is not compact base64url');
  }
  const padding = '='.repeat((4 - (segment.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(`${segment.replace(/-/gu, '+').replace(/_/gu, '/')}${padding}`);
  } catch {
    fail(reason, 'Value is not compact base64url');
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== segment) {
    fail(reason, 'Value is not canonical base64url');
  }
  return bytes;
}

function decodeJsonBytes(
  bytes: Uint8Array,
  reason: CloudAuthFailureReason,
): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(reason, 'JWT segment is not valid UTF-8 JSON');
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(reason, 'JWT segment is not valid JSON');
  }
}

function parseCompactJwt(token: string): ParsedCompactJwt {
  if (typeof token !== 'string') {
    fail('malformed_token', 'Service credential must be a compact JWS');
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    fail('malformed_token', 'Service credential must have exactly three segments');
  }
  const headerSegment = parts[0];
  const payloadSegment = parts[1];
  const signatureSegment = parts[2];
  if (
    headerSegment === undefined ||
    payloadSegment === undefined ||
    signatureSegment === undefined ||
    headerSegment.length === 0 ||
    payloadSegment.length === 0 ||
    signatureSegment.length === 0
  ) {
    fail('malformed_token', 'Service credential segments must not be empty');
  }
  return {
    headerBytes: decodeBase64Url(headerSegment, 'malformed_token'),
    payloadBytes: decodeBase64Url(payloadSegment, 'malformed_token'),
    signature: decodeBase64Url(signatureSegment, 'malformed_token'),
    signingInput: `${headerSegment}.${payloadSegment}`,
  };
}

function parseHeader(headerBytes: Uint8Array): { kid: string } {
  const raw = decodeJsonBytes(headerBytes, 'invalid_header');
  if (!isPlainObject(raw)) {
    fail('invalid_header', 'JWT header must be a JSON object');
  }
  const names = Object.keys(raw);
  if (
    names.length !== 3 ||
    !names.includes('alg') ||
    !names.includes('typ') ||
    !names.includes('kid') ||
    raw.alg !== 'EdDSA' ||
    raw.typ !== 'JWT' ||
    typeof raw.kid !== 'string' ||
    !KEY_ID_PATTERN.test(raw.kid)
  ) {
    fail('invalid_header', 'JWT header must be EdDSA/JWT with a bounded kid');
  }
  return { kid: raw.kid };
}

function parseCommonClaims(payloadBytes: Uint8Array): {
  claims: CommonClaims;
  raw: Record<string, unknown>;
} {
  const raw = decodeJsonBytes(payloadBytes, 'invalid_claims');
  if (!isPlainObject(raw)) {
    fail('invalid_claims', 'JWT payload must be a JSON object');
  }
  const { iss, sub, device_id, aud, scope, iat, nbf, exp } = raw;
  if (typeof iss !== 'string' || iss.length < 1 || iss.length > 256) {
    fail('invalid_claims', 'iss must be a bounded string');
  }
  if (typeof sub !== 'string' || sub.length < 1 || sub.length > 128) {
    fail('invalid_claims', 'sub must be a bounded string');
  }
  if (
    typeof device_id !== 'string' ||
    device_id.length < 1 ||
    device_id.length > 128
  ) {
    fail('invalid_claims', 'device_id must be a bounded string');
  }
  if (typeof aud !== 'string' || aud.length < 1 || aud.length > 256) {
    fail('invalid_claims', 'aud must be a bounded string');
  }
  if (
    !Array.isArray(scope) ||
    scope.length === 0 ||
    scope.some(
      (value) => typeof value !== 'string' || value.length < 1 || value.length > 128,
    )
  ) {
    fail('invalid_claims', 'scope must be a non-empty array of bounded strings');
  }
  if (
    !isNonNegativeInteger(iat) ||
    !isNonNegativeInteger(nbf) ||
    !isNonNegativeInteger(exp)
  ) {
    fail('invalid_claims', 'iat, nbf and exp must be non-negative integers');
  }
  if (nbf < iat) {
    fail('invalid_claims', 'nbf must not precede iat');
  }
  if (exp <= nbf) {
    fail('invalid_claims', 'exp must be after nbf');
  }

  return {
    claims: { iss, sub, device_id, aud, scope, iat, nbf, exp },
    raw,
  };
}

function assertShiyanClaims(
  claims: CommonClaims,
  raw: Record<string, unknown>,
): void {
  if (claims.iss !== CLOUD_AUTH_ISSUER) {
    fail('issuer_mismatch', 'Service credential issuer is not trusted');
  }
  if (claims.aud !== CLOUD_SHIYAN_AUDIENCE) {
    fail('audience_mismatch', 'Service credential audience is not accepted by Shiyan');
  }
  for (const name of Object.keys(raw)) {
    if (!SHIYAN_CLAIM_NAMES.has(name)) {
      fail('invalid_claims', 'Service credential contains unexpected claims');
    }
  }
  if (
    claims.scope.length !== 1 ||
    claims.scope[0] !== SHIYAN_AUTHENTICATE_SCOPE
  ) {
    fail('invalid_claims', 'Service credential scope is not accepted by Shiyan');
  }
}

function resolveNow(now?: () => Date): number {
  let date: Date;
  try {
    date = (now ?? (() => new Date()))();
  } catch {
    fail('configuration_unavailable', 'Verifier clock is unavailable');
  }
  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds)) {
    fail('configuration_unavailable', 'Verifier clock must provide a valid time');
  }
  return Math.floor(milliseconds / 1000);
}

function resolveClockSkew(value: number | undefined): number {
  const skew = value ?? 0;
  if (
    !Number.isInteger(skew) ||
    skew < 0 ||
    skew > MAX_CLOCK_SKEW_SECONDS
  ) {
    fail(
      'configuration_unavailable',
      `clockSkewSeconds must be an integer between 0 and ${MAX_CLOCK_SKEW_SECONDS}`,
    );
  }
  return skew;
}

function resolveMaxTtl(value: number | undefined): number {
  const ttl = value ?? MAX_CREDENTIAL_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_CREDENTIAL_TTL_SECONDS) {
    fail(
      'configuration_unavailable',
      `maxTtlSeconds must be an integer between 1 and ${MAX_CREDENTIAL_TTL_SECONDS}`,
    );
  }
  return ttl;
}

function assertTemporalClaims(
  claims: CommonClaims,
  nowSeconds: number,
  clockSkewSeconds: number,
  maxTtlSeconds: number,
): void {
  if (claims.iat > nowSeconds + clockSkewSeconds) {
    fail('issued_in_future', 'Service credential was issued in the future');
  }
  if (claims.nbf > nowSeconds + clockSkewSeconds) {
    fail('not_yet_valid', 'Service credential is not valid yet');
  }
  if (claims.exp <= nowSeconds - clockSkewSeconds) {
    fail('expired', 'Service credential has expired');
  }
  if (claims.exp - claims.iat > maxTtlSeconds) {
    fail('ttl_exceeded', 'Service credential lifetime exceeds the verifier limit');
  }
}

export async function verifyCloudShiyanCredential(
  token: string,
  config: VerifyCloudShiyanCredentialConfig,
): Promise<VerifiedCloudShiyanCredential> {
  const maxTtlSeconds = resolveMaxTtl(config.maxTtlSeconds);
  const clockSkewSeconds = resolveClockSkew(config.clockSkewSeconds);
  if (config.publicKeys.size === 0) {
    fail('configuration_unavailable', 'No trusted Cloud Auth verification key is configured');
  }

  const parsed = parseCompactJwt(token);
  const header = parseHeader(parsed.headerBytes);
  const publicKey = config.publicKeys.get(header.kid);
  if (publicKey === undefined) {
    fail('unknown_key', 'Service credential was signed with an unknown key id');
  }

  let signatureValid: boolean;
  try {
    signatureValid = await crypto.subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      toArrayBuffer(parsed.signature),
      toArrayBuffer(new TextEncoder().encode(parsed.signingInput)),
    );
  } catch {
    fail('configuration_unavailable', 'Trusted Cloud Auth verification key is unusable');
  }
  if (!signatureValid) {
    fail('invalid_signature', 'Service credential signature is invalid');
  }

  const { claims, raw } = parseCommonClaims(parsed.payloadBytes);
  assertShiyanClaims(claims, raw);

  const nowSeconds = resolveNow(config.now);
  assertTemporalClaims(claims, nowSeconds, clockSkewSeconds, maxTtlSeconds);

  return {
    principal: {
      kind: 'cloud-shiyan',
      cloudAccountId: claims.sub,
      cloudDeviceId: claims.device_id,
    },
    keyId: header.kid,
    issuedAt: new Date(claims.iat * 1000),
    expiresAt: new Date(claims.exp * 1000),
  };
}

function resolveJwksUrl(value: string | undefined): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(
      'configuration_unavailable',
      'CLOUD_AUTH_JWKS_URL must be configured with a trusted Cloud Auth JWKS address',
    );
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    fail('configuration_unavailable', 'CLOUD_AUTH_JWKS_URL is not a valid URL');
  }
  if (url.protocol !== 'https:') {
    fail('configuration_unavailable', 'CLOUD_AUTH_JWKS_URL must use HTTPS');
  }
  if (url.username.length > 0 || url.password.length > 0) {
    fail('configuration_unavailable', 'CLOUD_AUTH_JWKS_URL must not contain credentials');
  }
  return url.href;
}

function resolveNowMilliseconds(now?: () => Date): number {
  let date: Date;
  try {
    date = (now ?? (() => new Date()))();
  } catch {
    fail('configuration_unavailable', 'JWKS cache clock is unavailable');
  }
  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds)) {
    fail('configuration_unavailable', 'JWKS cache clock must provide a valid time');
  }
  return milliseconds;
}

function parsePublicJwk(raw: unknown): { kid: string; x: string } {
  if (!isPlainObject(raw)) {
    fail('configuration_unavailable', 'Cloud Auth JWKS key must be a JSON object');
  }
  const names = Object.keys(raw);
  const allowed = new Set(['kty', 'crv', 'use', 'alg', 'kid', 'x']);
  if (
    names.length !== allowed.size ||
    names.some((name) => !allowed.has(name)) ||
    raw.kty !== 'OKP' ||
    raw.crv !== 'Ed25519' ||
    raw.use !== 'sig' ||
    raw.alg !== 'EdDSA' ||
    typeof raw.kid !== 'string' ||
    !KEY_ID_PATTERN.test(raw.kid) ||
    typeof raw.x !== 'string'
  ) {
    fail('configuration_unavailable', 'Cloud Auth JWKS key is not a trusted Ed25519 signing key');
  }
  const keyBytes = decodeBase64Url(raw.x, 'configuration_unavailable');
  if (keyBytes.length !== 32) {
    fail('configuration_unavailable', 'Cloud Auth JWKS Ed25519 public key has an invalid length');
  }
  return { kid: raw.kid, x: raw.x };
}

async function importTrustedKey(publicJwk: { kid: string; x: string }): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x },
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
  } catch {
    fail('configuration_unavailable', 'Cloud Auth JWKS public key could not be imported');
  }
}

async function parseTrustedJwks(raw: unknown): Promise<ReadonlyMap<string, CryptoKey>> {
  if (
    !isPlainObject(raw) ||
    Object.keys(raw).length !== 1 ||
    !Array.isArray(raw.keys) ||
    raw.keys.length === 0
  ) {
    fail('configuration_unavailable', 'Cloud Auth JWKS response is malformed or empty');
  }
  const keys = new Map<string, CryptoKey>();
  for (const item of raw.keys) {
    const publicJwk = parsePublicJwk(item);
    if (keys.has(publicJwk.kid)) {
      fail('configuration_unavailable', 'Cloud Auth JWKS contains duplicate key ids');
    }
    keys.set(publicJwk.kid, await importTrustedKey(publicJwk));
  }
  return keys;
}

function pruneJwksCache(nowMilliseconds: number): void {
  for (const [url, entry] of jwksCache) {
    if (nowMilliseconds >= entry.expiresAtMs) {
      jwksCache.delete(url);
    }
  }
}

/**
 * Loads an explicitly configured trusted JWKS address. The address is never
 * derived from token contents, redirects are not followed, expired entries are
 * never used as a fallback, and an unknown `kid` later fails verification.
 */
export async function loadCloudAuthJwks(
  jwksUrl: string | undefined,
  options: LoadCloudAuthJwksOptions = {},
): Promise<ReadonlyMap<string, CryptoKey>> {
  const url = resolveJwksUrl(jwksUrl);
  const nowMilliseconds = resolveNowMilliseconds(options.now);

  const cached = jwksCache.get(url);
  if (cached !== undefined && nowMilliseconds < cached.expiresAtMs) {
    return cached.keys;
  }
  jwksCache.delete(url);
  pruneJwksCache(nowMilliseconds);

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
    });
  } catch {
    fail('configuration_unavailable', 'Trusted Cloud Auth JWKS could not be fetched');
  }
  if (!response.ok) {
    fail('configuration_unavailable', 'Trusted Cloud Auth JWKS returned an error response');
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    fail('configuration_unavailable', 'Trusted Cloud Auth JWKS response is not valid JSON');
  }
  const keys = await parseTrustedJwks(raw);

  while (jwksCache.size >= JWKS_CACHE_MAX_ENTRIES) {
    const oldest = jwksCache.keys().next().value;
    if (oldest === undefined) break;
    jwksCache.delete(oldest);
  }
  jwksCache.set(url, {
    keys,
    expiresAtMs: nowMilliseconds + CLOUD_AUTH_JWKS_CACHE_SECONDS * 1000,
  });
  return keys;
}

export async function authenticateCloudShiyanCredential(
  token: string,
  options: AuthenticateCloudShiyanCredentialOptions,
): Promise<VerifiedCloudShiyanCredential> {
  const publicKeys = await loadCloudAuthJwks(options.jwksUrl, {
    fetchImpl: options.fetchImpl,
    now: options.now,
  });
  return verifyCloudShiyanCredential(token, {
    publicKeys,
    now: options.now,
    clockSkewSeconds: options.clockSkewSeconds,
  });
}

export function readBearerCredential(request: Request): string | null {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/iu.exec(authorization);
  const credential = match?.[1]?.trim();
  return credential ? credential : null;
}

/**
 * A compact-JWS-shaped credential is always treated as a Mira Cloud credential.
 * It never falls back to the legacy Shiyan device lookup after verification
 * fails. Opaque legacy device credentials therefore must not use this shape.
 */
export function isCloudCredentialCandidate(credential: string): boolean {
  return COMPACT_JWS_SHAPE.test(credential);
}

export async function resolveShiyanRequestAuth(
  request: Request,
  dependencies: ShiyanAuthDependencies,
): Promise<ShiyanAuthResolution> {
  const credential = readBearerCredential(request);
  if (credential === null) {
    return { kind: 'missing' };
  }

  if (isCloudCredentialCandidate(credential)) {
    try {
      const verified = await dependencies.authenticateCloud(credential);
      return {
        kind: 'cloud-shiyan',
        principal: verified.principal,
        keyId: verified.keyId,
        expiresAt: verified.expiresAt,
      };
    } catch (error) {
      if (error instanceof CloudAuthError) {
        if (error.reason === 'configuration_unavailable') {
          return { kind: 'cloud-auth-unavailable' };
        }
        return { kind: 'cloud-credential-rejected', reason: error.reason };
      }
      return { kind: 'cloud-auth-unavailable' };
    }
  }

  const legacy = await dependencies.lookupLegacyDevice(credential);
  return legacy === null
    ? { kind: 'legacy-invalid' }
    : { kind: 'legacy-device', principal: legacy };
}
