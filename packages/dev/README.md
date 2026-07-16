# @baerly/dev

Node-only dev harness for `@baerly/protocol`. Anything that touches
`node:fs` / `node:path` / `node:crypto` lives here so the protocol
package stays pure (no I/O) and Worker-bundleable.

Currently:

- **`LocalFsStorage`** (`src/local-fs.ts`) — `Storage` impl backed by
  a directory tree. Content-addressed `"<sha-256-hex>"` ETags, atomic
  `write-temp + rename` writes, idempotent deletes. Useful for
  `baerlyDev()` against a fixture directory and for tests that need
  cross-`Baerly`-instance visibility without standing up Minio. Single-
  process design center; multi-process scenarios should use Minio.

Dependency direction is one-way: `@baerly/dev` → `@baerly/protocol`.
Never import the other way around.

Internal-only for now (`private: true`).
