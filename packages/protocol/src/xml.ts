import { BaerlyError } from "./errors.ts";
import type { XmlNode, XmlParser } from "./types.ts";

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

const xmlVal = (el: XmlNode, name: string): string | undefined => {
  const c = el.getElementsByTagName(name)[0]?.textContent;
  return c ? decodeURIComponent(c.replace(/\+/g, " ")) : undefined;
};

export const parseListObjectsV2CommandOutput = (
  xml: string,
  domParser: XmlParser,
): ParsedListObjectsV2Output => {
  // reject DTDs (XXE/billion-laughs) — DOCTYPE must precede the root element
  if (/<!DOCTYPE\b/i.test(xml)) {
    throw new BaerlyError("InvalidResponse", "DTD not allowed in S3 XML responses");
  }
  const doc = domParser.parseFromString(xml, "text/xml");
  if (!doc) {
    throw new BaerlyError("InvalidResponse", `Invalid XML: ${xml}`);
  }
  const contents = doc.getElementsByTagName("Contents");

  return {
    Contents: Array.from(contents).map((content) => {
      const lm = xmlVal(content, "LastModified");
      return {
        ETag: xmlVal(content, "ETag")!,
        Key: xmlVal(content, "Key")!,
        LastModified: lm ? new Date(lm) : undefined,
      };
    }),
    NextContinuationToken: xmlVal(doc, "NextContinuationToken")!,
  };
};
