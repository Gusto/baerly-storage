# `uint8array-base64.d.ts`: shim is load-bearing — add a parity check

**Severity: LOW. Not a deletion candidate today (per memory
`reference_uint8array_base64_shim`); just guard against silent
drift.**

`examples/minimal-cloudflare/uint8array-base64.d.ts`,
`examples/minimal-node/uint8array-base64.d.ts`, and
`examples/helpdesk-cloudflare/uint8array-base64.d.ts` are all
md5-identical (`5cb7cf33e791459d882673343efe2b82`). The shim
declares `Uint8Array.prototype.toBase64()` and
`Uint8Array.prototype.setFromBase64()` until TypeScript's bundled
lib lists them.

Per memory: the shim is load-bearing because tsc proper hasn't
accepted these methods into `--lib esnext.typedarrays` yet. Don't
delete.

But three identical files in three trees with no enforcement is a
drift hazard — the next person who edits one will silently desync
the trio.

## Fix

Add a parity check to `scripts/add-ts-extensions.mjs` (or a new
audit script) that:

1. Lists every `examples/*/uint8array-base64.d.ts`.
2. Computes their checksums.
3. Fails with an actionable error if any pair differs.

```js
// scripts/check-shim-parity.mjs (sketch)
import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { createHash } from "node:crypto";

const files = [
  "examples/minimal-cloudflare/uint8array-base64.d.ts",
  "examples/minimal-node/uint8array-base64.d.ts",
  "examples/helpdesk-cloudflare/uint8array-base64.d.ts",
];
const hashes = await Promise.all(files.map(async (f) =>
  createHash("md5").update(await readFile(f)).digest("hex")
));
const unique = new Set(hashes);
if (unique.size > 1) {
  console.error("uint8array-base64.d.ts shims drifted:");
  files.forEach((f, i) => console.error(`  ${hashes[i]}  ${f}`));
  process.exit(1);
}
```

Wire into `pnpm verify` alongside the existing
`add-ts-extensions.mjs --check` (see
`orphan-fixtures-and-verify-script.md`).

## Delete-the-shim trigger

When `lib: ["ESNext.TypedArrays", ...]` ships base-64 methods
natively in a stable TypeScript release, delete all three shims
+ remove the parity check + remove the lib entry from each
`tsconfig.{worker,server,app}.json`. Coordinate with the
ES2025/ES2023 bump in `examples-tsconfig-strictness.md`.

Until then, the parity check is the cheapest insurance against
the trio diverging.
