import type { UUID } from "./types.ts";

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
