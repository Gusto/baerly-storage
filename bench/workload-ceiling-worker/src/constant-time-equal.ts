/**
 * Constant-time-ISH byte comparison for the bearer secret. No early return on
 * mismatch, and both operands are compared over the LONGER of the two
 * lengths so an attacker cannot use response timing to learn the secret's
 * length either. Not a cryptographic primitive — a deliberately small,
 * dependency-free substitute for `node:crypto`'s `timingSafeEqual`, which
 * would otherwise be this Worker's only reason to declare `nodejs_compat`.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = UTF8_ENCODER.encode(a);
  const right = UTF8_ENCODER.encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

const UTF8_ENCODER = new TextEncoder();
