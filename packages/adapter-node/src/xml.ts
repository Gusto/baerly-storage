import { BaerlyError } from "@baerly/protocol";
import { XMLParser } from "fast-xml-parser";

/**
 * Subset of S3's `ListObjectsV2CommandOutput` produced by
 * {@link parseListObjectsV2CommandOutput}. Field names mirror the
 * S3 REST API exactly (PascalCase) so the parser stays a thin shape
 * over the wire format.
 */
export interface ParsedListObjectsV2Output {
  Contents?: Array<{ ETag?: string; Key?: string; LastModified?: Date }>;
  NextContinuationToken?: string;
}

/**
 * `<Code>` / `<Message>` extracted from an S3
 * `<Error>…</Error>` response body by {@link parseS3Error}. Field
 * names mirror the S3 REST API (PascalCase), matching the convention
 * of {@link ParsedListObjectsV2Output}.
 */
export interface ParsedS3Error {
  Code?: string;
  Message?: string;
}

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  // Keep numeric-looking strings as strings — S3 keys can be all-digits.
  parseTagValue: false,
  // Force `<Contents>` to an array even when only one is present.
  isArray: (name) => name === "Contents",
  // Decode numeric character refs (`&#34;` → `"`). fast-xml-parser's
  // `processEntities` only handles the 5 predefined XML entities by
  // default; the HTML entity table covers numeric refs too. Minio
  // emits `&#34;` around ETags, so this is load-bearing.
  htmlEntities: true,
});

// The list request sets `encoding-type=url`, so S3 URL-encodes the **key
// family only** (Key/Prefix/Delimiter/StartAfter) in the response,
// including spaces as `+`. Use this to reverse both steps. Do NOT apply it
// to ETag or NextContinuationToken — S3 leaves those verbatim, and a
// continuation token routinely contains literal `+` that the `.replace`
// step would mangle into a space (corrupting pagination on large buckets).
const xmlVal = (obj: Record<string, unknown>, name: string): string | undefined => {
  const v = obj[name];
  if (typeof v !== "string" || v === "") {
    return undefined;
  }
  // A well-formed encoding-type=url response only ever contains valid
  // percent-escapes. A bare `%` or an invalid pair (`%ZZ`) makes
  // decodeURIComponent throw a raw URIError — catch it and re-raise as a
  // typed BaerlyError so the storage layer surfaces a catchable error rather
  // than an unhandled runtime exception. See docs/spec/s3-xml-escaping-cases.md.
  try {
    return decodeURIComponent(v.replace(/\+/g, " "));
  } catch {
    throw new BaerlyError("InvalidResponse", `Malformed percent-escape in S3 <${name}>: ${v}`);
  }
};

// Read a field verbatim. Used for everything S3 does NOT URL-encode:
// error-body `Code`/`Message`, list `ETag`/`LastModified`, and
// `NextContinuationToken` — running any of these through `xmlVal`'s
// `decodeURIComponent` / `+`→space would corrupt literal `+` and `%`.
const rawXmlVal = (obj: Record<string, unknown>, name: string): string | undefined => {
  const v = obj[name];
  return typeof v === "string" && v !== "" ? v : undefined;
};

/**
 * Parse an S3 `<Error><Code>…</Code><Message>…</Message></Error>`
 * body. Returns `undefined` when the body is not a recognizable S3
 * error document (empty, HTML, a success payload, or a DTD), so
 * callers can fall back to the raw response text. This never throws:
 * it runs on a path that is already reporting an error.
 */
export const parseS3Error = (xml: string): ParsedS3Error | undefined => {
  // Skip non-error bodies; refuse DTDs before parsing — see the DTD-guard
  // note above parseListObjectsV2CommandOutput.
  if (!/<Error\b/i.test(xml) || /<!DOCTYPE\b/i.test(xml)) {
    return undefined;
  }
  let result: { Error?: Record<string, unknown> };
  try {
    result = xmlParser.parse(xml) as { Error?: Record<string, unknown> };
  } catch {
    return undefined;
  }
  const root = result.Error;
  if (root === undefined) {
    return undefined;
  }
  const code = rawXmlVal(root, "Code");
  const message = rawXmlVal(root, "Message");
  if (code === undefined && message === undefined) {
    return undefined;
  }
  return {
    ...(code !== undefined && { Code: code }),
    ...(message !== undefined && { Message: message }),
  };
};

/**
 * Parse an STS `<ErrorResponse><Error><Code>…</Code><Message>…</Message>
 * </Error></ErrorResponse>` body (the shape STS returns on a failed
 * `AssumeRoleWithWebIdentity` — e.g. `InvalidIdentityToken`,
 * `ExpiredTokenException`, `AccessDenied`). Returns `undefined` when the body
 * is not a recognizable STS error document (empty, HTML, a success payload, or
 * a DTD), so callers can fall back to the bare status. Like {@link parseS3Error}
 * this never throws — it runs on a path that is already reporting an error.
 *
 * Note the nesting differs from S3: STS wraps `<Error>` inside `<ErrorResponse>`.
 */
