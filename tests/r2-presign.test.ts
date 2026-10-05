import assert from 'node:assert/strict';
import test from 'node:test';
import { createPresignedR2PutUrl } from '../src/shared/r2Presign';

test('R2 presign fails fast when account id is missing', async () => {
  await assert.rejects(
    () =>
      createPresignedR2PutUrl({
        accountId: '',
        bucket: 'mira-shiyan-audio',
        objectKey: 'audio/test.bin',
        accessKeyId: 'test-access',
        secretAccessKey: 'test-secret',
        contentType: 'application/octet-stream',
        expiresInSeconds: 60,
      }),
    /R2 account id is required/u,
  );
});
