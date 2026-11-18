---
"@gusto/baerly-storage": patch
---

A deployed Cloudflare Worker no longer bundles the Node-only `LocalFsStorage` code (and its `node:fs`, `node:os`, `node:path` and `node:crypto` imports), which it pulled in only for the dev landing page and could never run under workerd. `dist/cloudflare.js` is about 12.7 KB raw and 1.8 KB min-gzipped smaller, and it now imports no Node builtin except `node:async_hooks`.
