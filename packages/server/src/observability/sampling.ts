/**
 * Head-based deterministic sampling.
 *
 * {@link decideSample} hashes the request id once and compares
 * against the configured rate. Because the hash is deterministic,
 * a given request id either always samples or always doesn't —
 * useful for replay-based tests and for stable inclusion across
 * upstream/downstream services that share the id.
 *
 * Hash: 32-bit FNV-1a, inlined. Cryptographic strength is not a
 * goal here — we just need a roughly-uniform distribution over
 * the input space. FNV-1a's distribution is well-characterized
 * for short ASCII inputs (UUIDs); it's also tiny enough to fit
 * the kernel's "no new deps" rule.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const RESOLUTION = 10_000;

/**
 * Returns `true` iff `request_id` should be sampled at the
 * given `rate`. `rate` is interpreted as a probability in
 * `[0, 1]`; values outside that range are clamped (effectively
 * `rate >= 1` always samples, `rate <= 0` never samples).
 *
 * The integer compare is done at 10,000 buckets (`0.0001`
 * resolution); rate values finer than that round to the nearest
 * bucket.
 */
export const decideSample = (request_id: string, rate: number): boolean => {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const bucket = hash32(request_id) % RESOLUTION;
  return bucket < Math.floor(rate * RESOLUTION);
};

/**
 * Tiny 32-bit FNV-1a hash. Sufficient for sampling-bucket
 * assignment; do NOT use for security-sensitive comparisons.
 *
 * Operates on the UTF-16 code units of the input string. Two
 * inputs that differ only by surrogate-pair representation
 * therefore hash differently — not a problem for the UUID
 * inputs the sampler sees.
 */
const hash32 = (input: string): number => {
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // Math.imul gives a true 32-bit multiply; `>>> 0` keeps it
    // unsigned across the whole pipeline.
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h;
};
