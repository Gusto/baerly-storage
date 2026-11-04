import { COUNT_BIT_WIDTH } from "./constants.ts";

// Re-exported so existing `./types.ts` importers keep working; the
// implementations live in `./uuid.ts` so a consumer that needs only
// `uuidv7` (the client) does not pull in this module's base-32 helpers.
export { uuidv7 } from "./uuid.ts";

declare const brand: unique symbol;
type Brand<B> = { [brand]: B };

/**
 * Nominal-typing helper. `Branded<string, "UUID">` is a `string` at
 * runtime but the type system rejects mixing it with a plain `string` or
 * a string branded as something else. Used to prevent confusion bugs at
 * protocol boundaries (UUIDs vs. legacy content versions are both
 * strings, but using the wrong one corrupts the per-collection log).
 *
 * Construct branded values via the helpers in this file (e.g. {@link uuid})
 * or with a tagged cast at a single, deliberate boundary — never `as string`
 * to widen one back. See `docs/contributing/conventions/src.md`.
 */
export type Branded<T, B> = T & Brand<B>;

/**
 * A UUID minted by this client. {@link uuid} returns v4 values used for
 * writer-session entropy and storage probe keys; {@link uuidv7} returns
 * time-sortable v7 values for caller-facing identifiers. Content side
 * objects use the separate legacy {@link ContentVersionId} hash brand.
 */
export type UUID = Branded<string, "UUID">;

/**
 * Legacy content-key digest: lowercase SHA-256 hex truncated to 32
 * characters (128 bits), minted by `versionFromContent`. v0.6.0 writers
 * used it to name `content/<hash>.json` side objects; the current kernel
 * retains the brand only for legacy inspection or direct-bucket tooling.
 * Current writers do not mint content side objects, and current GC never
 * touches `content/`.
 */
export type ContentVersionId = Branded<string, "ContentVersionId">;

/**
 * Mint a fresh {@link UUID}. The cast lives here so callers don't sprinkle
 * `<UUID>crypto.randomUUID()` throughout the codebase.
 */
export const uuid = (): UUID => crypto.randomUUID() as UUID;

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * True iff `s` has exactly the shape {@link uuidv7} produces: canonical
 * lowercase 8-4-4-4-12 hex, version nibble `7`, variant nibble in
 * `[89ab]`.
 */
export const isUuidV7 = (s: string): s is UUID => UUID_V7_RE.test(s);

/**
 * Mint the trailing seq segment of an LSN (`<base32-time>_<sess>_<seq>`).
 * Uses `COUNT_BIT_WIDTH` (see `packages/protocol/src/constants.ts`) to
 * produce an 11-char descending base-32 string with a domain of
 * 0 .. `Number.MAX_SAFE_INTEGER` (2^53 − 1).
 *
 * Used together with {@link timestamp} (the descending base-32
 * encoding of millis-since-epoch). See {@link uint2strDesc} for the
 * lex-reversal property both rely on.
 */
export const countKey = (number: number): string => uint2strDesc(number, COUNT_BIT_WIDTH);

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
 * `docs/spec/sync-protocol.md` §"LSNs, wall clocks, and downstream
 * consumers".
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
