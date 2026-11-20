import { sha256Hex } from "@baerly/protocol";
import type { Credentials, CredentialsProvider } from "./types.ts";
import { credentialResolver } from "./resolve.ts";

/** GOOG4 signing-key prefix (vs AWS SigV4's "AWS4"). @see https://docs.cloud.google.com/storage/docs/authentication/signatures */
const GOOG4_KEY_PREFIX = "GOOG4";
/** Credential-scope terminator (vs SigV4's "aws4_request"). @see https://docs.cloud.google.com/storage/docs/authentication/signatures */
const GOOG4_REQUEST = "goog4_request";
/** Signing algorithm string. @see https://docs.cloud.google.com/storage/docs/authentication/signatures */
const GOOG4_ALGORITHM = "GOOG4-HMAC-SHA256";
/** GCS storage service name in the credential scope (vs SigV4's "s3"). @see https://docs.cloud.google.com/storage/docs/authentication/signatures */
const GOOG4_SERVICE = "storage";
/** GCS accepts "auto" as the signing region. @see https://docs.cloud.google.com/storage/docs/authentication/signatures */
const GOOG4_REGION = "auto";

const encoder = new TextEncoder();

// SHA-256 hex comes from `@baerly/protocol` (shared with snapshotHash /
// versionFromContent).

/** RFC-3986-strict percent-encoding for canonical query components: encodes
 * everything except the unreserved set A-Za-z0-9-._~. encodeURIComponent
 * already handles that set but leaves !'()* unescaped, so escape those too.
 * @see https://docs.cloud.google.com/storage/docs/authentication/canonical-requests */
