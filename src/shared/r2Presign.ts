const encoder = new TextEncoder();
const AWS_ALGORITHM = 'AWS4-HMAC-SHA256';
const REGION = 'auto';
const SERVICE = 's3';

const toHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');

const sha256Hex = async (value: string): Promise<string> =>
  toHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));

const hmac = async (
  key: ArrayBuffer | Uint8Array<ArrayBuffer>,
  value: string,
): Promise<ArrayBuffer> => {
  const rawKey = key instanceof ArrayBuffer ? key : new Uint8Array(key).buffer;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(value));
};

const awsEncode = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const encodeObjectKey = (key: string): string =>
  key
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(awsEncode)
    .join('/');

const amzTimestamp = (date: Date): string =>
  date.toISOString().replace(/[:-]|\.\d{3}/g, '');

const dateStamp = (amzDate: string): string => amzDate.slice(0, 8);

const canonicalQuery = (params: URLSearchParams): string =>
  [...params.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      const keyOrder = leftKey.localeCompare(rightKey);
      return keyOrder === 0 ? leftValue.localeCompare(rightValue) : keyOrder;
    })
    .map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`)
    .join('&');

export interface R2PresignInput {
  accountId: string;
  bucket: string;
  objectKey: string;
  accessKeyId: string;
  secretAccessKey: string;
  contentType: string;
  expiresInSeconds: number;
  now?: Date;
}

export async function createPresignedR2PutUrl(
  input: R2PresignInput,
): Promise<string> {
  if (input.expiresInSeconds < 1 || input.expiresInSeconds > 604800) {
    throw new Error('R2 presign expiry must be between 1 second and 7 days');
  }
  if (!input.objectKey.trim()) throw new Error('R2 object key is required');
  if (!input.contentType.trim()) throw new Error('R2 upload content type is required');

  const now = input.now ?? new Date();
  const amzDate = amzTimestamp(now);
  const day = dateStamp(amzDate);
  const credentialScope = `${day}/${REGION}/${SERVICE}/aws4_request`;
  const host = `${input.accountId}.r2.cloudflarestorage.com`;
  const pathname = `/${awsEncode(input.bucket)}/${encodeObjectKey(input.objectKey)}`;
  const signedHeaders = 'content-type;host';

  const params = new URLSearchParams({
    'X-Amz-Algorithm': AWS_ALGORITHM,
    'X-Amz-Credential': `${input.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(input.expiresInSeconds),
    'X-Amz-SignedHeaders': signedHeaders,
  });

  const canonicalRequest = [
    'PUT',
    pathname,
    canonicalQuery(params),
    `content-type:${input.contentType.trim()}\nhost:${host}\n`,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    AWS_ALGORITHM,
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const dateKey = await hmac(encoder.encode(`AWS4${input.secretAccessKey}`), day);
  const regionKey = await hmac(dateKey, REGION);
  const serviceKey = await hmac(regionKey, SERVICE);
  const signingKey = await hmac(serviceKey, 'aws4_request');
  const signature = toHex(await hmac(signingKey, stringToSign));

  params.set('X-Amz-Signature', signature);
  return `https://${host}${pathname}?${canonicalQuery(params)}`;
}
