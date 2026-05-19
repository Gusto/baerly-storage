import { BaerlyError, type Verifier } from "@baerly/protocol";
import { timingSafeEqual } from "../internal/timing-safe-equal.ts";

/**
 * Options for {@link awsIamSigV4}.
 *
 * - `principals` — `{ accessKeyId, secretAccessKey, tenantPrefix,
 *   identity? }[]`. The verifier looks up the inbound `Credential`
 *   scope's access-key-id against this list. Each entry pins one
 *   IAM principal to one tenant.
 * - `service` — AWS service name in the signature scope. The
 *   verifier rejects requests whose scope's service component
 *   differs. Defaults to `"execute-api"`.
 * - `region` — AWS region. Defaults to `"us-east-1"`.
 * - `clockSkewMs` — `X-Amz-Date` skew tolerance. Defaults to
 *   300 000 (5 min — matches AWS's own SigV4 docs).
 */
export interface AwsIamSigV4Options {
  readonly principals: readonly AwsIamPrincipal[];
  readonly service?: string;
  readonly region?: string;
  readonly clockSkewMs?: number;
}

/**
 * One IAM principal authorized to call this service. The verifier
 * looks up inbound requests' access-key-id in this list; the
 * matching entry's `tenantPrefix` is returned in the
 * `VerifierResult`.
 */
export interface AwsIamPrincipal {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly tenantPrefix: string;
  readonly identity?: unknown;
}

const DEFAULT_SERVICE = "execute-api";
const DEFAULT_REGION = "us-east-1";
const DEFAULT_CLOCK_SKEW_MS = 300_000;
/** Hard cap on the body bytes the verifier will buffer before
 * hashing. Signed streaming requests (`STREAMING-AWS4-HMAC-SHA256-PAYLOAD`)
 * are unsupported; anything that would push past this limit is
 * surfaced as `InvalidConfig`. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const AUTH_REGEX =
  /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request,\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]+)$/;

/**
 * Build a `Verifier` that accepts requests signed with AWS SigV4 and
 * resolves the tenant from a pre-shared principal table.
 *
 * Verification steps, in order:
 * 1. Parse the `Authorization` header into
 *    `Credential=<keyId>/<date>/<region>/<service>/aws4_request,
 *    SignedHeaders=<list>, Signature=<hex>`. Malformed → null.
 * 2. Look up `keyId` in `principals`. Missing → null (saves a
 *    round-trip on garbage traffic).
 * 3. Check `X-Amz-Date` is within `clockSkewMs` of now. Outside →
 *    null.
 * 4. Check the scope's `region` / `service` match the configured
 *    values. Mismatch → null.
 * 5. Rebuild the canonical request from the inbound `method`, `url`,
 *    listed `SignedHeaders`, and the buffered body. SHA-256 hash
 *    the body (or honor `X-Amz-Content-Sha256` if present, including
 *    the `UNSIGNED-PAYLOAD` sentinel that `aws4fetch` emits for S3).
 * 6. Derive the signing key from the principal's secret:
 *    `HMAC(HMAC(HMAC(HMAC("AWS4" + secret, date), region), service),
 *    "aws4_request")`. Recompute the signature; constant-time
 *    compare. Mismatch → null.
 * 7. Return `{ tenantPrefix, identity: principal.identity ?? {
 *    accessKeyId } }`.
 *
 * **Body hash.** SigV4 requires the body to be hashed. The verifier
 * reads `req.body` exactly once via `req.clone()` so the upstream
 * router still sees an unread body. For streaming bodies the
 * verifier buffers up to 8 MiB; larger bodies surface as
 * `BaerlyError{code:"InvalidConfig"}` (signed streaming requires
 * AWS's `STREAMING-AWS4-HMAC-SHA256-PAYLOAD` mode which we don't
 * support).
 *
 * @throws BaerlyError code="InvalidConfig" — empty `principals`,
 *   duplicate `accessKeyId`, principal with empty `tenantPrefix` or
 *   `tenantPrefix` containing `/`, body exceeding 8 MiB.
 *
 * @example
 * ```ts
 * import { awsIamSigV4 } from "baerly-storage/auth";
 * const verifier = awsIamSigV4({
 *   principals: [{
 *     accessKeyId: env.PEER_AWS_ACCESS_KEY_ID,
 *     secretAccessKey: env.PEER_AWS_SECRET_ACCESS_KEY,
 *     tenantPrefix: "internal-svc-a",
 *   }],
 *   service: "execute-api",
 *   region: "us-east-1",
 * });
 * ```
 */
