import type { Branded } from "./types";

export type b64 = Branded<string, "b64">;

export const toB64 = (a: Uint8Array): b64 => <b64>a.toBase64();

export const fromB64 = (a: b64): Uint8Array => Uint8Array.fromBase64(a);

export const or = (a: b64, b: b64): b64 => {
  const bi = fromB64(b);
  return toB64(fromB64(a).map((a, i) => a | bi[i]!));
};

/**
 * Test if the 1s in bitstring A are all present in B
 */
export const inside = (a: b64, b: b64): boolean => {
  // Every bit set in A must also be set in B: (A & B) === A.
  const bi = fromB64(b);
  return fromB64(a).reduce((acc, ai, i) => acc && (ai & bi[i]!) === ai, true);
};
