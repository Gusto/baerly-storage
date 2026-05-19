/**
 * Constant-time byte-array equality. Length mismatch short-circuits —
 * the attacker already knows the expected length is a few-dozen bytes,
 * so revealing it is a non-secret. The diff loop only runs when the
 * lengths match, so its timing cannot leak the position of the first
 * differing byte.
 *
 * Hoisted out of {@link sharedSecret} so {@link awsIamSigV4}'s
 * signature comparison can reuse the same implementation — one TODO
 * is easier to land than two.
 */
export const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
};
