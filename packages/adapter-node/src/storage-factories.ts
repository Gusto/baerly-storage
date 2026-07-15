import type { Storage } from "@baerly/protocol";
import { S3HttpStorage } from "./s3-http.ts";
import { GcsHttpStorage } from "./gcs-http.ts";
import { refreshingSigner } from "./credentials/signer.ts";
import { goog4Signer } from "./credentials/goog4-signer.ts";
import type { Credentials, CredentialsProvider } from "./credentials/types.ts";

function buildS3Storage(opts: {
  endpoint: string;
  region: string;
  bucket: string;
  credentials: Credentials | CredentialsProvider;
}): Storage {
  const sign = refreshingSigner({ region: opts.region, credentials: opts.credentials });
  return new S3HttpStorage({ endpoint: opts.endpoint, bucket: opts.bucket, sign });
}

/**
 * AWS S3 `Storage` factory. Wraps `S3HttpStorage` with the standard
 * `aws4fetch` SigV4 signer. The endpoint is derived from the region as
 * `https://s3.<region>.amazonaws.com`.
 *
 * @example Static credentials
 * ```ts
 * import { s3Storage } from "@gusto/baerly-storage/node";
 *
 * const storage = s3Storage({
 *   region: process.env["AWS_REGION"] ?? "us-east-1",
 *   bucket: process.env["BUCKET"]!,
 *   credentials: {
 *     accessKeyId: process.env["AWS_ACCESS_KEY_ID"]!,
 *     secretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"]!,
 *   },
 * });
 * ```
 *
 * @example EKS (refreshing) — auto-detects Pod Identity or IRSA
 * ```ts
 * import { s3Storage, fromEks } from "@gusto/baerly-storage/node";
 *
 * const storage = s3Storage({
 *   region: process.env["AWS_REGION"] ?? "us-east-1",
 *   bucket: process.env["BUCKET"]!,
 *   credentials: fromEks(),
 * });
 * ```
 */
export function s3Storage(opts: {
  region: string;
  bucket: string;
  credentials: Credentials | CredentialsProvider;
}): Storage {
  return buildS3Storage({
    endpoint: `https://s3.${opts.region}.amazonaws.com`,
    region: opts.region,
    bucket: opts.bucket,
    credentials: opts.credentials,
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
 * import { r2Storage } from "@gusto/baerly-storage/node";
 *
 * const storage = r2Storage({
 *   accountId: process.env["R2_ACCOUNT_ID"]!,
 *   bucket: process.env["BUCKET"]!,
 *   credentials: {
 *     accessKeyId: process.env["AWS_ACCESS_KEY_ID"]!,
 *     secretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"]!,
 *   },
 * });
 * ```
 */
export function r2Storage(opts: {
  accountId: string;
  bucket: string;
  credentials: Credentials | CredentialsProvider;
}): Storage {
  return buildS3Storage({
    endpoint: `https://${opts.accountId}.r2.cloudflarestorage.com`,
    region: "auto",
    bucket: opts.bucket,
    credentials: opts.credentials,
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
 * import { minioStorage } from "@gusto/baerly-storage/node";
 *
 * const storage = minioStorage({
 *   endpoint: process.env["BAERLY_S3_ENDPOINT"] ?? "http://localhost:9102",
 *   bucket: "baerly",
 *   credentials: {
 *     accessKeyId: process.env["MINIO_ACCESS_KEY"]!,
 *     secretAccessKey: process.env["MINIO_SECRET_KEY"]!,
 *   },
 * });
 * ```
 */
export function minioStorage(opts: {
  endpoint: string;
  bucket: string;
  credentials: Credentials | CredentialsProvider;
}): Storage {
  return buildS3Storage({
    endpoint: opts.endpoint,
    region: "us-east-1",
    bucket: opts.bucket,
    credentials: opts.credentials,
  });
}

/**
 * Google Cloud Storage `Storage` factory over the native GCS XML API
 * at `https://storage.googleapis.com`. Wraps {@link GcsHttpStorage} with
 * a GOOG4-HMAC-SHA256 signer, driving GCS's own generation-precondition
 * conditional writes (`x-goog-if-generation-match: 0` for create-if-absent,
 * `x-goog-if-generation-match: <generation>` for compare-and-swap), which
 * return `412` on a lost write. The object `generation` is carried verbatim
 * as the opaque `Storage` etag. This is the sanctioned GCS path — the
 * S3-interop endpoint treats `If-Match`/`If-None-Match` as read-scoped only
 * and cannot linearize the log, so it is not supported.
 *
 * Authentication uses GCS HMAC keys (Console → Settings → Interoperability)
 * — mint an interop key, put the HMAC access key in `credentials.accessKeyId`
 * and the HMAC secret in `credentials.secretAccessKey`.
 *
 * @example
 * ```ts
 * import { gcsStorage } from "@gusto/baerly-storage/node";
 *
 * const storage = gcsStorage({
 *   bucket: process.env["BUCKET"]!,
 *   credentials: {
 *     accessKeyId: process.env["GCS_HMAC_ACCESS_KEY_ID"]!,
 *     secretAccessKey: process.env["GCS_HMAC_SECRET"]!,
 *   },
 * });
 * ```
 */
export function gcsStorage(opts: {
  bucket: string;
  credentials: Credentials | CredentialsProvider;
  /** GCS endpoint. Defaults to `https://storage.googleapis.com`. */
  endpoint?: string;
}): Storage {
  const sign = goog4Signer({ credentials: opts.credentials });
  return new GcsHttpStorage({
    bucket: opts.bucket,
    sign,
    ...(opts.endpoint !== undefined && { endpoint: opts.endpoint }),
  });
}
