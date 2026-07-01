import { BaerlyError } from "@baerly/protocol";
import { AwsClient } from "aws4fetch";

/**
 * Static-credential inputs for {@link sigV4Signer}.
 */
export interface SigV4SignerOptions {
  // Typed `string | undefined`, not `string`: the documented usage feeds
  // these straight from a Worker `env` / `process.env`, where an absent key
  // is `undefined` at runtime even when the ambient env type claims `string`.
  // The keys stay required (so a caller can't silently omit one), but the
  // value may be absent — `sigV4Signer` fail-closes on absent/blank below.
  /** AWS access key id (or R2 / Minio equivalent). */
  accessKeyId: string | undefined;
  /** AWS secret access key (or R2 / Minio equivalent). */
  secretAccessKey: string | undefined;
  /**
   * Region, e.g. `"us-east-1"`. R2 ignores the value but `aws4fetch`
   * requires one — use `"auto"` for R2's S3-compat endpoint.
   */
  region: string | undefined;
  /** Optional STS session token for temporary credentials. */
  sessionToken?: string;
}

/**
 * Static-credential SigV4 signer for {@link S3HttpStorage}, safe inside
 * a Cloudflare Worker: `aws4fetch` signs with WebCrypto, so there is no
 * `node:crypto` in the closure. Returns the `(req) => Promise<Request>`
 * seam `S3HttpStorageOptions.sign` expects.
 *
 * For rotating credentials, pass your own `(req) => Promise<Request>`
 * to `S3HttpStorage` instead — this helper covers the static case.
 *
 * @example
 * ```ts
 * import { S3HttpStorage, sigV4Signer } from "@gusto/baerly-storage/s3";
 *
 * const storage = new S3HttpStorage({
 *   endpoint: env.S3_ENDPOINT,
 *   bucket: env.S3_BUCKET,
 *   sign: sigV4Signer({
 *     accessKeyId: env.AWS_ACCESS_KEY_ID,
 *     secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
 *     region: env.AWS_REGION,
 *   }),
 * });
 * ```
 */
export function sigV4Signer(opts: SigV4SignerOptions): (req: Request) => Promise<Request> {
  // Fail fast on blank credentials. A wrangler `var` declared but left
  // empty resolves to "" — without this guard aws4fetch signs with empty
  // creds and the endpoint answers an opaque 403 on the first request,
  // far from the misconfig. Mirrors the fail-closed contract on
  // `resolveWorkerStorage` and `sharedSecret` (empty `SHARED_SECRET`).
  //
  // Coalesce-then-trim once, then both validate AND sign with the trimmed
  // values. A `var`/env key declared *nowhere* resolves to `undefined` at
  // runtime — the most common misconfig — and a bare `.trim()` on it throws
  // a raw `TypeError` more opaque than the 403 this guard exists to prevent;
  // `?? ""` routes absent and blank alike into the fail-closed check.
  // Trimming catches a whitespace-only value (`" "`, `"\t\n"`), truthy in JS
  // but signing-blank in effect, and — critically — feeds the *trimmed*
  // value to `AwsClient`: a stray leading/trailing space on an otherwise
  // valid credential (a copy-paste artifact) would otherwise pass the guard
  // yet sign with the padded value, producing an invalid signature and the
  // same opaque 403. `region` gets the same treatment — an empty region
  // yields a malformed SigV4 scope (`YYYYMMDD//s3/aws4_request`).
  const accessKeyId = (opts.accessKeyId ?? "").trim();
  const secretAccessKey = (opts.secretAccessKey ?? "").trim();
  const region = (opts.region ?? "").trim();
  if (!accessKeyId || !secretAccessKey || !region) {
    throw new BaerlyError(
      "InvalidConfig",
      "sigV4Signer: `accessKeyId`, `secretAccessKey`, and `region` must be " +
        "non-empty. Check the credentials passed from your Worker `env` / " +
        "process env.",
    );
  }
  const client = new AwsClient({
    accessKeyId,
    secretAccessKey,
    sessionToken: opts.sessionToken,
    region,
    service: "s3",
  });
  return (req: Request) => client.sign(req);
}