export const awsIamSigV4 = (opts: AwsIamSigV4Options): Verifier => {
  if (opts.principals.length === 0) {
    throw new BaerlyError("InvalidConfig", "awsIamSigV4: principals must be non-empty");
  }
  const byKeyId = new Map<string, AwsIamPrincipal>();
  for (const p of opts.principals) {
    if (p.accessKeyId.length === 0) {
      throw new BaerlyError(
        "InvalidConfig",
        "awsIamSigV4: principal accessKeyId must be non-empty",
      );
    }
    if (p.tenantPrefix.length === 0 || p.tenantPrefix.includes("/")) {
      throw new BaerlyError(
        "InvalidConfig",
        `awsIamSigV4: principal tenantPrefix must be non-empty and "/"-free (got ${JSON.stringify(
          p.tenantPrefix,
        )})`,
      );
    }
    if (byKeyId.has(p.accessKeyId)) {
      throw new BaerlyError(
        "InvalidConfig",
        `awsIamSigV4: duplicate accessKeyId ${JSON.stringify(p.accessKeyId)} in principals`,
      );
    }
    byKeyId.set(p.accessKeyId, p);
  }
  const service = opts.service ?? DEFAULT_SERVICE;
  const region = opts.region ?? DEFAULT_REGION;
  const clockSkewMs = opts.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;

  return async (req: Request) => {
    const auth = req.headers.get("Authorization");
    if (auth === null) {
      return null;
    }
    const m = AUTH_REGEX.exec(auth);
    if (m === null) {
      return null;
    }
    const [, keyId, scopeDate, scopeRegion, scopeService, signedHeadersList, sigHex] =
      m as unknown as [string, string, string, string, string, string, string];
    const principal = byKeyId.get(keyId);
    if (principal === undefined) {
      return null;
    }
    if (scopeRegion !== region || scopeService !== service) {
      return null;
    }

    const amzDate = req.headers.get("X-Amz-Date");
    if (amzDate === null) {
      return null;
    }
    const datetime = parseAmzDate(amzDate);
    if (datetime === null) {
      return null;
    }
    if (Math.abs(Date.now() - datetime) > clockSkewMs) {
      return null;
    }
    if (amzDate.slice(0, 8) !== scopeDate) {
      return null;
    }

    const signedHeaders = signedHeadersList.split(";");
    const url = new URL(req.url);
    const canonicalHeaders = buildCanonicalHeaders(req.headers, signedHeaders, url.host);
    if (canonicalHeaders === null) {
      return null;
    }

    const bodyHash = await computeBodyHash(req);
    if (bodyHash === null) {
      throw new BaerlyError(
        "InvalidConfig",
        "awsIamSigV4: signed request body exceeds 8 MiB; streaming SigV4 unsupported",
      );
    }

    const canonicalString = [
      req.method.toUpperCase(),
      encodePath(url.pathname),
      canonicalQueryString(url.searchParams),
      `${canonicalHeaders}\n`,
      signedHeadersList,
      bodyHash,
    ].join("\n");

    const credentialString = `${scopeDate}/${region}/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialString,
      bufToHex(await sha256(new TextEncoder().encode(canonicalString))),
    ].join("\n");

    const kDate = await hmac(utf8(`AWS4${principal.secretAccessKey}`), scopeDate);
    const kRegion = await hmac(kDate, region);
    const kService = await hmac(kRegion, service);
    const kSigning = await hmac(kService, "aws4_request");
    const expectedSigBytes = new Uint8Array(await hmac(kSigning, stringToSign));
    const actualSigBytes = hexToBytes(sigHex);
    if (actualSigBytes === null) {
      return null;
    }
    if (!timingSafeEqual(expectedSigBytes, actualSigBytes)) {
      return null;
    }

    return {
      tenantPrefix: principal.tenantPrefix,
      identity: principal.identity ?? { accessKeyId: principal.accessKeyId },
    };
  };
};

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const toArrayBufferCopy = (bytes: Uint8Array): ArrayBuffer => {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
};

const sha256 = async (bytes: Uint8Array): Promise<ArrayBuffer> =>
  crypto.subtle.digest("SHA-256", toArrayBufferCopy(bytes));

const hmac = async (key: Uint8Array | ArrayBuffer, data: string): Promise<ArrayBuffer> => {
  const keyBytes = key instanceof Uint8Array ? toArrayBufferCopy(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, toArrayBufferCopy(utf8(data)));
};

const HEX_CHARS = "0123456789abcdef";
const bufToHex = (buf: ArrayBuffer): string => {
  const view = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    const n = view[i]!;
    out += HEX_CHARS.charAt((n >>> 4) & 0xf) + HEX_CHARS.charAt(n & 0xf);
  }
  return out;
};

const hexToBytes = (hex: string): Uint8Array | null => {
  if (hex.length % 2 !== 0) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = parseHexNibble(hex.charCodeAt(i * 2));
    const lo = parseHexNibble(hex.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) {
      return null;
    }
    out[i] = (hi << 4) | lo;
  }
  return out;
};

const parseHexNibble = (code: number): number => {
  if (code >= 48 && code <= 57) {
    return code - 48;
  } // 0-9
  if (code >= 97 && code <= 102) {
    return code - 87;
  } // a-f
  return -1;
};

/**
 * Parse the `YYYYMMDDTHHMMSSZ` `X-Amz-Date` format into a wall-clock
 * timestamp. Returns `null` on malformed input.
 */
const parseAmzDate = (s: string): number | null => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (m === null) {
    return null;
  }
  const [, yyyy, mm, dd, hh, min, sec] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  return Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), Number(sec));
};

const buildCanonicalHeaders = (
  headers: Headers,
  signedHeaders: readonly string[],
  host: string,
): string | null => {
  const lines: string[] = [];
  for (const name of signedHeaders) {
    let value: string | null;
    if (name === "host") {
      value = headers.get("Host") ?? host;
    } else {
      value = headers.get(name);
      if (value === null) {
        return null;
      }
    }
    lines.push(`${name}:${value.replace(/\s+/g, " ")}`);
  }
  return lines.join("\n");
};

/**
 * SigV4 canonical-path encoding. Per AWS docs, encode each path
 * segment with RFC 3986 percent-encoding (path separators preserved).
 * The aws4fetch signer applies a single `encodeURIComponent` followed
 * by `%2F`→`/` substitution and an RFC 3986 sweep over `!'()*`; we
 * mirror that to stay byte-equal with their canonical string.
 */
const encodePath = (path: string): string => {
  if (path.length === 0) {
    return "/";
  }
  const enc = encodeURIComponent(path).replace(/%2F/g, "/");
  return enc.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
};

const canonicalQueryString = (params: URLSearchParams): string => {
  const pairs: string[] = [];
  for (const [k, v] of params) {
    if (k.length === 0) {
      continue;
    }
    pairs.push(
      `${encodeURIComponent(k).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      )}=${encodeURIComponent(v).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      )}`,
    );
  }
  pairs.sort();
  return pairs.join("&");
};

/**
 * Compute the body hash. Honors `X-Amz-Content-Sha256` when set
 * (including the `UNSIGNED-PAYLOAD` sentinel that `aws4fetch` writes
 * for S3 requests); otherwise SHA-256-hashes the request body.
 * Returns `null` if the body exceeds {@link MAX_BODY_BYTES}.
 */
const computeBodyHash = async (req: Request): Promise<string | null> => {
  const headerHash = req.headers.get("X-Amz-Content-Sha256");
  if (headerHash !== null) {
    return headerHash;
  }
  if (req.body === null || req.method === "GET" || req.method === "HEAD") {
    return bufToHex(await sha256(new Uint8Array(0)));
  }
  const cloned = req.clone();
  const reader = cloned.body?.getReader();
  if (reader === undefined) {
    // No stream — read via arrayBuffer (e.g. small in-memory bodies).
    const buf = new Uint8Array(await cloned.arrayBuffer());
    if (buf.byteLength > MAX_BODY_BYTES) {
      return null;
    }
    return bufToHex(await sha256(buf));
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value !== undefined) {
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        return null;
      }
      chunks.push(value);
    }
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  return bufToHex(await sha256(joined));
};
