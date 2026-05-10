import { MPS3Error } from "./errors";

declare const brand: unique symbol;
type Brand<B> = { [brand]: B };

/**
 * Nominal-typing helper. `Branded<string, "Manifest">` is a `string` at
 * runtime but the type system rejects mixing it with a plain `string` or
 * a string branded as something else. Used to prevent confusion bugs at
 * protocol boundaries (manifest keys vs. UUIDs vs. S3 version IDs are all
 * strings, but using the wrong one corrupts the manifest log).
 *
 * Construct branded values via the helpers in this file (e.g. {@link uuid})
 * or with a tagged cast at a single, deliberate boundary — never `as string`
 * to widen one back. See `docs/conventions/src.md`.
 */
export type Branded<T, B> = T & Brand<B>;

export type DeleteValue = undefined;

/**
 * Document reference (bucket optional, defaults to the MPS3 instance's
 * default bucket). The {@link MPS3} public API accepts `Ref`; internal
 * code that needs a fully-qualified address uses {@link ResolvedRef}.
 */
export interface Ref {
  bucket?: string;
  key: string;
}

/** A {@link Ref} after the default bucket has been applied. */
export interface ResolvedRef extends Ref {
  bucket: string;
  key: string;
}

/**
 * S3 object key for a manifest log entry. Shape is
 * `<base32-time>_<session>_<seq>` — order is load-bearing because the
 * sync protocol relies on lexicographic time ordering.
 *
 * @see `docs/sync_protocol.md` (manifest log section)
 */
export type ManifestKey = Branded<string, "Manifest">;

/**
 * A v4 UUID minted by this client. Used as session IDs and content
 * identifiers in non-versioned mode. Distinct from {@link VersionId},
 * which is assigned by the S3 backend, and {@link Ref}, which addresses
 * a logical document.
 */
export type UUID = Branded<string, "UUID">;

/**
 * SHA-256 content digest, lowercase hex truncated to
 * `VERSION_HEX_LENGTH` (32 chars). Minted by
 * `versionFromContent` in `useVersioning=false` mode and used as
 * the `<key>@<version>` suffix in content keys.
 *
 * The synthetic `local-${op}` placeholder used for in-flight
 * optimistic updates also wears this brand — it never round-trips
 * to S3, only flows through the local manifest poll loop.
 */
export type ContentVersionId = Branded<string, "ContentVersionId">;

/**
 * Opaque object-version identifier assigned by S3 when bucket
 * versioning is enabled. Surfaces in the `x-amz-version-id`
 * response header. Format is implementation-defined.
 */
export type S3VersionId = Branded<string, "S3VersionId">;

/**
 * Either a content-addressed or S3-assigned version. Stored
 * opaquely in `FileState.version`; consumers (manifest poll loop,
 * `getObject`) treat it as a string identifier.
 */
export type VersionId = ContentVersionId | S3VersionId;

/**
 * Structural minimum of the XML parser surface used by `parseListObjectsV2CommandOutput`.
 * Defined here (instead of relying on `lib.dom` `DOMParser`) so consumers can plug in
 * `@xmldom/xmldom` (whose types decoupled from `lib.dom` in 0.9.x) or any other
 * conforming parser without TypeScript rejecting the substitution.
 */
export interface XmlNode {
  readonly textContent: string | null;
  getElementsByTagName(name: string): ArrayLike<XmlNode>;
}
export interface XmlParser {
  parseFromString(source: string, mimeType: string): XmlNode | null | undefined;
}

/**
 * Mint a fresh {@link UUID}. The cast lives here so callers don't sprinkle
 * `<UUID>crypto.randomUUID()` throughout the codebase.
 */
export const uuid = (): UUID => <UUID>crypto.randomUUID();

/**
 * Re-brand a {@link UUID} as a {@link ContentVersionId}. Used in
 * non-versioned mode where the synthetic content version is a fresh
 * UUID — the cast is intentional and centralized here so callers
 * don't sprinkle `<ContentVersionId><unknown>` workarounds throughout
 * the codebase.
 */
export const versionFromUuid = (u: UUID): ContentVersionId => u as unknown as ContentVersionId;
/**
 * Resolve a user-supplied content reference (`string` shorthand or
 * partial {@link Ref}) into a fully-qualified {@link ResolvedRef}.
 * Bucket falls back to `defaultBucket`. Replaces the duplicated
 * `(<Ref>ref).bucket || ...` pattern that used to live at every
 * call site.
 */
export const resolveContentRef = (
  ref: string | Ref,
  config: { defaultBucket: string }
): ResolvedRef =>
  typeof ref === "string"
    ? { bucket: config.defaultBucket, key: ref }
    : { bucket: ref.bucket ?? config.defaultBucket, key: ref.key };

/**
 * Resolve a (possibly absent) manifest override against the
 * configured default manifest. Field-level merge: the override's
 * `bucket` and/or `key` win when set.
 */
export const resolveManifestRef = (
  ref: Ref | undefined,
  defaultManifest: ResolvedRef
): ResolvedRef => ({ ...defaultManifest, ...ref });

export const countKey = (number: number): string => uint2strDesc(number, 10);
export const eq = (a: Ref, b: Ref) => a.bucket === b.bucket && a.key === b.key;
export const url = (ref: Ref): string => `${ref.bucket}/${ref.key}`;
export const parseUrl = (input: string): ResolvedRef => {
  const [bucket, ...key] = input.split("/");
  if (bucket === undefined) throw new MPS3Error("InvalidConfig", `Invalid url: ${input}`);
  return {
    bucket,
    key: key.join("/"),
  };
};

export const uint2str = (num: number, bits: number) => {
  const maxBase32Length = Math.ceil(bits / 5); // Change from 4 to 5 because log2(32) is roughly 5.
  const base32Representation = num.toString(32);
  return base32Representation.padStart(maxBase32Length, "0");
};

export const str2uint = (str: string) => {
  return parseInt(str, 32); // Parse the string as base 32.
};

export const uint2strDesc = (num: number, bits: number): string => {
  const maxValue = Math.pow(2, bits) - 1;
  return uint2str(maxValue - num, bits);
};

export const str2uintDesc = (str: string, bits: number): number => {
  const maxValue = Math.pow(2, bits) - 1;
  const num = parseInt(str, 32); // Convert base32 string to number
  return maxValue - num;
};
