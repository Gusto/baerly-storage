import { expect, test, describe } from "vitest";
import {
  parseAssumeRoleWithWebIdentity,
  parseListObjectsV2CommandOutput,
  parseS3Error,
  parseStsError,
} from "./xml.ts";
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

  test("DOCTYPE entity-definition vector is rejected before the parser runs", () => {
    // CVE-2026-25896 shadowing shape: a DOCTYPE defining an entity. The DTD
    // guard must reject the body BEFORE the parser sees the bytes, so
    // the entity is never expanded/shadowed. Locks the guard so a future
    // parser-option change can't silently regress this.
    const xml: string = `<?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE ListBucketResult [<!ENTITY l. "x">]>
      <ListBucketResult><Contents><Key>&lt;</Key></Contents></ListBucketResult>`;
    expect(() => parseListObjectsV2CommandOutput(xml)).toThrowError(
      expect.objectContaining({ code: "InvalidResponse" }),
    );
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
    // S3 url-encodes control chars in the key (encoding-type=url):
    // %09 = TAB, %0A = LF. They decode back to the literal characters.
    const xml: string = `<?xml version="1.0" encoding="UTF-8"?>
      <ListBucketResult>
        <Contents><Key>a%09b%0Ac</Key></Contents>
      </ListBucketResult>`;
    const parsed = parseListObjectsV2CommandOutput(xml);
    expect(parsed.Contents?.[0]?.Key).toBe("a\tb\nc");
  });

  test("XML-1.0-illegal control chars only ever appear percent-encoded and round-trip", () => {
    // %01 (SOH) and %1F (US) are C0 controls that are ILLEGAL in XML 1.0 —
    // even as numeric character references (&#x01;/&#x1F; are not
    // well-formed XML 1.0). %7F (DEL) is discouraged. encoding-type=url is
    // therefore the ONLY representation that can appear in a valid
    // ListObjectsV2 body for such a key; we decode it back to literal bytes.
    const xml: string = `<?xml version="1.0" encoding="UTF-8"?>
      <ListBucketResult>
        <Contents><Key>a%01b%1Fc%7Fd</Key></Contents>
      </ListBucketResult>`;
    const parsed = parseListObjectsV2CommandOutput(xml);
    expect(parsed.Contents?.[0]?.Key).toBe("a\x01b\x1Fc\x7Fd");
  });

  test("NUL byte (%00) in a key round-trips to a literal \\x00", () => {
    // NUL (0x00) is illegal in XML 1.0 AND 1.1 — it cannot appear even as a
    // numeric character reference, so encoding-type=url (%00) is the ONLY
    // representation that can survive a valid ListObjectsV2 body. Pin the
    // decode: decodeURIComponent("%00") === "\x00", so the parsed key
    // contains the literal NUL character. Sibling of the ASCII 0–31 cases.
    const xml: string = `<?xml version="1.0" encoding="UTF-8"?>
      <ListBucketResult>
        <Contents><Key>a%00b</Key></Contents>
      </ListBucketResult>`;
    const parsed = parseListObjectsV2CommandOutput(xml);
    expect(parsed.Contents?.[0]?.Key).toBe("a\x00b");
    // Non-tautology guard: the decoded key must differ from the raw wire form,
    // proving the percent-escape was actually decoded (not passed through).
    expect(parsed.Contents?.[0]?.Key).not.toBe("a%00b");
  });

  test("space, %, and unicode in a key round-trip via url-decoding", () => {
    // With encoding-type=url S3 sends a space as `+`, a literal percent as
    // %25, and non-ASCII as percent-encoded UTF-8 (é = %C3%A9).
    const xml: string = `<?xml version="1.0" encoding="UTF-8"?>
      <ListBucketResult>
        <Contents><Key>my+50%25+caf%C3%A9</Key></Contents>
      </ListBucketResult>`;
    const parsed = parseListObjectsV2CommandOutput(xml);
    expect(parsed.Contents?.[0]?.Key).toBe("my 50% café");
  });

  test("malformed percent-escape in a key raises InvalidResponse, not an uncaught URIError", () => {
    // With encoding-type=url a well-formed key is always valid percent-encoding.
    // A bare `%` or an invalid pair (`%ZZ`) is a malformed or hostile response:
    // decodeURIComponent throws a raw URIError. That must be caught and
    // re-raised as BaerlyError("InvalidResponse") so the storage layer surfaces
    // a typed, catchable error instead of an unhandled runtime exception.
    // See docs/spec/s3-xml-escaping-cases.md ("Latent hardening").
    const bareXml: string = `<?xml version="1.0" encoding="UTF-8"?>
      <ListBucketResult>
        <Contents><Key>bad%key</Key></Contents>
      </ListBucketResult>`;
    const invalidPairXml: string = `<?xml version="1.0" encoding="UTF-8"?>
      <ListBucketResult>
        <Contents><Key>bad%ZZkey</Key></Contents>
      </ListBucketResult>`;
    expect(() => parseListObjectsV2CommandOutput(bareXml)).toThrowError(
      expect.objectContaining({ code: "InvalidResponse" }),
    );
    expect(() => parseListObjectsV2CommandOutput(invalidPairXml)).toThrowError(
      expect.objectContaining({ code: "InvalidResponse" }),
    );
  });

  test("NextContinuationToken is read verbatim — S3 does not url-encode it", () => {
    // Continuation tokens are opaque base64-ish blobs that routinely contain
    // `+` and `/`. They are NOT covered by encoding-type=url, so url-decoding
    // them (turning `+` into a space) would corrupt pagination on large
    // buckets — the token must be passed back to S3 byte-for-byte.
    const token = "ab+cd/ef==gh%2Bij";
    const xml: string = `<?xml version="1.0" encoding="UTF-8"?>
      <ListBucketResult>
        <Contents><Key>k</Key></Contents>
        <NextContinuationToken>${token}</NextContinuationToken>
      </ListBucketResult>`;
    const parsed = parseListObjectsV2CommandOutput(xml);
    expect(parsed.NextContinuationToken).toBe(token);
  });

  test("ETag is read verbatim — S3 does not url-encode it", () => {
    // encoding-type=url covers the key family only, not ETag. A `+`/`%` in
    // the ETag must survive unchanged (no decodeURIComponent, no +→space).
    const xml: string = `<?xml version="1.0" encoding="UTF-8"?>
      <ListBucketResult>
        <Contents><Key>k</Key><ETag>"a+b%2Bc"</ETag></Contents>
      </ListBucketResult>`;
    const parsed = parseListObjectsV2CommandOutput(xml);
    expect(parsed.Contents?.[0]?.ETag).toBe('"a+b%2Bc"');
  });

  test("returns {} when the root element is not <ListBucketResult>", () => {
    // A non-list body (e.g. an S3 <Error> response mis-routed here) must hit the
    // root-name guard and return {} rather than attempting to parse Contents.
    // Exercises the `localName(root.name) !== "ListBucketResult"` branch directly.
    expect(parseListObjectsV2CommandOutput("<Error><Code>AccessDenied</Code></Error>")).toEqual({});
  });

  test("collects namespace-prefixed <s3:Contents> children (namespace-agnostic)", () => {
    // The whitespace-free minio example uses a default xmlns (no prefix), so it
    // never exercises localName()'s prefix-stripping path. This body carries an
    // explicit `s3:` prefix on every element, proving the namespace-agnostic
    // traversal claim: <s3:ListBucketResult> matches the root guard and
    // <s3:Contents>/<s3:Key>/<s3:ETag> are collected and read.
    const xml = `<?xml version="1.0" encoding="UTF-8"?><s3:ListBucketResult xmlns:s3="http://s3.amazonaws.com/doc/2006-03-01/"><s3:Contents><s3:Key>k</s3:Key><s3:ETag>"e"</s3:ETag></s3:Contents><s3:NextContinuationToken>tok</s3:NextContinuationToken></s3:ListBucketResult>`;
    expect(parseListObjectsV2CommandOutput(xml)).toEqual({
      Contents: [{ Key: "k", ETag: '"e"', LastModified: undefined }],
      NextContinuationToken: "tok",
    });
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

  test("returns undefined when <Error> is nested but the root element is not <Error>", () => {
    // The `/<Error\b/i` prefilter matches (the inner <Error> tag is present), so
    // this body reaches — and must be rejected by — the root-name guard
    // (`localName(root.name) !== "Error"`), not the prefilter short-circuit that
    // the "<ListBucketResult>" case above hits. Guards against mis-parsing an
    // STS-shaped or wrapped body as a bare S3 error.
    expect(parseS3Error("<Wrapper><Error><Code>X</Code></Error></Wrapper>")).toBeUndefined();
  });

  test("decodes builtin XML entities and CDATA in the <Message> text", () => {
    // DISTINCT from the DOCTYPE <!ENTITY> vector below (which is REJECTED as an
    // entity-shadow attack): a normal builtin XML entity (&amp;) and a CDATA
    // block in the Message TEXT are legitimate S3 error content and MUST be
    // decoded/unwrapped into the plain Message string. @rgrove/parse-xml handles
    // both (predefined + numeric entity refs, plus CDATA merged into text) before
    // rawXmlVal reads the field, so &amp; → & and <![CDATA[..]]> is unwrapped verbatim.
    const entityXml: string = `<?xml version="1.0" encoding="UTF-8"?>
      <Error><Code>InvalidArgument</Code><Message>bucket &amp; key are &lt;required&gt;</Message></Error>`;
    const entityParsed = parseS3Error(entityXml);
    expect(entityParsed).toEqual({
      Code: "InvalidArgument",
      Message: "bucket & key are <required>",
    });
    // Non-tautology guard: the decoded Message must differ from the raw
    // entity-bearing form, proving the entities were actually expanded.
    expect(entityParsed?.Message).not.toBe("bucket &amp; key are &lt;required&gt;");

    const cdataXml: string = `<?xml version="1.0" encoding="UTF-8"?>
      <Error><Code>InvalidArgument</Code><Message><![CDATA[a & b <c>]]></Message></Error>`;
    expect(parseS3Error(cdataXml)).toEqual({
      Code: "InvalidArgument",
      Message: "a & b <c>",
    });
  });

  test("refuses a DTD (XXE guard) and returns undefined", () => {
    expect(parseS3Error(`<!DOCTYPE foo><Error><Code>X</Code></Error>`)).toBeUndefined();
  });

  test("refuses a DOCTYPE with an entity definition (entity-shadow vector)", () => {
    // CVE-2026-25896 shape: a DOCTYPE defining an entity to shadow a
    // predefined XML entity. The guard rejects any DOCTYPE before the parser
    // runs, so the entity is never expanded. Locks the behavior.
    expect(
      parseS3Error(`<!DOCTYPE Error [<!ENTITY l. "x">]><Error><Code>&lt;</Code></Error>`),
    ).toBeUndefined();
  });
});

