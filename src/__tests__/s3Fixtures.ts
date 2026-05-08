/**
 * Thin S3 admin helpers for test fixtures, built on aws4fetch. Replaces
 * the `new S3({...})` calls that previously pulled in @aws-sdk/client-s3.
 *
 * Tests only need three operations against S3-compatible endpoints:
 * createBucket, putBucketVersioning (Enabled), and getObject (for the
 * "Storage key representation" conformance test).
 */

import { AwsClient } from "aws4fetch";

export interface S3FixtureConfig {
  endpoint?: string;
  region?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

/**
 * Returns a signed client, or `undefined` if the config has no
 * credentials. Conformance variants like "localfirst" and "proxy" pass
 * config without credentials; callers must guard before signing.
 */
export const makeFixtureClient = (cfg: S3FixtureConfig): AwsClient | undefined => {
  if (!cfg.credentials) return undefined;
  return new AwsClient({
    accessKeyId: cfg.credentials.accessKeyId,
    secretAccessKey: cfg.credentials.secretAccessKey,
    region: cfg.region ?? "us-east-1",
    service: "s3",
  });
};

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

/**
 * `PUT {endpoint}/{bucket}?versioning` with the standard XML body.
 */
export const putBucketVersioningEnabled = async (
  client: AwsClient,
  endpoint: string,
  bucket: string,
): Promise<void> => {
  const body =
    `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
    `<Status>Enabled</Status></VersioningConfiguration>`;
  const res = await client.fetch(`${endpoint}/${bucket}?versioning`, {
    method: "PUT",
    body,
    headers: { "Content-Type": "application/xml" },
  });
  if (!res.ok) {
    throw new Error(`putBucketVersioning ${bucket}: ${res.status} ${await res.text()}`);
  }
};

/**
 * `GET {endpoint}/{bucket}/{key}`. Throws on non-2xx so the conformance
 * test's `try { … expect(false).toBe(true) } catch {}` pattern still works.
 */
export const getObject = async (
  client: AwsClient,
  endpoint: string,
  bucket: string,
  key: string,
): Promise<{ VersionId: string | null }> => {
  const res = await client.fetch(`${endpoint}/${bucket}/${encodeURIComponent(key)}`);
  if (!res.ok) {
    throw new Error(`getObject ${bucket}/${key}: ${res.status}`);
  }
  return { VersionId: res.headers.get("x-amz-version-id") };
};
