---
"@gusto/baerly-storage": patch
---

Swap `fast-xml-parser` for `@rgrove/parse-xml` in the S3 XML decode path
(`@baerly/adapter-node`). No public API changes — all exported functions and
types are unchanged.

**Smaller bundle:** −87 KiB raw / −24 KiB gz / −14 KiB min-gz on the `s3.js`
closure. `@rgrove/parse-xml` also has zero transitive dependencies, where
`fast-xml-parser` pulled in `strnum` and `@nodable/entities` — so the
supply-chain and audit surface both shrink.

**CVE-class defense-in-depth (not an active-hole fix):** `fast-xml-parser`
shipped ~6 CVEs across 5.x (CVE-2026-25896, CVE-2026-26278, CVE-2026-33036,
and others), all in the DOCTYPE/entity surface. Our `<!DOCTYPE` regex guard
already made those vectors unreachable — the pinned `fast-xml-parser@5.8.0`
was never itself vulnerable — but each new CVE still forced a version-pin
review. `@rgrove/parse-xml` parses and discards DTDs without resolving custom
entities, so the entity-expansion CVE *class* cannot recur even if that regex
guard ever regressed. Removing the dependency also ends its dependabot cadence.

**Intended entity-set difference (not a bug):** `@rgrove/parse-xml` decodes
only the 5 predefined XML entities (`&amp; &lt; &gt; &quot; &apos;`) plus
decimal and hex numeric character references. It does NOT decode HTML named
entities (`&nbsp;`, `&mdash;`, etc.); the old code enabled `htmlEntities: true`
solely to get numeric refs. S3/R2/MinIO wire data is XML, not HTML — no backend
emits HTML-only named entities in `ListObjectsV2` or error responses — so the
narrower set is more spec-correct.

The swap was validated during development with a one-time differential-oracle
test asserting field-for-field parity between the two parsers on generated
S3-shaped XML (predefined entities, decimal/hex numeric refs, CDATA, singular
and plural `<Contents>`). That check is not retained; going forward, parser
behavior is pinned by the example-based contract tests in
`packages/adapter-node/src/xml.test.ts`.
