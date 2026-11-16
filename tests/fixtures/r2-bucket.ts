/**
 * The miniflare R2 bucket for the `cloudflare-pool` vitest project.
 *
 * `tests/setup/r2-binding.ts` publishes the pool's `BUCKET` binding on
 * `globalThis.__BAERLY_R2_BINDING__` before each test; this reads it
 * back so suites that run inside Workerd need no dependency on the
 * pool API. Node-import-free for the same reason.
 */

/* eslint-disable no-underscore-dangle -- `__BAERLY_R2_BINDING__` is the
   miniflare-pool contract set by `tests/setup/r2-binding.ts`. */

/**
 * Return the pool's R2 bucket. Throws when the global is missing (the
 * suite ran outside the `cloudflare-pool` project) — louder than a skip.
 */
export const getBinding = (): R2Bucket => {
  const bucket = (globalThis as { __BAERLY_R2_BINDING__?: R2Bucket }).__BAERLY_R2_BINDING__;
  if (bucket === undefined) {
    throw new Error(
      "globalThis.__BAERLY_R2_BINDING__ missing — wired by `tests/setup/r2-binding.ts` under the `cloudflare-pool` vitest project",
    );
  }
  return bucket;
};
