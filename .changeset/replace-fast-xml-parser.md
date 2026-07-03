---
'@gusto/baerly-storage': patch
---

Replace `fast-xml-parser` with `@rgrove/parse-xml` in the S3 XML decode path
(`@baerly/adapter-node`).

**Bundle size:** −87 KiB raw / −24 KiB gz / −14 KiB min-gz on the `s3.js`
closure — significant for a library bundled into user apps.

**Zero-dependency:** `@rgrove/parse-xml` has no transitive dependencies, vs
`fast-xml-parser`'s closure (`strnum`, `@nodable/entities`). Smaller
supply-chain and audit surface.

**Off the CVE-bump treadmill:** `fast-xml-parser` shipped ~6 CVEs across 5.x
(CVE-2026-25896, CVE-2026-26278, CVE-2026-33036, and others), all in the
DOCTYPE/entity surface. Our own `<!DOCTYPE` regex guard already made those
vectors unreachable — the pinned `fast-xml-parser@5.8.0` was not itself
vulnerable — but each new CVE still required a version-pin review.
`@rgrove/parse-xml` parses and discards DTDs without resolving custom entities,
so the entity-expansion CVE *class* cannot recur even if our regex guard ever
regressed. This is defense-in-depth and audit-surface reduction, not the
closing of an active hole.

**Spec-correct entity set:** `@rgrove/parse-xml` decodes only the 5 predefined
XML entities plus decimal/hex numeric character references — exactly what XML
wire data uses (see "Intended entity-set difference" below).

`fast-xml-parser` is removed entirely — it no longer appears in `dependencies`
or `devDependencies`. During development the swap was validated with a
differential-oracle test that asserted field-for-field parity between the two
parsers on generated S3-shaped XML (predefined entities, decimal/hex numeric
refs, CDATA, singular + plural `<Contents>`); that one-time migration check is
not retained, so the repo no longer carries `fast-xml-parser` or its
CVE-bump/dependabot cadence. The parser's behavior is pinned going forward by
the example-based contract tests in `packages/adapter-node/src/xml.test.ts`.

**Intended entity-set difference (not a bug):** `@rgrove/parse-xml` decodes
the 5 predefined XML entities (`&amp; &lt; &gt; &quot; &apos;`) plus decimal
and hex numeric character references. It does NOT decode HTML named entities
(`&nbsp;`, `&mdash;`, etc.) — the old code enabled `htmlEntities: true`
solely to get numeric refs. S3/R2/MinIO wire data is XML, not HTML, so the
narrower entity set is more spec-correct. No S3 backend emits HTML-only named
entities in `ListObjectsV2` or error responses.

No public API changes; all exported functions and types are unchanged.
