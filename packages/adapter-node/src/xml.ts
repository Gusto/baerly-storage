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

const xmlVal = (obj: Record<string, unknown>, name: string): string | undefined => {
  const v = obj[name];
  if (typeof v !== "string" || v === "") {
    return undefined;
  }
  // The request sets `EncodingType=url`, so S3 URL-encodes the key in the
  // response (including spaces as `+`). Reverse both steps.
  return decodeURIComponent(v.replace(/\+/g, " "));
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
      const lm = xmlVal(content, "LastModified");
      return {
        ETag: xmlVal(content, "ETag"),
        Key: xmlVal(content, "Key"),
        LastModified: lm ? new Date(lm) : undefined,
      };
    }),
    NextContinuationToken: xmlVal(root, "NextContinuationToken"),
  };
};
