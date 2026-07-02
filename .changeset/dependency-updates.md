---
'@gusto/baerly-storage': patch
---

Refresh dependencies ahead of release. Runtime deps that ship to consumers:
`@logtape/logtape` 2.1.3 → 2.2.2, `hono` 4.12.25 → 4.12.27, `@hono/node-server`
2.0.4 → 2.0.6, and `jose` floated to 6.2.3. The `@gusto/create-baerly-storage`
scaffolder picks up `@clack/prompts` 1.6.0. No public API changes.

`fast-xml-parser` is deliberately held at 5.8.0 (exact pin in
`@baerly/adapter-node`): 5.9.3 inflated the `./s3` closure's min-gz — the hard
shipped-to-browser budget — by ~25%, which we can't shrink because it's a
third-party closure. 5.8.0 remains the largest version that fits the ceiling.
Its transitive deps (`strnum`, `@nodable/entities`) did float forward and cost a
small amount of bundle size, rebaselined with a dated note in the bundle-size
budgets alongside the `@logtape` growth.
