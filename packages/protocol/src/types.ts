declare const brand: unique symbol;
type Brand<B> = { [brand]: B };

/**
 * Nominal-typing helper. `Branded<string, "UUID">` is a `string` at
 * runtime but the type system rejects mixing it with a plain `string` or
 * a string branded as something else. Used to prevent confusion bugs at
 * protocol boundaries (UUIDs vs. content versions are both strings, but
 * using the wrong one corrupts the manifest log).
 *
 * Construct branded values via the helpers in this file (e.g. {@link uuid})
 * or with a tagged cast at a single, deliberate boundary — never `as string`
 * to widen one back. See `docs/contributing/conventions/src.md`.
 */
export type Branded<T, B> = T & Brand<B>;

/**
 * A v4 UUID minted by this client. Used as session IDs and content
 * identifiers in non-versioned mode.
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
export const uuid = (): UUID => crypto.randomUUID() as UUID;

/**
 * Mint a UUIDv7 — 48-bit Unix-millis prefix + 74 bits of randomness,
 * formatted as a standard 8-4-4-4-12 UUID string per RFC 9562 §5.7.
 * Lex-sortable by mint time, so it pairs well with object-storage
 * list semantics. Returns a branded {@link UUID}.
 *
 * Uses `crypto.getRandomValues` which is universally available
 * (Node 19+, Workerd, Bun, browsers).
 *
 * @example
 * ```ts
 * const id = uuidv7();
 * // e.g. "01956cad-4cc8-7abc-9def-0123456789ab"
 * ```
 */
export const uuidv7 = (): UUID => {
  const millis = Date.now();
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  // Version nibble: top 4 bits of rand[0] = 0b0111 (v7). The byte
  // sits at the start of the "version-and-rand-a" group below.
  rand[0] = (rand[0]! & 0x0f) | 0x70;
  // Variant bits: top 2 bits of rand[2] = 0b10 (RFC 4122 variant).
  // This byte starts the "variant-and-rand-b" group below.
  rand[2] = (rand[2]! & 0x3f) | 0x80;
  const millisHex = millis.toString(16).padStart(12, "0");
  const b = Array.from(rand, (n) => n.toString(16).padStart(2, "0")).join("");
  return `${millisHex.slice(0, 8)}-${millisHex.slice(8, 12)}-${b.slice(0, 4)}-${b.slice(4, 8)}-${b.slice(8, 20)}` as UUID;
};

/**
 * Mint the trailing seq segment of an LSN (`<base32-time>_<sess>_<seq>`).
 * `COUNT_BIT_WIDTH = 10` (matches `packages/protocol/src/log.ts:145`)
 * gives a 2-char descending base-32 string with a domain of 0..1023.
 *
 * Used together with {@link timestamp} (the descending base-32
 * encoding of millis-since-epoch). See {@link uint2strDesc} for the
 * lex-reversal property both rely on.
 */
export const countKey = (number: number): string => uint2strDesc(number, 10);

export const uint2str = (num: number, bits: number) => {
  const maxBase32Length = Math.ceil(bits / 5); // Change from 4 to 5 because log2(32) is roughly 5.
  const base32Representation = num.toString(32);
  return base32Representation.padStart(maxBase32Length, "0");
};

export const str2uint = (str: string) => {
  return parseInt(str, 32); // Parse the string as base 32.
};

/**
 * Lex-reversed base-32 encoder for an unsigned integer in `[0, 2^bits)`.
 * Pads to `Math.ceil(bits/5)` chars so all values in the domain compare
 * lex against each other.
 *
 * **Order-reversal property:** for any pair of integers `a < b` (with
 * `a, b ∈ [0, 2^bits)`), `uint2strDesc(a, bits) > uint2strDesc(b, bits)`
 * lexicographically. Composed into an LSN of shape
 * `<base32-time>_<session>_<seq>` (where both `<base32-time>` and
 * `<seq>` use this encoder), a forward `Storage.list(prefix)`
 * returns log entries in reverse-causal order — newer entries first.
 *
 * This is the structural property the read path leans on:
 * `ListObjectsV2` is forward-only on S3, but the descending encoding
 * makes "fetch the K newest entries" a single bounded LIST with
 * `maxKeys=K` instead of a full-population LIST + in-memory reverse.
 *
 * Behaviourally verified across randomized populations in
 * `packages/protocol/src/lsn-reverse-list.test.ts`. Quantified
 * bytes-listed reduction is in
 * `docs/spec/attachments/lsn-reverse-walk-baseline.json`
 * (run `pnpm bench:lsn-reverse-walk` to reproduce). Spec rationale:
 * `docs/spec/sync-protocol.md` §"Subtleties of the manifest key".
 */
export const uint2strDesc = (num: number, bits: number): string => {
  const maxValue = Math.pow(2, bits) - 1;
  return uint2str(maxValue - num, bits);
};

export const str2uintDesc = (str: string, bits: number): number => {
  const maxValue = Math.pow(2, bits) - 1;
  const num = parseInt(str, 32); // Convert base32 string to number
  return maxValue - num;
};
