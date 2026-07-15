/**
 * Shape of a `credentials/<provider>.json` file (gitignored) consumed by
 * the credential-gated integration + bench suites. Unifies what was
 * duplicated as `EndpointCreds` (conformance) and `GcsCreds` (randomized,
 * bench) — all three parse the same file shape.
 *
 * `endpoint` / `region` drive the S3-family endpoints (aws / minio / R2);
 * the native `gcsStorage` ignores them (it pins the GCS XML-API host and
 * signs with GOOG4), so on the GCS path only `bucket` + `credentials`
 * are read.
 */
export interface EndpointCreds {
  endpoint: string;
  region: string;
  bucket: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Read `credentials/<file>` and parse it as {@link EndpointCreds}, or
 * return `null` when the file is absent/unreadable (the standard
 * credential-gated skip signal). Callers that want a hard failure on a
 * present-but-broken file should read + parse inline instead.
 */
export async function loadEndpointCreds(file: string): Promise<EndpointCreds | null> {
  try {
    const raw = await readFile(join("credentials", file), "utf8");
    return JSON.parse(raw) as EndpointCreds;
  } catch {
    return null;
  }
}
