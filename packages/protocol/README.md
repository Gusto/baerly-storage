# @baerly/protocol

**Internal implementation detail of [`baerly-storage`](../../). Not a public API.**

If you're writing application code, import from `baerly-storage`:

```ts
import { BaerlyError, MemoryStorage, type Storage, type Verifier } from "baerly-storage";
```

This package holds the pure protocol kernel — types, errors, JSON merge-patch,
constants, hashing, ordered maps, the `Storage` interface, and the
`MemoryStorage` impl. It has no Node-only deps and is Worker-bundleable.
HTTP S3 storage lives in `@baerly/adapter-node`; R2 binding storage lives in
`@baerly/adapter-cloudflare`. `baerly-storage` re-exports the user-facing
surface; the internal adapter packages consume this package directly.

There is no reason for application code to install or name `@baerly/protocol`.
The package exists as a workspace member so contributors can enforce the
"no I/O in the kernel" boundary; it's bundled into `baerly-storage` but
should not be imported by user code.

## Subpath: `@baerly/protocol/conformance`

The `./conformance` subpath exposes the shared `Storage` conformance test
suite that every `Storage` impl runs against. It is consumed only by
in-workspace adapter tests (`packages/adapter-node`,
`packages/adapter-cloudflare`); external adapter authors should write their
`Storage` impl against the interface re-exported from `baerly-storage` and
use vitest however they like to drive it.