describe("whitespace contract: @rgrove/parse-xml preserves surrounding whitespace", () => {
  // These tests document a deliberate divergence from the old fast-xml-parser
  // behavior (which trimmed leading/trailing whitespace by default via
  // `trimValues: true`). Real S3/R2/MinIO/GCS backends emit compact XML and
  // never pad field values with surrounding whitespace, so this difference does
  // not affect production behavior. The contract is pinned here so any future
  // change to whitespace handling (e.g. a new parser or an explicit trim step)
  // is a conscious, reviewed decision rather than a silent regression.

  test("parseS3Error preserves surrounding whitespace in <Message>", () => {
    // Empirically determined: @rgrove/parse-xml concatenates raw text node
    // content, preserving the spaces on both sides of the message text.
    const xml = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>SomeError</Code><Message>  padded message  </Message></Error>`;
    expect(parseS3Error(xml)).toEqual({
      Code: "SomeError",
      Message: "  padded message  ",
    });
  });

  test("parseListObjectsV2CommandOutput preserves surrounding whitespace in <ETag>", () => {
    // Empirically determined: @rgrove/parse-xml concatenates raw text node
    // content, preserving the spaces on both sides of the ETag value.
    const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Contents><Key>my%2Bkey</Key><ETag>  "etag-value"  </ETag></Contents></ListBucketResult>`;
    const parsed = parseListObjectsV2CommandOutput(xml);
    expect(parsed.Contents?.[0]?.ETag).toBe('  "etag-value"  ');
  });
});

