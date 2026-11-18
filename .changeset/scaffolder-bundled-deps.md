---
"@gusto/baerly-storage": patch
---

`@gusto/create-baerly-storage` now bundles its dependencies and declares none, so `npm create @gusto/baerly-storage` runs exactly the code our lockfile resolved instead of resolving `^` ranges on your machine. It colors output with Node's `util.styleText`, which honors `NO_COLOR` and `FORCE_COLOR`. Its bundled notices ship in `dist/THIRD-PARTY-LICENSES.txt`.
