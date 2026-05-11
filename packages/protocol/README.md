# @baerly/protocol

Pure protocol primitives — types, errors, JSON merge-patch, constants,
hashing, ordered maps.

This package is pure by construction: no `fetch`, no IndexedDB, no DOM
parsers, no S3 wire formats. Everything that _touches the world_ lives in
sibling packages (`@baerly/server`, `@baerly/client`, …) and depends on
this one.

Currently consumed by the umbrella `baerly-storage` package and by future
`@baerly/*` packages. Internal-only for now (`private: true`).

See the repo root [README](../../README.md) for project context.