function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Canonical-URI encoding for the request path. `URL.pathname` already
 * percent-encodes spaces / non-ASCII / control chars (and `^` `` ` `` `{` `}`),
 * but leaves GCS's enumerated reserved set raw — the sub-delims, `:@`, and
 * `[]`. GCS canonicalizes the path it receives by percent-encoding exactly
 * that set (`?=!#$&'()*+,:;@[]"`; `?#"` can't survive in `pathname`), so we
 * must reproduce the same delta or a `[`/`]`-bearing key signs differently
 * than GCS computes it (403 SignatureDoesNotMatch). Target only the delta so
 * already-encoded `%XX` and the unreserved set stay intact (no double-encode).
 * This is a denylist, not an allow-list, on purpose: over-encoding chars GCS
 * leaves raw (`|` `` ` `` `{}` …) would itself cause a mismatch.
 * @see https://docs.cloud.google.com/storage/docs/authentication/canonical-requests */
function canonicalUri(pathname: string): string {
  return pathname.replace(
    /[!$&'()*+,;=:@[\]]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const view = new Uint8Array(key.byteLength);
  view.set(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    view,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
  return new Uint8Array(sig);
}

/** SHA-256 hex of the empty payload: the `x-goog-content-sha256` of a bodyless request. @see https://docs.cloud.google.com/storage/docs/authentication/canonical-requests */
const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** The GOOG4 signing key for one secret and UTC day, imported once for reuse.
 * Same key chain as {@link sigV4Signature}, which stays the uncached oracle. */
async function importSigningKey(secretAccessKey: string, yyyymmdd: string): Promise<CryptoKey> {
  const dateKey = await hmac(encoder.encode(GOOG4_KEY_PREFIX + secretAccessKey), yyyymmdd);
  const dateRegionKey = await hmac(dateKey, GOOG4_REGION);
  const dateSvcKey = await hmac(dateRegionKey, GOOG4_SERVICE);
  const signingKey = await hmac(dateSvcKey, GOOG4_REQUEST);
  return crypto.subtle.importKey("raw", signingKey, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

/** Pure: build the GOOG4 canonical request string. Exported for the intermediates test. */
export function goog4CanonicalRequest(input: {
  method: string;
  url: string;
  signedHeaders: Record<string, string>;
  hashedPayload: string;
}): string {
  const u = new URL(input.url);
  // Normalize to lowercase keys once, so the sort order and the value lookup
  // agree even if a caller passes mixed-case header names (`{ Host: ... }`).
  // The internal caller already lowercases via `Headers` iteration, but this
  // function is also exported for the intermediates test — normalizing here
  // makes the lowercase-key invariant guaranteed rather than assumed.
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.signedHeaders)) {
    normalized[name.toLowerCase()] = value;
  }
  const names = Object.keys(normalized).toSorted();
  const canonicalHeaders = names.map((n) => `${n}:${normalized[n]!.trim()}\n`).join("");
  const signedHeaderList = names.join(";");
  // Sort by encoded key then encoded value; a "key\0value" join makes the pair
  // orderable with a single string comparison (avoids a nested ternary).
  const query = [...u.searchParams]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .toSorted((a, b) => {
      const ka = `${a[0]}\0${a[1]}`;
      const kb = `${b[0]}\0${b[1]}`;
      if (ka < kb) {
        return -1;
      }
      return ka > kb ? 1 : 0;
    })
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return [
    input.method,
    canonicalUri(u.pathname), // percent-encoded by URL, plus sub-delims/:@ per GOOG4
    query,
    canonicalHeaders, // trailing \n included per entry; joined below with \n
    signedHeaderList,
    input.hashedPayload,
  ].join("\n");
}

/** Pure: build the SigV4-family string-to-sign. Async because it hashes the canonical request. */
export async function goog4StringToSign(input: {
  algorithm: string;
  amzDate: string;
  scope: string;
  canonicalRequest: string;
}): Promise<string> {
  const hash = await sha256Hex(encoder.encode(input.canonicalRequest));
  return [input.algorithm, input.amzDate, input.scope, hash].join("\n");
}

/**
 * The SigV4-family signing machinery: four-stage HMAC key chain + final HMAC.
 * Identical between GOOG4 and AWS SigV4 modulo the {keyPrefix, terminator,
 * service, region} constants — which is exactly what the AWS-vector oracle
 * exploits to prove this in CI. Exported for oracle 1 and as the uncached
 * reference that `goog4Signer`'s cached signing key is tested against.
 */
export async function sigV4Signature(input: {
  keyPrefix: string;
  terminator: string;
  service: string;
  region: string;
  secretAccessKey: string;
  yyyymmdd: string;
  stringToSign: string;
}): Promise<string> {
  const dateKey = await hmac(
    encoder.encode(input.keyPrefix + input.secretAccessKey),
    input.yyyymmdd,
  );
  const dateRegionKey = await hmac(dateKey, input.region);
  const dateSvcKey = await hmac(dateRegionKey, input.service);
  const signingKey = await hmac(dateSvcKey, input.terminator);
  const signature = await hmac(signingKey, input.stringToSign);
  return signature.toHex();
}

function amzDateFrom(ms: number): { amzDate: string; yyyymmdd: string } {
  const iso = new Date(ms).toISOString(); // 2025-01-01T00:00:00.000Z
  const amzDate = iso.replace(/[:-]/g, "").replace(/\.\d{3}Z$/, "Z"); // 20250101T000000Z
  return { amzDate, yyyymmdd: amzDate.slice(0, 8) };
}

/**
 * Inputs for {@link goog4Signer}. Named for parity with
 * `SigV4SignerOptions` so both signer families read the same on the
 * curated `/s3` + `/gcs` subpaths.
 */
export interface Goog4SignerOptions {
  /** GCS HMAC interoperability credentials (static) or an async resolver. */
  credentials: Credentials | CredentialsProvider;
  /** Clock seam for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
}

export function goog4Signer(opts: Goog4SignerOptions): (req: Request) => Promise<Request> {
  const now = opts.now ?? (() => Date.now());
  const resolve = credentialResolver(opts.credentials, now, (creds) => creds);

  // The derived signing key depends only on the secret and the UTC day, so
  // each signer keeps the one it last used (a key cache like aws4fetch's per
  // `AwsClient`). Per closure, not module-wide: two signers with different
  // credentials never evict each other, and the secret stays in the closure
  // that already holds it. A rejected derivation is dropped, so the next call
  // derives again rather than failing until the day rolls over.
  let cachedKey: { secret: string; yyyymmdd: string; key: Promise<CryptoKey> } | undefined;
  const signingKeyFor = (secret: string, yyyymmdd: string): Promise<CryptoKey> => {
    if (cachedKey?.secret === secret && cachedKey.yyyymmdd === yyyymmdd) {
      return cachedKey.key;
    }
    const entry = { secret, yyyymmdd, key: importSigningKey(secret, yyyymmdd) };
    cachedKey = entry;
    entry.key.catch(() => {
      if (cachedKey === entry) {
        cachedKey = undefined;
      }
    });
    return entry.key;
  };

  return async (req) => {
    const creds = await resolve();
    const { amzDate, yyyymmdd } = amzDateFrom(now());
    const scope = `${yyyymmdd}/${GOOG4_REGION}/${GOOG4_SERVICE}/${GOOG4_REQUEST}`;

    // Only a null body is bodyless (GET, DELETE, LIST). An empty-body PUT
    // still has a body stream and takes the read-and-hash path.
    const payloadHash =
      req.body === null
        ? EMPTY_PAYLOAD_SHA256
        : await sha256Hex(new Uint8Array(await req.clone().arrayBuffer()));

    const url = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.set("host", url.host);
    headers.set("x-goog-date", amzDate);
    headers.set("x-goog-content-sha256", payloadHash);
    // No session-token header: GCS HMAC interoperability keys are long-lived
    // (access-ID + secret) with no STS-style temporary-credential concept, and
    // GCS documents no header analogous to AWS's x-amz-security-token. A
    // `sessionToken` on the shared Credentials shape (set by the AWS providers)
    // is therefore intentionally ignored here rather than signed into a
    // fabricated x-goog-security-token header.
    // @see https://docs.cloud.google.com/storage/docs/authentication/signatures

    // SignedHeaders MUST be computed dynamically from the request — this is the
    // load-bearing correctness point. GCS rejects (403 SignatureDoesNotMatch)
    // any x-goog-* header on the wire that is absent from SignedHeaders, and the
    // transport sets x-goog-if-generation-match BEFORE calling sign().
    // A fixed list would leave the precondition header unsigned → every
    // conditional write (the whole commit path) fails, while a bodyless GET
    // still passes — so this bug hides from any smoke test that does not
    // exercise a conditional PUT. Scan the actual request headers instead.
    const signedHeaders: Record<string, string> = {};
    for (const [name, value] of headers) {
      const lower = name.toLowerCase();
      if (lower === "host" || lower === "content-type" || lower.startsWith("x-goog-")) {
        signedHeaders[lower] = value;
      }
    }

    const canonical = goog4CanonicalRequest({
      method: req.method,
      url: req.url,
      signedHeaders,
      hashedPayload: payloadHash,
    });
    const stringToSign = await goog4StringToSign({
      algorithm: GOOG4_ALGORITHM,
      amzDate,
      scope,
      canonicalRequest: canonical,
    });
    const signingKey = await signingKeyFor(creds.secretAccessKey, yyyymmdd);
    const signature = new Uint8Array(
      await crypto.subtle.sign("HMAC", signingKey, encoder.encode(stringToSign)),
    ).toHex();

    const signedHeaderList = Object.keys(signedHeaders)
      .map((n) => n.toLowerCase())
      .toSorted()
      .join(";");
    headers.set(
      "Authorization",
      `${GOOG4_ALGORITHM} Credential=${creds.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaderList}, Signature=${signature}`,
    );
    return new Request(req, { headers });
  };
}
