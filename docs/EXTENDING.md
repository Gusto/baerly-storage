# Extending MPS3

Three worked examples for the most common extension shapes. Follow these
patterns and your changes will fit the codebase's conventions.

> Before adding a feature, read [ARCHITECTURE.md](ARCHITECTURE.md) so you
> know which module owns what. Most additions touch `mps3.ts` or
> `manifest.ts`, but the *invariants* live in `syncer.ts`.

---

## 1. Add a new public method on `MPS3`

We'll work through `keys()` — list every key in the default manifest.

### Where to add the method

Public methods live on the `MPS3` class in `src/mps3.ts`. Internal methods
are prefixed with `_` and tagged `/** @internal */` to mark them as not
part of the public API.

```ts
// src/mps3.ts (inside class MPS3)

/**
 * List all keys present in the manifest.
 *
 * Reflects local optimistic writes that haven't been confirmed by the
 * server yet — what you'd see if you called `get()` on each key right now.
 *
 * @param options.manifest - manifest to read; defaults to the configured one
 * @returns array of key strings (no bucket prefix), in unspecified order
 *
 * @example
 * ```ts
 * await mps3.put("user/42", { name: "Ada" });
 * const keys = await mps3.keys();
 * // → ["user/42"]
 * ```
 */
public async keys(
  options: { manifest?: Ref } = {}
): Promise<string[]> {
  const manifestRef: ResolvedRef = {
    ...this.config.defaultManifest,
    ...options.manifest,
  };
  const manifest = this.getOrCreateManifest(manifestRef);
  const state = await manifest.syncer.getLatest();
  const inflight = await manifest.operationQueue.flatten();

  const result = new Set<string>();
  for (const fileUrl of Object.keys(state.files)) {
    if (state.files[fileUrl] !== null) {
      // fileUrl is "<bucket>/<key>" — strip the bucket
      result.add(fileUrl.split("/").slice(1).join("/"));
    }
  }
  // flatten() returns OMap<Ref, [value, sequence]> — value === undefined means delete
  inflight.forEach(([value], ref) => {
    if (value !== undefined) result.add(ref.key);
    else result.delete(ref.key);
  });
  return [...result];
}
```

### Conventions to follow

- **JSDoc with `@example`.** IDE hover and `tsgo` surface these
  directly from source — they are the public-API reference.
- **`Ref` resolution.** Always merge the user's `options.manifest` over
  `this.config.defaultManifest` to fill in defaults. See `mps3.get` for
  the canonical pattern.
- **Optimistic state.** When reading, layer `operationQueue.flatten()`
  over the synced state — that's how `get` and `subscribe` already work.
- **No new throw without `MPS3Error`.** If the method can fail, throw
  `new MPS3Error("Code", "context")` from `src/errors.ts`.
- **Internal helpers go on `MPS3` with `_` prefix and `/** @internal */`,**
  not in a separate file.

### Add a test

Conformance tests live in `tests/integration/conformance.test.ts`. They need
cloud credentials. For a behavior that doesn't require a network round
trip, prefer a focused test in a topic-specific file (e.g.
`tests/unit/keys.test.ts`).

```ts
// tests/unit/keys.test.ts
import "fake-indexeddb/auto";
import { test, expect, describe } from "vitest";
import { MPS3 } from "../../src/mps3";

describe("keys()", () => {
  test("reflects local writes", async () => {
    const mps3 = new MPS3({
      defaultBucket: "test",
      online: false,                          // skip the network
      s3Config: { region: "us-east-1" },
    });
    await mps3.put("a", 1);
    await mps3.put("b", 2);
    const keys = await mps3.keys();
    expect(keys.sort()).toEqual(["a", "b"]);
  });
});
```

For protocol-shape changes (anything in `syncer.ts` or `manifest.ts`),
also add a property-based variant in `tests/integration/randomized.test.ts`
so the behavior is exercised under random write interleavings.

