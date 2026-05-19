/// <reference types="@cloudflare/vitest-pool-workers/types" />

/* eslint-disable no-underscore-dangle -- `__BAERLY_R2_BINDING__` is
   the ticket-06 contract: the miniflare vitest pool sets the global,
   `packages/adapter-cloudflare/src/r2-binding-storage.conformance.test.ts`
   reads it. Underscores delimit the protocol-internal name. */

// Setup file for the `cloudflare-pool` vitest project. Runs inside
// Workerd via `@cloudflare/vitest-pool-workers`, so `cloudflare:test`
// resolves and `env.BUCKET` is the miniflare-provisioned R2 binding
// declared in `vitest.config.ts`. We re-publish the binding on
// `globalThis` under the agreed-upon name so the in-tree conformance
// entry (which has no dependency on the pool API) can pick it up.
//
// Keeping the bridge here — outside `packages/*/src/` — preserves the
// invariant that adapter-cloudflare's `src/` is publishable runtime
// code: nothing under it imports from `cloudflare:test`.

// `Cloudflare.Env` ships empty in `@cloudflare/workers-types`; augment
// it locally with the `BUCKET` binding wired in `vitest.config.ts`
// (`miniflare.r2Buckets: ["BUCKET"]`). This avoids a cast at the use
// site and keeps the binding name discoverable via tsgo.
declare global {
  namespace Cloudflare {
    interface Env {
      BUCKET: R2Bucket;
    }
  }
}

import { beforeEach } from "vitest";
import { env } from "cloudflare:test";

const bucket: R2Bucket = env.BUCKET;
(globalThis as { __BAERLY_R2_BINDING__?: R2Bucket }).__BAERLY_R2_BINDING__ = bucket;

// `@cloudflare/vitest-pool-workers` does NOT auto-reset R2 buckets
// between tests — only Durable Objects can be wiped via `reset()`.
// The conformance suite expects fresh storage per test (its
// `beforeEach` calls the factory, which for the R2 adapter just hands
// back a wrapper around the *same* binding). So we drain the bucket
// here, in a setup-level `beforeEach` that runs before the suite's
// own `beforeEach`. Vitest invokes setup-file hooks first by
// registration order, and `setupFiles` are registered ahead of test
// files.
//
// Drain via the R2 binding's native list/delete to avoid going
// through the adapter under test.
beforeEach(async () => {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ cursor, limit: 1000 });
    for (const obj of listed.objects) {
      keys.push(obj.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  if (keys.length > 0) {
    await bucket.delete(keys);
  }
});
