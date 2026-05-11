import { MPS3Error } from "./errors";
import type { XmlNode, XmlParser } from "./types";

/**
 * Subset of S3's `ListObjectsV2CommandOutput` produced by
 * {@link parseListObjectsV2CommandOutput}. Field names mirror the
 * S3 REST API exactly (PascalCase) so the parser stays a thin shape
 * over the wire format.
 */
export interface ParsedListObjectsV2Output {
  $metadata: { httpStatusCode?: number };
  Contents?: Array<{ ETag?: string; Key?: string; LastModified?: Date }>;
  KeyCount?: number;
  ContinuationToken?: string;
  NextContinuationToken?: string;
  StartAfter?: string;
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
    throw new MPS3Error("InvalidResponse", "DTD not allowed in S3 XML responses");
  }
  const doc = domParser.parseFromString(xml, "text/xml");
  if (!doc) throw new MPS3Error("InvalidResponse", `Invalid XML: ${xml}`);
  // const results = doc.getElementsByTagName("ListBucketResult")[0];
  const contents = doc.getElementsByTagName("Contents");
  //if (!contents) throw new Error(`Invalid XML: ${xml}`);

  return {
    $metadata: {},
    //IsTruncated: val(results, "IsTruncated") === "true",
    Contents: Array.from(contents).map((content) => {
      const lm = xmlVal(content, "LastModified");
      return {
        //ChecksumAlgorithm: [val(content, "ChecksumAlgorithm")!],
        ETag: xmlVal(content, "ETag")!,
        Key: xmlVal(content, "Key")!,
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
    KeyCount: parseInt(xmlVal(doc, "KeyCount")!),
    ContinuationToken: xmlVal(doc, "ContinuationToken")!,
    NextContinuationToken: xmlVal(doc, "NextContinuationToken")!,
    StartAfter: xmlVal(doc, "StartAfter")!,
  };
};
