/* eslint-disable no-underscore-dangle -- `__BAERLY_R2_BINDING__` is the
   ticket-06 contract: miniflare's vitest pool sets the global, this file
   reads it. Underscores delimit the protocol-internal name. */

import { defineStorageConformanceSuite } from "@baerly/protocol/conformance";
import { r2BindingStorage } from "./r2-binding-storage.ts";

/**
 * Conformance entry for the R2 binding adapter.
 *
 * Ticket 06-conformance-all-four-adapters.md wires the miniflare
 * runtime that supplies `globalThis.__BAERLY_R2_BINDING__`. Until
 * 06 lands, the suite fails at setup with a clear message —
 * intentionally louder than `describe.skipIf` (CLAUDE.md forbids
 * silent skips). After 06 ships, the global is populated and the
 * suite turns green.
 *
 * Capability flags pinned for this adapter:
 *  - `caseSensitiveKeys: true` — R2 preserves key case verbatim.
 *  - `supportsCAS: true` — both `ifMatch` and `ifNoneMatch:"*"`
 *    map cleanly to `R2PutOptions.onlyIf`.
 *  - `supportsAbort: true` — every method threads the signal to
 *    its first awaited line. The R2 binding does not honor the
 *    signal mid-flight; the suite only asserts that a *pre-aborted*
 *    signal throws synchronously.
 */
defineStorageConformanceSuite(
  "r2BindingStorage (miniflare)",
  async () => {
    const bucket = (globalThis as { __BAERLY_R2_BINDING__?: R2Bucket }).__BAERLY_R2_BINDING__;
    if (bucket === undefined) {
      throw new Error(
        "r2-binding-storage conformance: globalThis.__BAERLY_R2_BINDING__ missing — wired by vitest pool in ticket 06",
      );
    }
    return { storage: r2BindingStorage(bucket) };
  },
  { caseSensitiveKeys: true, supportsCAS: true, supportsAbort: true },
);
