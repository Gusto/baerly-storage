import { expect, test, describe } from "vitest";
import { parseListObjectsV2CommandOutput, parseS3Error } from "./xml.ts";
describe("XML parser", () => {
  test("parseListObjectsV2CommandOutput example", () => {
    const xml: string = `<?xml version="1.0" encoding="UTF-8"?>
        <ListBucketResult>
           <IsTruncated>false</IsTruncated>
           <Contents>
              <ChecksumAlgorithm>checksum</ChecksumAlgorithm>
              ...
              <ETag>1</ETag>
              <Key>key</Key>
              <LastModified>2023-08-25T19:34:04.306Z</LastModified>
              <Owner>
                 <DisplayName>string</DisplayName>
                 <ID>string</ID>
              </Owner>
              <RestoreStatus>
                 <IsRestoreInProgress>boolean</IsRestoreInProgress>
                 <RestoreExpiryDate>2023-08-25T19:34:04.306Z</RestoreExpiryDate>
              </RestoreStatus>
              <Size>12</Size>
              <StorageClass>string</StorageClass>
           </Contents>
           ...
           <Name>name</Name>
           <Prefix>prefix</Prefix>
           <Delimiter>deliminator</Delimiter>
           <MaxKeys>100</MaxKeys>
           <CommonPrefixes>
              <Prefix>commonprefix</Prefix>
           </CommonPrefixes>
           ...
           <EncodingType>encoding</EncodingType>
           <KeyCount>2</KeyCount>
           <ContinuationToken>contoken</ContinuationToken>
           <NextContinuationToken>nexttoken</NextContinuationToken>
           <StartAfter>startafter</StartAfter>
        </ListBucketResult>`;
    const parsed = parseListObjectsV2CommandOutput(xml);
    expect(parsed).toEqual({
      Contents: [
        {
          ETag: "1",
          Key: "key",
          LastModified: new Date("2023-08-25T19:34:04.306Z"),
        },
      ],
      NextContinuationToken: "nexttoken",
    });
  });

  test("parseListObjectV2 minio example", () => {
    const xml: string = `<?xml version="1.0" encoding="UTF-8"?>
    <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>ver6a24</Name><Prefix>manifest.json</Prefix><KeyCount>2</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated><Contents><Key>manifest.json</Key><LastModified>2023-08-25T19:34:04.316Z</LastModified><ETag>&#34;fb2a3ed15fa6e7ced42dc00d50132e62&#34;</ETag><Size>16</Size><StorageClass>STANDARD</StorageClass></Contents><Contents><Key>manifest.json@01692992046294_ac</Key><LastModified>2023-08-25T19:34:04.306Z</LastModified><ETag>&#34;6de2d545ee848a433040e045d0ed146f&#34;</ETag><Size>230</Size><StorageClass>STANDARD</StorageClass></Contents></ListBucketResult>`;

    const parsed = parseListObjectsV2CommandOutput(xml);
    expect(parsed).toEqual({
      Contents: [
        {
          ETag: '"fb2a3ed15fa6e7ced42dc00d50132e62"',
          Key: "manifest.json",
          LastModified: new Date("2023-08-25T19:34:04.316Z"),
        },
        {
          ETag: '"6de2d545ee848a433040e045d0ed146f"',
          Key: "manifest.json@01692992046294_ac",
          LastModified: new Date("2023-08-25T19:34:04.306Z"),
        },
      ],
      NextContinuationToken: undefined,
    });
  });

  test("parseListObjectsV2CommandOutput escaping test", () => {
    const xml: string = `<?xml version="1.0" encoding="UTF-8"?>
    <ListBucketResult>
    <Contents>
    <Key>%26lt</Key>
    </Contents>
    <Contents>
    <Key>%3C%21%5BCDATA%5B...%5D%5D%3E</Key>
    </Contents>
    <Contents>
    <Key>foo%3CContents%3E</Key>
    </Contents>
    <Contents>
    <Key>%26%24%40%3D%3B++%3A%2B%2C%3F</Key>
    </Contents>
    <Contents>
    <Key>%5C%7B%5E%7D%25%5C%5D%22%3E%5B%7E%23%7C</Key>
    </Contents>
    </ListBucketResult>
    `;
    const parsed = parseListObjectsV2CommandOutput(xml);
    expect(parsed.Contents).toEqual([
      {
        Key: "&lt",
        ETag: undefined,
      },
      {
        Key: "<![CDATA[...]]>",
        ETag: undefined,
      },
      {
        Key: "foo<Contents>",
        ETag: undefined,
      },
      {
        Key: "&$@=;  :+,?",
        ETag: undefined,
      },
      {
        Key: '\\{^}%\\]">[~#|',
        ETag: undefined,
      },
    ]);
  });

  test("malformed LastModified yields undefined, not an Invalid Date", () => {
    const xml: string = `<?xml version="1.0" encoding="UTF-8"?>
      <ListBucketResult>
        <Contents><Key>k</Key><LastModified>not-a-date</LastModified></Contents>
      </ListBucketResult>`;
    const parsed = parseListObjectsV2CommandOutput(xml);
    expect(parsed.Contents).toEqual([{ Key: "k", ETag: undefined, LastModified: undefined }]);
  });

  test("control characters (ASCII 0–31) in a key round-trip via url-decoding", () => {
    // S3 url-encodes control chars in the key (EncodingType=url):
    // %09 = TAB, %0A = LF. They decode back to the literal characters.
    const xml: string = `<?xml version="1.0" encoding="UTF-8"?>
      <ListBucketResult>
        <Contents><Key>a%09b%0Ac</Key></Contents>
      </ListBucketResult>`;
    const parsed = parseListObjectsV2CommandOutput(xml);
    expect(parsed.Contents?.[0]?.Key).toBe("a\tb\nc");
  });
});

describe("parseS3Error", () => {
  test("extracts Code and Message from an S3 <Error> body", () => {
    const xml: string = `<?xml version="1.0" encoding="UTF-8"?>
      <Error><Code>PreconditionFailed</Code><Message>At least one of the preconditions you specified did not hold.</Message><RequestId>abc</RequestId></Error>`;
    expect(parseS3Error(xml)).toEqual({
      Code: "PreconditionFailed",
      Message: "At least one of the preconditions you specified did not hold.",
    });
  });

  test("returns Code only when Message is absent", () => {
    expect(parseS3Error("<Error><Code>SlowDown</Code></Error>")).toEqual({ Code: "SlowDown" });
  });

  test("returns undefined for non-error bodies so callers fall back to raw text", () => {
    expect(parseS3Error("")).toBeUndefined();
    expect(parseS3Error("<ListBucketResult></ListBucketResult>")).toBeUndefined();
    expect(parseS3Error("plain text 500")).toBeUndefined();
    // <Error> present but no Code/Message → nothing useful to surface.
    expect(parseS3Error("<Error><RequestId>abc</RequestId></Error>")).toBeUndefined();
  });

  test("refuses a DTD (XXE guard) and returns undefined", () => {
    expect(parseS3Error(`<!DOCTYPE foo><Error><Code>X</Code></Error>`)).toBeUndefined();
  });
});
