import { DOMParser } from "@xmldom/xmldom";
import { AwsClient } from "aws4fetch";
import { S3HttpStorage, type Storage } from "@baerly/protocol";

/**
 * AWS S3 `Storage` factory. Wraps `S3HttpStorage` with the standard
 * `aws4fetch` SigV4 signer and the `@xmldom/xmldom` DOMParser. The
 * endpoint is derived from the region as
 * `https://s3.<region>.amazonaws.com`.
 *
 * @example
 * ```ts
 * import { s3Storage } from "@baerly/adapter-node";
 *
 * const storage = s3Storage({
 *   region: process.env.AWS_REGION ?? "us-east-1",
 *   bucket: process.env.BUCKET!,
 *   accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
 *   secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
 * });
 * ```
 */
export function s3Storage(opts: {
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): Storage {
  const aws = new AwsClient({
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    region: opts.region,
    service: "s3",
  });
  return new S3HttpStorage({
    endpoint: `https://s3.${opts.region}.amazonaws.com`,
    bucket: opts.bucket,
    xmlParser: new DOMParser(),
    sign: (req) => aws.sign(req),
  });
}

/**
 * Cloudflare R2 `Storage` factory (S3-compat endpoint). Derives the
 * endpoint from `accountId` as
 * `https://<accountId>.r2.cloudflarestorage.com` and pins region
 * `"auto"` — R2 ignores region but `aws4fetch`'s signer requires
 * the field to be set.
 *
 * For Workers that have a native R2 binding (no HTTP hop), see
 * `r2BindingStorage` in `@baerly/adapter-cloudflare`. This factory
 * is for Node hosts that talk to R2 over its public S3-compat URL.
 *
 * @example
 * ```ts
 * import { r2Storage } from "@baerly/adapter-node";
 *
 * const storage = r2Storage({
 *   accountId: process.env.R2_ACCOUNT_ID!,
 *   bucket: process.env.BUCKET!,
 *   accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
 *   secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
 * });
 * ```
 */
export function r2Storage(opts: {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): Storage {
  const aws = new AwsClient({
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    region: "auto",
    service: "s3",
  });
  return new S3HttpStorage({
    endpoint: `https://${opts.accountId}.r2.cloudflarestorage.com`,
    bucket: opts.bucket,
    xmlParser: new DOMParser(),
    sign: (req) => aws.sign(req),
  });
}

/**
 * Minio `Storage` factory — for local-dev / self-hosted S3-compat.
 * Endpoint is fully caller-supplied (e.g. `http://localhost:9102`)
 * because Minio deployments don't follow a URL template. Region is
 * pinned to `"us-east-1"`; Minio ignores it but `aws4fetch` requires
 * a value.
 *
 * @example
 * ```ts
 * import { minioStorage } from "@baerly/adapter-node";
 *
 * const storage = minioStorage({
 *   endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9102",
 *   bucket: "baerly",
 *   accessKeyId: process.env.MINIO_ACCESS_KEY!,
 *   secretAccessKey: process.env.MINIO_SECRET_KEY!,
 * });
 * ```
 */
export function minioStorage(opts: {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): Storage {
  const aws = new AwsClient({
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    region: "us-east-1",
    service: "s3",
  });
  return new S3HttpStorage({
    endpoint: opts.endpoint,
    bucket: opts.bucket,
    xmlParser: new DOMParser(),
    sign: (req) => aws.sign(req),
  });
}

/**
 * Google Cloud Storage `Storage` factory via the S3-compat endpoint
 * at `https://storage.googleapis.com`. Authentication uses GCS HMAC
 * keys (Console → Settings → Interoperability). Region is pinned to
 * `"auto"`.
 *
 * GCS's S3-compat surface supports the four `Storage` methods
 * (`get`/`put`/`delete`/`list`) but not all of S3's optional
 * features — stick to the kernel surface and you're fine.
 *
 * @example
 * ```ts
 * import { gcsStorage } from "@baerly/adapter-node";
 *
 * const storage = gcsStorage({
 *   bucket: process.env.BUCKET!,
 *   hmacAccessKeyId: process.env.GCS_HMAC_ACCESS_KEY_ID!,
 *   hmacSecret: process.env.GCS_HMAC_SECRET!,
 * });
 * ```
 */
export function gcsStorage(opts: {
  bucket: string;
  hmacAccessKeyId: string;
  hmacSecret: string;
}): Storage {
  const aws = new AwsClient({
    accessKeyId: opts.hmacAccessKeyId,
    secretAccessKey: opts.hmacSecret,
    region: "auto",
    service: "s3",
  });
  return new S3HttpStorage({
    endpoint: "https://storage.googleapis.com",
    bucket: opts.bucket,
    xmlParser: new DOMParser(),
    sign: (req) => aws.sign(req),
  });
}
