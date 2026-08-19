/**
 * Byte-level mutation primitives for systematic corruption testing.
 *
 * Each helper returns a new `Uint8Array` with the mutation applied; the
 * input is never mutated. Mutations are deterministic and documented.
 */

/** Returns a copy of `bytes` truncated to its first `at` bytes. */
export function truncateBytes(bytes: Uint8Array, at: number): Uint8Array {
  return bytes.slice(0, at);
}

/** Returns a copy of `bytes` with bit 0 flipped at position `at`. */
export function flipByte(bytes: Uint8Array, at: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  copy[at] = copy[at]! ^ 0b0000_0001;
  return copy;
}

/** Returns a copy of `bytes` with `byte` inserted at position `at`. */
export function insertByte(bytes: Uint8Array, at: number, byte: number): Uint8Array {
  const copy = new Uint8Array(bytes.length + 1);
  copy.set(bytes.slice(0, at), 0);
  copy[at] = byte;
  copy.set(bytes.slice(at), at + 1);
  return copy;
}

/** Returns a copy of `bytes` with the `length`-byte slice starting at `at` duplicated in place. */
export function duplicateBytes(bytes: Uint8Array, at: number, length: number): Uint8Array {
  const slice = bytes.slice(at, at + length);
  const copy = new Uint8Array(bytes.length + slice.length);
  copy.set(bytes.slice(0, at), 0);
  copy.set(slice, at);
  copy.set(bytes.slice(at), at + slice.length);
  return copy;
}

/** Returns a copy of `bytes` with the bytes at `atA` and `atB` swapped. */
export function swapBytes(bytes: Uint8Array, atA: number, atB: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  const temp = copy[atA]!;
  copy[atA] = copy[atB]!;
  copy[atB] = temp;
  return copy;
}

/**
 * Corrupts the first multi-byte UTF-8 sequence at or after `at` by flipping
 * bit 6 of its lead byte (`0b1xxxxxxx` → `0b1x0xxxxx`), turning a valid
 * continuation/lead byte into an invalid one so UTF-8 decoding fails.
 * Returns `bytes` unchanged if no byte with the high bit set is found.
 */
export function corruptUtf8(bytes: Uint8Array, at: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  for (let i = at; i < copy.length; i++) {
    if ((copy[i]! & 0x80) !== 0) {
      copy[i] = copy[i]! ^ 0x40;
      return copy;
    }
  }
  return copy;
}

/**
 * Corrupts the first JSON escape sequence at or after `at` by replacing its
 * backslash (`0x5c`) with a forward slash (`0x2f`), breaking the escape.
 * Returns `bytes` unchanged if no backslash is found.
 */
export function corruptJsonEscape(bytes: Uint8Array, at: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  for (let i = at; i < copy.length; i++) {
    if (copy[i] === 0x5c) {
      copy[i] = 0x2f;
      return copy;
    }
  }
  return copy;
}

/**
 * Corrupts the first ASCII digit (`0x30`-`0x39`) at or after `at` by
 * flipping its low bit (`0↔1`, `2↔3`, …, `8↔9`). Returns `bytes` unchanged
 * if no digit is found.
 */
export function corruptNumber(bytes: Uint8Array, at: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  for (let i = at; i < copy.length; i++) {
    if (copy[i]! >= 0x30 && copy[i]! <= 0x39) {
      copy[i] = copy[i]! ^ 0x01;
      return copy;
    }
  }
  return copy;
}
