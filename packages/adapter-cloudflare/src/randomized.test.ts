/* eslint-disable no-underscore-dangle -- `__BAERLY_R2_BINDING__` is the
   ticket-06 contract: miniflare's vitest pool sets the global, this file
   reads it. Underscores delimit the protocol-internal name. */

/**
 * Randomized causal-consistency cascade — Workerd variant.
 *
 * Runs under the `cloudflare-pool` vitest project, picking up the R2
 * binding that `tests/setup/r2-binding.ts` re-publishes on
 * `globalThis.__BAERLY_R2_BINDING__`. The cascade body itself is
 * shared with the Node-side variants
 * (`tests/integration/randomized.test.ts`) via the backend-agnostic
 * driver in `tests/fixtures/randomized-cascade.ts`.
 *
 * No fault-injection twiddler: R2's miniflare backend is in-process
 * and the `r2BindingStorage` adapter has no network seam to twiddle.
 * The cascade still exercises CAS contention through `ServerWriter`
 * — that's the property under test here.
 */

import { describe, test } from "vitest";
import { uuid, type Storage } from "@baerly/protocol";
import {
  runCausalConsistencyCascade,
  runRangeWalkParityCascade,
} from "../../../tests/fixtures/randomized-cascade.ts";
import { r2BindingStorage } from "./r2-binding-storage.ts";

const getBinding = (): R2Bucket => {
  const bucket = (globalThis as { __BAERLY_R2_BINDING__?: R2Bucket }).__BAERLY_R2_BINDING__;
  if (bucket === undefined) {
    throw new Error(
      "randomized cascade: globalThis.__BAERLY_R2_BINDING__ missing — expected wiring from tests/setup/r2-binding.ts under the cloudflare-pool vitest project",
    );
  }
  return bucket;
};

describe("randomized (Db + ServerWriter)", () => {
  describe("cloudflare-r2", () => {
    test(
      "causal consistency all-to-all, single key (multi-instance)",
      { timeout: 60 * 1000 },
      async () => {
        const N = 3;
        const binding = getBinding();
        // All N writers share the same R2 binding. The
        // tests/setup/r2-binding.ts beforeEach has already drained the
        // bucket; the bucket name is purely for log readability —
        // every R2 object lives under `binding`.
        void uuid().slice(0, 8);
        const storages: Storage[] = Array.from({ length: N }, () => r2BindingStorage(binding));
        await runCausalConsistencyCascade({
          storages,
          // R2 miniflare propagation is in-process but still slower
          // than memory; 25ms keeps the poll loop responsive without
          // burning CPU.
          pollTickMs: 25,
        });
      },
    );

    test(
      "range/$in walk parity vs. in-memory full-scan (string-typed bounds only)",
      { timeout: 60 * 1000 },
      async () => {
        const binding = getBinding();
        const storage: Storage = r2BindingStorage(binding);
        await runRangeWalkParityCascade({ storage });
      },
    );
  });
});