export const parseStsError = (xml: string): ParsedS3Error | undefined => {
  if (!/<Error\b/i.test(xml) || /<!DOCTYPE\b/i.test(xml)) {
    return undefined;
  }
  let result: { ErrorResponse?: { Error?: Record<string, unknown> } };
  try {
    result = xmlParser.parse(xml) as typeof result;
  } catch {
    return undefined;
  }
  const root = result.ErrorResponse?.Error;
  if (root === undefined) {
    return undefined;
  }
  const code = rawXmlVal(root, "Code");
  const message = rawXmlVal(root, "Message");
  if (code === undefined && message === undefined) {
    return undefined;
  }
  return {
    ...(code !== undefined && { Code: code }),
    ...(message !== undefined && { Message: message }),
  };
};

/**
 * `<Credentials>` extracted from an STS
 * `<AssumeRoleWithWebIdentityResponse>` body by
 * {@link parseAssumeRoleWithWebIdentity}. Field names mirror the STS REST
 * API (PascalCase), matching the convention of {@link ParsedS3Error}.
 */
export interface ParsedWebIdentityCredentials {
  AccessKeyId?: string;
  SecretAccessKey?: string;
  SessionToken?: string;
  Expiration?: string;
}

/**
 * Parse an STS `AssumeRoleWithWebIdentity` success body, returning the
 * `<Credentials>` block. Reuses the hardened, DTD-guarded {@link xmlParser};
 * throws `InvalidResponse` on a DTD or unparseable XML. Missing fields come
 * back `undefined` so the caller can map them to its own `InvalidResponse`.
 *
 * Unlike {@link parseListObjectsV2CommandOutput}, the error on unparseable
 * XML must NOT echo the body: a success-shaped STS body carries the plaintext
 * `SecretAccessKey`/`SessionToken`, so folding it into a thrown-then-logged
 * error would leak live credentials.
 */
export const parseAssumeRoleWithWebIdentity = (xml: string): ParsedWebIdentityCredentials => {
  if (/<!DOCTYPE\b/i.test(xml)) {
    throw new BaerlyError("InvalidResponse", "DTD not allowed in STS XML responses");
  }
  let result: {
    AssumeRoleWithWebIdentityResponse?: {
      AssumeRoleWithWebIdentityResult?: { Credentials?: Record<string, unknown> };
    };
  };
  try {
    result = xmlParser.parse(xml) as typeof result;
  } catch {
    // No body in the message — see the note above; it may contain live creds.
    throw new BaerlyError("InvalidResponse", "unparseable STS credentials response");
  }
  const creds =
    result.AssumeRoleWithWebIdentityResponse?.AssumeRoleWithWebIdentityResult?.Credentials ?? {};
  return {
    AccessKeyId: rawXmlVal(creds, "AccessKeyId"),
    SecretAccessKey: rawXmlVal(creds, "SecretAccessKey"),
    SessionToken: rawXmlVal(creds, "SessionToken"),
    Expiration: rawXmlVal(creds, "Expiration"),
  };
};

// `new Date(badString)` yields an Invalid Date (a non-null Date whose
// getTime() is NaN) rather than throwing — surface `undefined` for a
// malformed `LastModified` so it never leaks into a `StorageListEntry`.
// GC then falls back to `now()` for the tombstone `due_at` anchor.
const parseLastModified = (lm: string | undefined): Date | undefined => {
  if (lm === undefined) {
    return undefined;
  }
  const d = new Date(lm);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

// DTD guard: reject any DOCTYPE before fast-xml-parser sees the bytes. S3/R2/
// MinIO/GCS never emit a DOCTYPE here, so one is always a bug or an attack —
// this defangs the DOCTYPE entity vectors (XXE, billion-laughs, the
// CVE-2026-25896 entity-shadow). The no-DOCTYPE numeric-ref expansion path
// (CVE-2026-33036) it cannot match is covered by the `^5.5.6` floor in
// package.json. `htmlEntities: true` (above) stays default-safe given both.
export const parseListObjectsV2CommandOutput = (xml: string): ParsedListObjectsV2Output => {
  if (/<!DOCTYPE\b/i.test(xml)) {
    throw new BaerlyError("InvalidResponse", "DTD not allowed in S3 XML responses");
  }
  let result: { ListBucketResult?: Record<string, unknown> };
  try {
    result = xmlParser.parse(xml) as { ListBucketResult?: Record<string, unknown> };
  } catch {
    throw new BaerlyError("InvalidResponse", `Invalid XML: ${xml}`);
  }
  const root = result.ListBucketResult ?? {};
  const contents = (root["Contents"] as Array<Record<string, unknown>> | undefined) ?? [];

  return {
    Contents: contents.map((content) => {
      return {
        ETag: rawXmlVal(content, "ETag"),
        Key: xmlVal(content, "Key"),
        LastModified: parseLastModified(rawXmlVal(content, "LastModified")),
      };
    }),
    NextContinuationToken: rawXmlVal(root, "NextContinuationToken"),
  };
};
