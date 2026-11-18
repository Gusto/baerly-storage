---
"@gusto/baerly-storage": patch
---

`@gusto/create-baerly-storage` and the apps it scaffolds declare `engines.node: ">=26"`, the Node version the project tests on. Running either on older Node now gets an engine warning from your package manager (or a refusal with `engine-strict`).
