/**
 * Thin S3 admin helpers for test fixtures, built on aws4fetch. Replaces
 * the `new S3({...})` calls that previously pulled in @aws-sdk/client-s3.
 *
 * Tests only need `createBucket` against S3-compatible endpoints; each
 * caller constructs its own signed `AwsClient`.
 */

import type { AwsClient } from "aws4fetch";

/**
 * `PUT {endpoint}/{bucket}`. Tolerates 409 BucketAlreadyOwnedByYou so
 * test re-runs against a persistent Minio don't fail in beforeAll.
 */
export const createBucket = async (
  client: AwsClient,
  endpoint: string,
  bucket: string,
): Promise<void> => {
  const res = await client.fetch(`${endpoint}/${bucket}`, { method: "PUT" });
  if (!res.ok && res.status !== 409) {
    throw new Error(`createBucket ${bucket}: ${res.status} ${await res.text()}`);
  }
};
