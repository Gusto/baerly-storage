/// <reference lib="dom" />

import { ListObjectsV2CommandOutput } from "@aws-sdk/client-s3";

export const parseListObjectsV2CommandOutput = (
  xml: string,
  domParser: DOMParser,
): ListObjectsV2CommandOutput => {
  const doc = domParser.parseFromString(xml, "text/xml");
  if (!doc) throw new Error(`Invalid XML: ${xml}`);
  // const results = doc.getElementsByTagName("ListBucketResult")[0];
  const contents = doc.getElementsByTagName("Contents");
  //if (!contents) throw new Error(`Invalid XML: ${xml}`);

  const val = (el: Element | Document, name: string) => {
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
