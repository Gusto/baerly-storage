/**
 * Bucket URI parsing for the CLI surface. Consumed by every
 * `baerly admin <cmd>`, `baerly inspect`, and `baerly export`.
 *
 * Grammar:
 *   - `s3://<bucket>[/<prefix>]` — S3-compatible HTTP. Creds via env
 *     vars (`BAERLY_S3_ENDPOINT`, `BAERLY_S3_ACCESS_KEY_ID`,
 *     `BAERLY_S3_SECRET_ACCESS_KEY`, `BAERLY_S3_REGION` — region
 *     defaults to `us-east-1`).
 *   - `file:///<absolute-path>` — `LocalFsStorage` rooted at the path.
 *     Relative paths are rejected by the three-slash prefix.
 *   - `memory://<bucket>` — `MemoryStorage` keyed via
 *     `getOrCreateMemoryStorageForBucket`. Test-only.
 */

import { LocalFsStorage } from "@baerly/dev";
import { minioStorage, r2Storage, s3Storage } from "@baerly/adapter-node";
import { BaerlyError, getOrCreateMemoryStorageForBucket, type Storage } from "@baerly/protocol";

/**
 * Result of `parseBucketUri`. `storage` is a constructed `Storage`
 * handle; `keyPrefix` is "" for an unprefixed bucket, or a non-empty
 * string ending in `/` for a prefixed one. The target side prepends
 * this to every emitted key.
 */
export interface ParsedBucketUri {
  storage: Storage;
  /** Empty for no-prefix; non-empty always ends with "/". */
  keyPrefix: string;
}

/**
 * Parse a bucket URI into a constructed `Storage` handle + optional
 * key prefix.
 *
 * @throws BaerlyError code="InvalidConfig" — unsupported scheme, or an
 *   `s3://` URI with a missing env var.
 */
export const parseBucketUri = async (uri: string): Promise<ParsedBucketUri> => {
  if (uri.startsWith("s3://")) {
    const rest = uri.slice(5);
    const slash = rest.indexOf("/");
    const bucket = slash === -1 ? rest : rest.slice(0, slash);
    const prefix = slash === -1 ? "" : rest.slice(slash + 1);
    if (bucket.length === 0) {
      throw new BaerlyError(
        "InvalidConfig",
        `bucket URI: s3:// URI requires a bucket name (got ${JSON.stringify(uri)})`,
      );
    }
    const accessKeyId = requireEnv("BAERLY_S3_ACCESS_KEY_ID");
    const secretAccessKey = requireEnv("BAERLY_S3_SECRET_ACCESS_KEY");
    const region = process.env["BAERLY_S3_REGION"] ?? "us-east-1";
    const endpoint = requireEnv("BAERLY_S3_ENDPOINT");
    // Endpoint-pattern dispatch. AWS-shaped → `s3Storage`; R2-shaped →
    // `r2Storage`; anything else (user-supplied / Minio) → `minioStorage`
    // so the full endpoint flows through verbatim.
    const r2Host = endpoint.match(/^https?:\/\/([^./]+)\.r2\.cloudflarestorage\.com\b/i);
    const isAws = /^https?:\/\/s3(\.[^.]+)?\.amazonaws\.com\b/i.test(endpoint);
    const storage: Storage = pickS3Storage({
      r2Host,
      isAws,
      endpoint,
      bucket,
      accessKeyId,
      secretAccessKey,
      region,
    });
    return {
      storage,
      keyPrefix: normalizeKeyPrefix(prefix),
    };
  }
  if (uri.startsWith("file:///")) {
    return { storage: new LocalFsStorage({ root: uri.slice(7) }), keyPrefix: "" };
  }
  if (uri.startsWith("memory://")) {
    const bucket = uri.slice(9);
    if (bucket.length === 0) {
      throw new BaerlyError(
        "InvalidConfig",
        `bucket URI: memory:// URI requires a bucket name (got ${JSON.stringify(uri)})`,
      );
    }
    return { storage: getOrCreateMemoryStorageForBucket(bucket), keyPrefix: "" };
  }
  throw new BaerlyError("InvalidConfig", `bucket URI: unsupported URI ${JSON.stringify(uri)}`);
};

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new BaerlyError("InvalidConfig", `bucket URI: env var ${name} unset`);
  }
  return v;
};

// Endpoint-shape dispatch for `s3://...` URIs. Extracted so the parser
// doesn't carry an inline nested ternary.
interface S3StoragePick {
  readonly r2Host: RegExpMatchArray | null;
  readonly isAws: boolean;
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
}
const pickS3Storage = (opts: S3StoragePick): Storage => {
  const { r2Host, isAws, endpoint, bucket, accessKeyId, secretAccessKey, region } = opts;
  if (r2Host !== null) {
    return r2Storage({
      accountId: r2Host[1]!,
      bucket,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  if (isAws) {
    return s3Storage({ region, bucket, credentials: { accessKeyId, secretAccessKey } });
  }
  return minioStorage({ endpoint, bucket, credentials: { accessKeyId, secretAccessKey } });
};

// "/foo" → "foo/"; "" → ""; "foo/" stays "foo/". S3 prefixes are
// keystroke-significant; canonicalize to ensure the manifest pointer
// at the target matches its source's encoding.
const normalizeKeyPrefix = (prefix: string): string => {
  if (prefix === "") {
    return "";
  }
  if (prefix.endsWith("/")) {
    return prefix;
  }
  return `${prefix}/`;
};
