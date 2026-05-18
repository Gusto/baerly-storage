# @baerly/protocol

**Internal implementation detail of [`@baerly/server`](../server). Not a public API.**

If you're writing application code, import from `@baerly/server`:

```ts
import { BaerlyError, MemoryStorage, type Storage, type Verifier } from "@baerly/server";
```

This package holds the pure protocol kernel — types, errors, JSON merge-patch,
constants, hashing, ordered maps, the `Storage` interface, and the
`MemoryStorage` / `S3HttpStorage` impls. It has no I/O, no Node-only deps, and
is Worker-bundleable. `@baerly/server` re-exports its user-facing surface; the
adapter packages (`@baerly/adapter-node`, `@baerly/adapter-cloudflare`) consume
it directly.

There is no reason for application code to install or name `@baerly/protocol`.
The package exists as a workspace member so contributors can enforce the
"no I/O in the kernel" boundary; it's transitively installed under
`@baerly/server` but should not be imported by user code.

## Subpath: `@baerly/protocol/conformance`

The `./conformance` subpath exposes the shared `Storage` conformance test
suite that every `Storage` impl runs against. It is consumed only by
in-workspace adapter tests (`packages/adapter-node`,
`packages/adapter-cloudflare`); external adapter authors should write their
`Storage` impl against the interface re-exported from `@baerly/server` and
use vitest however they like to drive it.
