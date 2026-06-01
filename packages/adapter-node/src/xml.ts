import { XMLParser } from "fast-xml-parser";
import { BaerlyError } from "@baerly/protocol";

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
  return decodeURIComponent(v.replace(/\+/g, " "));
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
  // Cheap guards before invoking the parser: skip bodies that can't be
  // an S3 error, and refuse DTDs (XXE / billion-laughs) outright.
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

export const parseListObjectsV2CommandOutput = (xml: string): ParsedListObjectsV2Output => {
  // reject DTDs (XXE/billion-laughs) — DOCTYPE must precede the root element
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
