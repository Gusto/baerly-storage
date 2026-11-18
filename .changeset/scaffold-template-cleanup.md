---
"@gusto/baerly-storage": patch
---

The Node scaffolds list no dependency in `allowBuilds`, since nothing in their tree needs an install script, so pnpm now fails the install when a dependency gains one instead of running it; review it, then add it to `allowBuilds` in `pnpm-workspace.yaml`. They also start with `node src/server/index.ts` (Node 26 strips types without `--experimental-strip-types`) and drop the unused `aws4fetch` dependency. Every scaffold drops its `Uint8Array` base64 type shim, which Node 26's types now provide.