### Verify

```sh
pnpm verify        # typecheck + test + format:check + lint
```

---

## 2. Add a new internal module

Use this pattern when a piece of logic outgrows its current home.

### File template

```ts
// src/myModule.ts
import type { Ref } from "./types";
import { MANIFEST_POLL_INTERVAL_MILLIS } from "./constants";

/**
 * One-line summary of what this module does.
 *
 * Longer explanation including any invariants the rest of the codebase
 * relies on. Cite docs/sync_protocol.md if you're touching the protocol.
 */
export class MyThing {
  // ...
}
```

### Wire it in

- Import from the module that owns the responsibility (usually `mps3.ts`
  or `manifest.ts`).
- Add it to the dependency graph in [ARCHITECTURE.md](ARCHITECTURE.md). A
  module that isn't in the graph is invisible to future agents.
- If it adds protocol-visible state (e.g. a new manifest field or S3 key
  shape), document it in `docs/sync_protocol.md` and consider whether it
  needs a coverage entry in `causal_consistency_checking.md`.

### Don't

- ❌ Create files outside `src/` or `tests/`. Source modules live in
  `src/`; unit tests colocate as `src/<module>.test.ts`; cross-cutting
  and integration tests live under `tests/`.
- ❌ Use baseUrl-style imports — there's no `baseUrl` configured. Use
  relative paths.
- ❌ Add a config knob unless it's user-facing. Internal toggles bloat
  `MPS3Config`; prefer a constant in `src/constants.ts`.

---

## 3. Add a new test

### File naming and location

Filenames are kebab-case. The `.test.ts` suffix is what `vitest.config.ts`
picks up (`include: ["src/**/*.test.ts", "tests/**/*.test.ts"]`).

- **Unit test of a single module** → colocate as `src/<module>.test.ts`.
  Example: tests for `src/json.ts` go in `src/json.test.ts`.
- **Cross-cutting unit test** with no 1:1 source → `tests/unit/<topic>.test.ts`.
- **Integration test** that needs Minio, credentials, or a built bundle
  → `tests/integration/<topic>.test.ts`.
- **Shared helpers** (no test calls) → `tests/fixtures/<name>.ts`. See
  `tests/fixtures/consistency.ts` for an example.

### Test template

```ts
// tests/unit/my-feature.test.ts
import { test, expect, describe } from "vitest";
import "fake-indexeddb/auto";          // only if the test exercises IndexedDB
import { MPS3 } from "../../src/mps3";

describe("my feature", () => {
  test("does the thing", async () => {
    const mps3 = new MPS3({
      defaultBucket: "test",
      s3Config: { region: "us-east-1" },
    });
    // ...
    expect(thing).toBe(expectedThing);
  });
});
```

### When to write a property-based test

Reach for `randomized.test.ts`-style coverage when the behavior depends on
*ordering* — interleaved writes, replay sequence, partial failures.
Property-based tests catch races that example tests can't.

A property test in this codebase typically:

1. Generates a random sequence of `put`/`delete` operations.
2. Runs them through MPS3 (often with multiple clients on the same
   manifest).
3. Asserts a property like "every observer eventually sees a sequence
   consistent with some serialization of the writes" or "no client
   observes a state that contradicts a happened-before relation".

Look at `tests/integration/randomized.test.ts` and
`tests/unit/consistency.test.ts` for the patterns in use.

### When to assert on errors

Check the `code`, not the message:

```ts
expect.assertions(1);
try {
  await mps3.put(/* something invalid */);
} catch (err) {
  expect((err as MPS3Error).code).toBe("InvalidConfig");
}
```

Don't string-match on `error.message` — those are not stable.

### Performance budget

The full `pnpm test` should stay under ~30s on a developer laptop. If your
test sleeps or polls, prefer `await Promise.resolve()` ticks or short
intervals (≤50ms) to keep the suite snappy.
