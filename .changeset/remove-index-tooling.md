---
"@gusto/baerly-storage": minor
---

**Breaking:** declared `indexes` are now validated no-ops, and the index-marker tooling is removed. Every read already takes its rows from the snapshot and log, so a declared index does not speed up a read or change its result, and nothing needs reconciling.

- `rebuildIndex` (and `RebuildIndexOptions` / `RebuildIndexResult`) is removed from `@gusto/baerly-storage/maintenance`.
- `allIndexKeysFor` is removed from `@gusto/baerly-storage`.
- `baerly admin rebuild-index` is removed.
- `baerly admin fsck` loses `--indexes`, `--fix`, and `--config`; passing one fails as an unknown flag (exit 1). Plain `fsck` is unchanged and never reads `index/`.
- `baerly inspect` loses `--config` and the per-index key counts (`indexes` in the `--json` result).
- `collections.<name>.indexes` stays in the config type. `Db.create` now validates every declaration and throws on a malformed one instead of failing at the first write: `SchemaError` for a bad name or empty `on`, `InvalidConfig` for a reserved leading-`_` name or a dotted `on` path (`"meta.owner"`, which already failed every write).

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before
import { rebuildIndex } from "@gusto/baerly-storage/maintenance";
await rebuildIndex(storage, currentJsonKey, { name: "by_status", on: "status" });
// after: delete the call. Reads do not depend on index markers.

// before
export default defineConfig({
  collections: { tickets: { indexes: [{ name: "by_status", on: "status" }] } },
});
// after: omit `indexes`. A query like `.where({ status: "open" })` returns the same rows either way.
export default defineConfig({ collections: { tickets: {} } });
```

```sh
# before
baerly admin rebuild-index --bucket=$B --collection=tickets --index=by_status --on=status
baerly admin fsck --bucket=$B --collection=tickets --indexes --fix --config=./dist/baerly.config.mjs
# after: no reconciliation step exists; run the plain consistency walk
baerly admin fsck --bucket=$B --collection=tickets
```

Existing configs that declare `indexes` keep compiling and keep working.
