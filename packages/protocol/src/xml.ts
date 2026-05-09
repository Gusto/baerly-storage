import { MPS3Error } from "./errors";
import type { XmlNode, XmlParser } from "./types";

/**
 * Subset of S3's `ListObjectsV2CommandOutput` produced by
 * {@link parseListObjectsV2CommandOutput}. Mirrors the shape in
 * `src/s3-types.ts` (kept structurally compatible) without
 * introducing a `protocol → src` import. The host's
 * `ListObjectsV2CommandOutput` is structurally compatible.
 */
export interface ParsedListObjectsV2Output {
  $metadata: { httpStatusCode?: number };
  Contents?: Array<{ ETag?: string; Key?: string; LastModified?: Date }>;
  KeyCount?: number;
  ContinuationToken?: string;
  NextContinuationToken?: string;
  StartAfter?: string;
}

export const parseListObjectsV2CommandOutput = (
  xml: string,
  domParser: XmlParser,
): ParsedListObjectsV2Output => {
  // reject DTDs (XXE/billion-laughs) — DOCTYPE must precede the root element
  if (/<!DOCTYPE\b/i.test(xml)) {
    throw new MPS3Error("InvalidResponse", "DTD not allowed in S3 XML responses");
  }
  const doc = domParser.parseFromString(xml, "text/xml");
  if (!doc) throw new MPS3Error("InvalidResponse", `Invalid XML: ${xml}`);
  // const results = doc.getElementsByTagName("ListBucketResult")[0];
  const contents = doc.getElementsByTagName("Contents");
  //if (!contents) throw new Error(`Invalid XML: ${xml}`);

  const val = (el: XmlNode, name: string) => {
    const c = el.getElementsByTagName(name)[0]?.textContent;
    return c ? decodeURIComponent(c.replace(/\+/g, " ")) : undefined;
  };

  return {
    $metadata: {},
    //IsTruncated: val(results, "IsTruncated") === "true",
    Contents: Array.from(contents).map((content) => {
      const lm = val(content, "LastModified");
      return {
        //ChecksumAlgorithm: [val(content, "ChecksumAlgorithm")!],
        ETag: val(content, "ETag")!,
        Key: val(content, "Key")!,
        LastModified: lm ? new Date(lm) : undefined,
        /*
        Owner: {
          DisplayName: val(content, "DisplayName")!,
          ID: val(content, "ID")!,
        },*/
        //Size: parseInt(val(content, "Size")!),
        //StorageClass: val(content, "StorageClass")!,
      };
    }),
    //Name: val(doc, "Name")!,
    // Prefix: val(doc, "Prefix")!,
    //Delimiter: val(doc, "Delimiter")!,
    //MaxKeys: parseInt(val(doc, "MaxKeys")!),
    /*
    CommonPrefixes: Array.from(
      doc
        .getElementsByTagName("CommonPrefixes")[0]
        ?.getElementsByTagName("Prefix") || []
    ).map((prefix) => ({ Prefix: prefix.textContent! })),
    */
    //EncodingType: val(doc, "EncodingType")!,
    KeyCount: parseInt(val(doc, "KeyCount")!),
    ContinuationToken: val(doc, "ContinuationToken")!,
    NextContinuationToken: val(doc, "NextContinuationToken")!,
    StartAfter: val(doc, "StartAfter")!,
  };
};
