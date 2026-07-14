import { BaerlyError } from "@baerly/protocol";
import { parseXml, type XmlDocument, type XmlElement, type XmlText } from "@rgrove/parse-xml";

/**
 * Subset of S3's `ListObjectsV2CommandOutput` produced by
 * {@link parseListObjectsV2CommandOutput}. Field names mirror the
 * S3 REST API exactly (PascalCase) so the parser stays a thin shape
 * over the wire format.
 */
export interface ParsedListObjectsV2Output {
  Contents?: Array<{ ETag?: string; Key?: string; LastModified?: Date; Generation?: string }>;
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

// --- parse-xml helpers ---

// Strip any namespace prefix: "s3:Contents" -> "Contents", "Contents" -> "Contents".
// The `includes(":")` guard makes the `split(":")[1]!` non-null assertion safe.
const localName = (name: string): string => (name.includes(":") ? name.split(":")[1]! : name);

// Type predicates narrowing an XmlNode child to a concrete node class.
// @rgrove/parse-xml types the `type` discriminant as `string` (not a string
// literal), so `node.type === "element"` does NOT narrow the child union on its
// own. These localize the one unavoidable assertion behind a checked predicate
// instead of scattering `as XmlElement` / `as XmlText` casts at each use site.
const isElement = (node: XmlElement["children"][number]): node is XmlElement =>
  node.type === "element";
const isText = (node: XmlElement["children"][number]): node is XmlText => node.type === "text";

// Return the first XmlElement child of a document or element whose local name
// (after any namespace prefix) matches `name`. This makes traversal
// namespace-agnostic: both `<Error>` and `<ns:Error>` match name "Error".
const child = (el: XmlElement, name: string): XmlElement | undefined => {
  for (const node of el.children) {
    if (isElement(node) && localName(node.name) === name) {
      return node;
    }
  }
  return undefined;
};

// Concatenate the direct text child node text values of an element.
// @rgrove/parse-xml resolves the 5 predefined XML entities (&amp; &lt; &gt;
// &quot; &apos;) and decimal/hex numeric character references (e.g. Minio's
// &#34; ETags) by default. Under the default `preserveCdata: false` (which is
// how we call parseXml), any CDATA section is merged into the element's adjacent
// text nodes and surfaces as an XmlText (type "text"), so the "text" branch
// captures it — there is never a standalone "cdata" node. Entities inside a
// CDATA section are NOT decoded (CDATA is literal), which is the correct S3
// behavior. We intentionally do NOT decode HTML named entities (&nbsp; etc.) —
// S3 wire data is XML, not HTML, so this is more spec-correct.
const textOf = (el: XmlElement | undefined): string | undefined => {
  if (el === undefined) {
    return undefined;
  }
  let result = "";
  for (const node of el.children) {
    if (isText(node)) {
      result += node.text;
    }
  }
  return result === "" ? undefined : result;
};

// Return the first-element-child of an XmlDocument. Unlike `XmlDocument.root`
// (which is an XmlElement | null getter), this avoids potential null handling
// confusion by returning undefined on an empty document.
const docRoot = (doc: XmlDocument): XmlElement | undefined => doc.root ?? undefined;

// The list request sets `encoding-type=url`, so S3 URL-encodes the **key
// family only** (Key/Prefix/Delimiter/StartAfter) in the response,
// including spaces as `+`. Use this to reverse both steps. Do NOT apply it
// to ETag or NextContinuationToken — S3 leaves those verbatim, and a
// continuation token routinely contains literal `+` that the `.replace`
// step would mangle into a space (corrupting pagination on large buckets).
const xmlVal = (el: XmlElement | undefined, name: string): string | undefined => {
  const v = el !== undefined ? textOf(child(el, name)) : undefined;
  if (v === undefined || v === "") {
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
const rawXmlVal = (el: XmlElement | undefined, name: string): string | undefined => {
  return el !== undefined ? textOf(child(el, name)) : undefined;
};

/**
 * Build a {@link ParsedS3Error} from the element that directly carries
 * the `<Code>` / `<Message>` children — `<Error>` for S3, the inner
 * `<Error>` for STS. Returns `undefined` when neither child is present
 * so callers can fall back to the raw status. Shared by
 * {@link parseS3Error} and {@link parseStsError}, which differ only in
 * how they locate that element.
 */
const codeMessageFrom = (el: XmlElement): ParsedS3Error | undefined => {
  const code = rawXmlVal(el, "Code");
  const message = rawXmlVal(el, "Message");
  if (code === undefined && message === undefined) {
    return undefined;
  }
  return {
    ...(code !== undefined && { Code: code }),
    ...(message !== undefined && { Message: message }),
  };
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
  let root: XmlElement | undefined;
  try {
    root = docRoot(parseXml(xml));
  } catch {
    return undefined;
  }
  // The root element must be <Error> (possibly namespace-prefixed).
  if (root === undefined) {
    return undefined;
  }
  if (localName(root.name) !== "Error") {
    return undefined;
  }
  return codeMessageFrom(root);
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
  let root: XmlElement | undefined;
  try {
    root = docRoot(parseXml(xml));
  } catch {
    return undefined;
  }
  if (root === undefined) {
    return undefined;
  }
  // STS wraps <Error> inside <ErrorResponse>; locate the inner <Error> child.
  const errorEl = child(root, "Error");
  if (errorEl === undefined) {
    return undefined;
  }
  return codeMessageFrom(errorEl);
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
 * `<Credentials>` block. Reuses the hardened, DTD-guarded parser;
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
  let root: XmlElement | undefined;
  try {
    root = docRoot(parseXml(xml));
  } catch {
    // No body in the message — see the note above; it may contain live creds.
    throw new BaerlyError("InvalidResponse", "unparseable STS credentials response");
  }
  // Traverse: <AssumeRoleWithWebIdentityResponse>
  //             <AssumeRoleWithWebIdentityResult>
  //               <Credentials>
  const resultEl = root !== undefined ? child(root, "AssumeRoleWithWebIdentityResult") : undefined;
  const credsEl = resultEl !== undefined ? child(resultEl, "Credentials") : undefined;
  return {
    AccessKeyId: rawXmlVal(credsEl, "AccessKeyId"),
    SecretAccessKey: rawXmlVal(credsEl, "SecretAccessKey"),
    SessionToken: rawXmlVal(credsEl, "SessionToken"),
    Expiration: rawXmlVal(credsEl, "Expiration"),
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

// DTD guard: reject any DOCTYPE before @rgrove/parse-xml sees the bytes. S3/R2/
// MinIO/GCS never emit a DOCTYPE here, so one is always a bug or an attack —
// this defangs the DOCTYPE entity vectors (XXE, billion-laughs, the
// CVE-2026-25896 entity-shadow). @rgrove/parse-xml is safe-by-design (refuses
// DTD entity definitions), but the regex guard is parser-independent
// defense-in-depth and independently covers the entity-expansion CVE class.
export const parseListObjectsV2CommandOutput = (xml: string): ParsedListObjectsV2Output => {
  if (/<!DOCTYPE\b/i.test(xml)) {
    throw new BaerlyError("InvalidResponse", "DTD not allowed in S3 XML responses");
  }
  let root: XmlElement | undefined;
  try {
    root = docRoot(parseXml(xml));
  } catch {
    throw new BaerlyError("InvalidResponse", `Invalid XML: ${xml}`);
  }
  if (root === undefined) {
    return {};
  }
  // The root element must be <ListBucketResult> (possibly namespace-prefixed).
  // This restores main's `result.ListBucketResult ?? {}` structural guard and
  // matches the sibling error parsers' root checks: a non-list body returns {}.
  if (localName(root.name) !== "ListBucketResult") {
    return {};
  }
  // Force-array for Contents: collect all direct <Contents> element children.
  // This replaces the old `isArray: (name) => name === "Contents"` config.
  // Namespace-agnostic (matches `child()`), so `<s3:Contents>` also collects.
  const contentEls = root.children
    .filter(isElement)
    .filter((c) => localName(c.name) === "Contents");

  return {
    Contents: contentEls.map((contentEl) => {
      return {
        ETag: rawXmlVal(contentEl, "ETag"),
        Key: xmlVal(contentEl, "Key"),
        LastModified: parseLastModified(rawXmlVal(contentEl, "LastModified")),
        // GCS's list XML carries a `<Generation>` element per object (its
        // opaque version token) that S3/R2 never emit — undefined there, so
        // this is inert for the S3 path. `GcsHttpStorage.list` prefers it as
        // the entry etag so a list etag equals the generation `get`/`put`
        // return, matching the universal list-etag == version-token contract.
        Generation: rawXmlVal(contentEl, "Generation"),
      };
    }),
    NextContinuationToken: rawXmlVal(root, "NextContinuationToken"),
  };
};
