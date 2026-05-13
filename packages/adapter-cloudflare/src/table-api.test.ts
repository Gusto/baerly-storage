/* eslint-disable no-underscore-dangle -- `__BAERLY_R2_BINDING__` is the
   ticket-06 contract: miniflare's vitest pool sets the global, this file
   reads it. Underscores delimit the protocol-internal name. */

/**
 * Table-API integration cascade — Workerd variant.
 *
 * Runs under the `cloudflare-pool` vitest project, picking up the R2
 * binding that `tests/setup/r2-binding.ts` re-publishes on
 * `globalThis.__BAERLY_R2_BINDING__`. The cascade body itself is
 * shared with the Node-side variants
 * (`tests/integration/table-api.test.ts`) via the backend-agnostic
 * driver in `tests/fixtures/table-api-cascade.ts`.
 *
 * No fault-injection twiddler: R2's miniflare backend is in-process
 * and the `r2BindingStorage` adapter has no network seam to twiddle.
 * The cascade asserts contract shape (cardinality preconditions,
 * frozen LogEntry shape), not convergence-under-partition — those
 * properties live in `randomized.test.ts`.
 */

import { describe, test } from "vitest";
import { runTableApiCascade } from "../../../tests/fixtures/table-api-cascade.ts";
import { r2BindingStorage } from "./r2-binding-storage.ts";

const getBinding = (): R2Bucket => {
  const bucket = (globalThis as { __BAERLY_R2_BINDING__?: R2Bucket }).__BAERLY_R2_BINDING__;
  if (bucket === undefined) {
    throw new Error(
      "table-api cascade: globalThis.__BAERLY_R2_BINDING__ missing — expected wiring from tests/setup/r2-binding.ts under the cloudflare-pool vitest project",
    );
  }
  return bucket;
};

describe("table API", () => {
  describe("cloudflare-r2", () => {
    test(
      "happy-path + writes + transactions + LogEntry shape",
      { timeout: 60 * 1000 },
      async () => {
        const binding = getBinding();
        // Two `r2BindingStorage` wrappers over the SAME binding share
        // a backing store, so the cross-writer Conflict assertion can
        // run on cloudflare-r2 the same way it does on memory /
        // local-fs.
        await runTableApiCascade({
          storage: r2BindingStorage(binding),
          rivalStorage: r2BindingStorage(binding),
        });
      },
    );
  });
});
