import { BaerlyError } from "@baerly/protocol";

/**
 * On-disk encoding of `Storage` keys for `LocalFsStorage`.
 *
 * Keys are byte-exact everywhere else (S3, R2, `MemoryStorage`), but a
 * filesystem may fold case and Unicode normalization (default macOS APFS
 * does both), which would merge `A`/`a` or NFC/NFD `é` onto one file. So
 * each `/`-segment is escaped into an alphabet that every case fold and
 * every normalization form leaves unchanged:
 *
 * - `a-z`, `0-9`, `-`, `_` stay literal, and so does `.` except where it
 *   would start an on-disk name.
 * - Every other UTF-8 byte becomes `%` plus two lowercase hex digits:
 *   `A` → `%41`, `é` (NFC) → `%c3%a9`, `é` (NFD) → `e%cc%81`.
 *
 * Decoding the encoding returns the original key, so distinct keys get
 * distinct names, and folding those names changes nothing. Kernel-written
 * segments (`log/<seq>`, `current.json`, base-32 index values, UUIDv7
 * ids) are already in the literal set, so they look the same on disk.
 *
 * No on-disk name ever starts with `.`, which leaves every dot-prefixed
 * name (staging temps, the format marker, a stray `.DS_Store`) private to
 * the adapter.
 *
 * **`NAME_MAX`.** Escaping can triple a segment, and filenames cap at 255
 * bytes on APFS and ext4. An encoded segment longer than that is split
 * into directory components of at most {@link MAX_PART_BYTES} bytes, each
 * but the last ending in {@link CONTINUATION}. `~` is always escaped by
 * the encoding, so a trailing `~` can only mean "continued". Splits fall
 * only between tokens (a literal byte or a `%xx` triplet).
 */

/** Filename limit on APFS and ext4. */
export const NAME_MAX_BYTES = 255;

/** Marks a directory component as the head of a split segment. */
export const CONTINUATION = "~";

/** Longest component that still fits {@link CONTINUATION} under `NAME_MAX`. */
const MAX_PART_BYTES = NAME_MAX_BYTES - CONTINUATION.length;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Bytes that stay literal: `-` `.` `0-9` `_` `a-z`. `.` is special-cased. */
const isLiteralByte = (b: number): boolean =>
  (b >= 0x61 && b <= 0x7a) || // a-z
  (b >= 0x30 && b <= 0x39) || // 0-9
  b === 0x2d || // -
  b === 0x5f || // _
  b === 0x2e; // .

const DOT = 0x2e;

const escapeByte = (b: number): string => `%${b.toString(16).padStart(2, "0")}`;

/** Tokens of one encoded segment: a literal char or a `%xx` triplet. */
const tokenize = (segment: string): string[] => {
  const tokens: string[] = [];
  for (const b of utf8Encoder.encode(segment)) {
    tokens.push(isLiteralByte(b) ? String.fromCharCode(b) : escapeByte(b));
  }
  return tokens;
};

/**
 * Pack tokens into on-disk components. A component never starts with a
 * literal `.`: such a token is written as `%2e` instead.
 */
const pack = (tokens: string[], limit: number): string[] => {
  const parts: string[] = [];
  let current = "";
  for (let token of tokens) {
    if (current.length + token.length > limit) {
      parts.push(current);
      current = "";
    }
    if (current === "" && token === ".") {
      token = escapeByte(DOT);
    }
    current += token;
  }
  parts.push(current);
  return parts;
};

/** Encode one non-empty `/`-segment into its on-disk component(s). */
export const encodeSegment = (segment: string): string[] => {
  const tokens = tokenize(segment);
  const single = pack(tokens, Number.POSITIVE_INFINITY);
  if (single[0]!.length <= NAME_MAX_BYTES) {
    return single;
  }
  const parts = pack(tokens, MAX_PART_BYTES);
  return parts.map((p, i) => (i < parts.length - 1 ? p + CONTINUATION : p));
};

/**
 * Encode a key into on-disk path components. The caller has already
 * validated the key's `/`-structure (no empty, `.`, or `..` segment).
 * Rejects a key that is not well-formed UTF-16: `TextEncoder` maps every
 * lone surrogate to U+FFFD, which would make the encoding non-injective.
 */
export const encodeKey = (key: string): string[] => {
  if (!key.isWellFormed()) {
    throw new BaerlyError(
      "InvalidConfig",
      `LocalFsStorage: key is not well-formed UTF-16 (lone surrogate): ${JSON.stringify(key)}`,
    );
  }
  return key.split("/").flatMap(encodeSegment);
};

const HEX = /^[0-9a-f]{2}$/;

/** Decode one component's bytes (continuation marker already stripped). */
const decodeBytes = (component: string, out: number[]): boolean => {
  for (let i = 0; i < component.length; i++) {
    const c = component.charCodeAt(i);
    if (c === 0x25) {
      const hex = component.slice(i + 1, i + 3);
      if (!HEX.test(hex)) {
        return false;
      }
      out.push(Number.parseInt(hex, 16));
      i += 2;
    } else if (isLiteralByte(c)) {
      out.push(c);
    } else {
      return false;
    }
  }
  return true;
};

/**
 * Decode on-disk path components (relative to the root) back to a key.
 * Returns `null` for anything that is not the canonical encoding of some
 * key — a foreign file, a non-canonical escape, a dangling continuation —
 * so the caller can decide how loudly to fail.
 */
export const decodeComponents = (components: readonly string[]): string | null => {
  const segments: string[] = [];
  let bytes: number[] = [];
  for (const component of components) {
    const continued = component.endsWith(CONTINUATION);
    const body = continued ? component.slice(0, -CONTINUATION.length) : component;
    if (body === "" || !decodeBytes(body, bytes)) {
      return null;
    }
    if (!continued) {
      let segment: string;
      try {
        segment = utf8Decoder.decode(new Uint8Array(bytes));
      } catch {
        return null;
      }
      if (segment === "." || segment === "..") {
        return null; // not a valid key segment
      }
      segments.push(segment);
      bytes = [];
    }
  }
  if (bytes.length > 0 || segments.length === 0) {
    return null; // ends mid-segment
  }
  const key = segments.join("/");
  // Canonical-form check: exactly one spelling per key, so `list` can
  // never report a key under two names (`%61` vs `a`, `%2E` vs `%2e`,
  // a split in the wrong place).
  let canonical: string[];
  try {
    canonical = encodeKey(key);
  } catch {
    return null;
  }
  if (canonical.length !== components.length || canonical.some((c, i) => c !== components[i])) {
    return null;
  }
  return key;
};
