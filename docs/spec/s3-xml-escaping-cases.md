---
title: S3 XML escaping edge cases
audience: spec
doc_type: adapter-edge-case
summary: Why baerly-storage requests encoding-type=url, what that turns key escaping into, and the XML-1.0 control-char rule that makes it mandatory.
last-reviewed: 2026-06-22
tags: [protocol, s3, xml, edge-cases]
related: [storage-compatibility.md]
---

# S3 XML escaping edge cases

S3's `ListObjectsV2` ([GET /\<bucket>?list-type=2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html))
returns an XML body whose `<Contents>` blocks enumerate the bucket. The
interesting field is `<Key>`: it can contain *any* byte sequence a user
PUT, and XML is a hostile transport for arbitrary bytes. This doc records
how baerly-storage sidesteps that — and why the sidestep is mandatory,
not a convenience.

## The cause: baerly-storage requests `encoding-type=url`

baerly-storage sets `encoding-type=url` on every list request
(`packages/adapter-node/src/s3-http.ts:376`). This moves the entire
escaping problem **out of XML and into percent-decoding**. With the marker
set, S3 returns the key family — `Key` / `Prefix` / `Delimiter` /
`StartAfter` — percent-encoded as `x-www-form-urlencoded`:

- space → `+`
- literal `+` → `%2B`
- everything outside `[A-Za-z0-9._-]` → `%HH`

So the XML parser only ever sees `[A-Za-z0-9%+._-]` in the key family —
never a raw `<`, `&`, `]]>`, or control byte. The parser reverses both
steps in the `xmlVal` helper (`packages/adapter-node/src/xml.ts`):

```ts
decodeURIComponent(v.replace(/\+/g, " "))
```

Note this is `x-www-form-urlencoded`, *not* the similar URI encoding:
spaces come back as `+` and a literal `+` arrives as `%2B`. Decoding the
`+` to a space first, then `decodeURIComponent`, reverses it exactly.

### What that looks like on the wire

Because of the request decision above, keys that *would* be XML-hazardous
arrive percent-encoded instead of entity-escaped (`%26` not `&amp;`, `%3C`
not `&lt;`). Uploading keys `&lt`, `<![CDATA[...]]>`, `foo<Contents>`
through the S3 console yields:

```
<Key>%26lt</Key>
<Key>%3C%21%5BCDATA%5B...%5D%5D%3E</Key>
<Key>foo%3CContents%3E</Key>
```

The `]]>` CDATA-terminator hazard simply never reaches the read side — the
percent-encoding eliminates it. (The S3 console UI itself still renders the
stray `]]>` as noise; the *console* lies, the *response* does not.)

![S3 console showing keys with `&lt`, `<![CDATA[...]]>`, and `foo<Contents>`; the CDATA row's Type column displays the stray `]]>` terminator.](attachments/s3-console-cdata-rendering.png)

The Amazon [object-key guideline](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-keys.html)
calls out `&$@=;/:+,?`, multiple spaces, ASCII `0–31`, and (to avoid)
`\{^}%\]">[~#|` plus ASCII `128–255`. Under `encoding-type=url` these are
all just more `%HH`:

```
<Key>%26%24%40%3D%3B++%3A%2B%2C%3F</Key>          <!-- &$@=;  :+,? -->
<Key>%5C%7B%5E%7D%25%5C%5D%22%3E%5B%7E%23%7C</Key> <!-- \{^}%\]">[~#| -->
```

## Why `encoding-type=url` is mandatory, not a convenience

The legal character set for XML 1.0 excludes most C0 control characters
**even as numeric character references**. The only C0 controls permitted
are TAB (`0x09`), LF (`0x0A`), and CR (`0x0D`); every other byte in
`0x00–0x1F` is illegal, and `&#x01;` / `&#x1F;` are *not* well-formed XML
1.0 — a conformant parser must reject them. NUL (`0x00`) is illegal in
both XML 1.0 and 1.1, and many backends refuse it at PUT time.
(See [Valid characters in XML](https://en.wikipedia.org/wiki/Valid_characters_in_XML).)

The consequence is decisive: for a key containing such a byte, **an
entity-escaped representation is impossible**. There is no well-formed XML
1.0 spelling of `&#x01;`. The percent-encoded form (`%01`) is the *only*
representation that can appear in a valid `ListObjectsV2` body. AWS
documents exactly this motivation for the `encoding-type` parameter — "the
XML 1.0 parser can't parse characters with an ASCII value from 0 to 10"
([ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html),
[MinIO #15023](https://github.com/minio/minio/issues/15023)).

baerly-storage already round-trips the legal control chars (TAB, LF) and
the illegal ones (e.g. `%01`, `%1F`, `%7F`) through the url-decode path —
both are locked by the control-char cases in
`packages/adapter-node/src/xml.test.ts`. Without `encoding-type=url`,
keys with illegal control bytes would be *unrepresentable*, not merely
awkward.

## Portability: decode unconditionally, never branch on the response flag

GCS honors `encoding-type=url` but returns the response marker hyphenated
as `Encoding-Type` (not AWS's `EncodingType`), which silently breaks SDKs
that branch on the response field to decide whether to decode.
baerly-storage dodges this entirely: `xml.ts` **never reads the
`EncodingType` element**.
It url-decodes the key family *unconditionally*
(the `xmlVal` helper in `packages/adapter-node/src/xml.ts`). This is a deliberate
portability invariant — *decode unconditionally, never branch on the
response flag* — matching the fix
[minio-go landed](https://github.com/minio/minio-go/issues/1410). Fields S3
does **not** url-encode (`ETag`, `LastModified`, `NextContinuationToken`)
are read verbatim via `rawXmlVal` so a literal `+` / `%` in a continuation
token survives byte-for-byte.

| Backend | Honors `encoding-type=url`? | Response field name |
|---|---|---|
| AWS S3 | yes | `EncodingType` |
| Cloudflare R2 | yes | `EncodingType` |
| MinIO | yes | `EncodingType` |
| GCS (XML API) | yes | `Encoding-Type` (hyphenated) |

baerly-storage is correct on all four because it decodes the key family
unconditionally and never inspects the response marker.

## Parser hardening

baerly-storage only ever **parses** S3 XML, never **builds** it, so
builder-side CDATA/comment-injection CVEs are out of scope. On the parse
side, both `parseS3Error` and `parseListObjectsV2CommandOutput`
(`packages/adapter-node/src/xml.ts`) reject any body containing a
`<!DOCTYPE` *before* the parser sees the bytes — a deliberate
XXE / billion-laughs / entity-shadow (CVE-2026-25896) defense, since
S3/R2/MinIO/GCS never emit a DOCTYPE here.

The runtime parser is `@rgrove/parse-xml`, which parses and discards DTDs
without resolving custom entities — so the entity-expansion CVE class cannot
recur even if the regex guard above ever regressed. The `<!DOCTYPE` guard is
parser-independent defense-in-depth that makes entity-expansion vectors
unreachable regardless of which parser is in use.

A malformed percent-escape (a bare `%` or `%ZZ`) in a key field makes
`decodeURIComponent` throw a raw `URIError`. `xmlVal`
(`packages/adapter-node/src/xml.ts`) catches it and re-raises as
`BaerlyError("InvalidResponse")` so the storage layer surfaces a typed,
catchable error rather than an unhandled runtime exception (covered by
`xml.test.ts`).

> Latent hardening (noted as an invariant, not yet implemented):
> `baerly doctor --bucket` should probe that the backend honors
> `encoding-type=url`.
