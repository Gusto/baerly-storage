---
"@gusto/baerly-storage": patch
---

`baerly inspect --json` is documented as a storage-format diagnostic, not a stable contract. Its fields (`tail_hint`, `snapshot_bytes`, `fold_gate`, `writer_fence`, …) follow the storage format, and any release can rename, reshape, or drop them. Don't build automation on them. `baerly inspect --help` says the same.