describe("parseAssumeRoleWithWebIdentity", () => {
  test("extracts the <Credentials> block from an STS success body", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
        <AssumeRoleWithWebIdentityResult><Credentials>
          <AccessKeyId>ASIAEXAMPLE</AccessKeyId>
          <SecretAccessKey>secret</SecretAccessKey>
          <SessionToken>token</SessionToken>
          <Expiration>2026-05-28T18:00:00Z</Expiration>
        </Credentials></AssumeRoleWithWebIdentityResult>
      </AssumeRoleWithWebIdentityResponse>`;
    expect(parseAssumeRoleWithWebIdentity(xml)).toEqual({
      AccessKeyId: "ASIAEXAMPLE",
      SecretAccessKey: "secret",
      SessionToken: "token",
      Expiration: "2026-05-28T18:00:00Z",
    });
  });

  test("returns all-undefined fields for a body without <Credentials>", () => {
    expect(parseAssumeRoleWithWebIdentity("<AssumeRoleWithWebIdentityResponse/>")).toEqual({
      AccessKeyId: undefined,
      SecretAccessKey: undefined,
      SessionToken: undefined,
      Expiration: undefined,
    });
  });

  test("refuses a DTD (XXE guard) by throwing InvalidResponse", () => {
    expect(() =>
      parseAssumeRoleWithWebIdentity(
        `<!DOCTYPE AssumeRoleWithWebIdentityResponse [<!ENTITY l. "x">]><AssumeRoleWithWebIdentityResponse/>`,
      ),
    ).toThrow(/DTD/);
  });

  test("does not echo the response body on unparseable XML (would leak live creds)", () => {
    // A success-shaped-but-malformed 200 body carries plaintext credentials;
    // the thrown error must not fold them in (it gets logged).
    const secret = "SECRET-ACCESS-KEY-DO-NOT-LEAK";
    // Truncated trailing tag makes the parser throw mid-parse; the secret
    // sits in the (unparseable) body the old code echoed into the error.
    const malformed = `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><SecretAccessKey>${secret}</SecretAccessKey><trunc`;
    let thrown: unknown;
    try {
      parseAssumeRoleWithWebIdentity(malformed);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "InvalidResponse" });
    expect((thrown as Error).message).not.toContain(secret);
  });
});

describe("parseStsError", () => {
  test("extracts Code and Message from an STS <ErrorResponse> body", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
        <Error>
          <Type>Sender</Type>
          <Code>InvalidIdentityToken</Code>
          <Message>The ID Token provided is not a valid JWT.</Message>
        </Error>
        <RequestId>abc-123</RequestId>
      </ErrorResponse>`;
    expect(parseStsError(xml)).toEqual({
      Code: "InvalidIdentityToken",
      Message: "The ID Token provided is not a valid JWT.",
    });
  });

  test("extracts Code alone when the STS <Error> carries no <Message>", () => {
    const xml = `<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
        <Error><Type>Sender</Type><Code>InvalidIdentityToken</Code></Error>
      </ErrorResponse>`;
    expect(parseStsError(xml)).toEqual({ Code: "InvalidIdentityToken" });
  });

  test("returns undefined for a non-error body so callers fall back to the raw status", () => {
    expect(parseStsError("<AssumeRoleWithWebIdentityResponse/>")).toBeUndefined();
    expect(parseStsError("")).toBeUndefined();
  });

  test("refuses a DTD (XXE guard) and returns undefined", () => {
    expect(
      parseStsError(
        `<!DOCTYPE ErrorResponse [<!ENTITY x "y">]><ErrorResponse><Error/></ErrorResponse>`,
      ),
    ).toBeUndefined();
  });
});
