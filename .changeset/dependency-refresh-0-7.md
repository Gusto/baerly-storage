---
"@gusto/baerly-storage": patch
---

Update the bundled runtime dependencies: `hono` to 4.13.19, `@hono/node-server` to 2.1.8, `jose` to 6.2.17, `@rgrove/parse-xml` to 5.2.0, `@logtape/logtape` to 2.4.2, and the scaffolder's `@clack/prompts` to 1.9.0. No public API changes.

The `s3.js` and `gcs.js` closures grew about 3.7 KB raw (about 380 B min-gz) from `@rgrove/parse-xml`; `http.js`, `cloudflare.js` and `observability.js` grew about 34 KB raw (about 3 KB min-gz) each from `@logtape/logtape`. Bundle-size budgets were rebaselined to match.
