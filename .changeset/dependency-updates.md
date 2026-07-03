---
'@gusto/baerly-storage': patch
---

Refresh dependencies ahead of release. Runtime deps that ship to consumers:
`@logtape/logtape` 2.1.3 → 2.2.2, `hono` 4.12.25 → 4.12.27, `@hono/node-server`
2.0.4 → 2.0.6, and `jose` floated to 6.2.3. The `@gusto/create-baerly-storage`
scaffolder picks up `@clack/prompts` 1.6.0. No public API changes.

The `@logtape/logtape` growth was rebaselined with a dated note in the
bundle-size budgets. (The XML parser was separately swapped from
`fast-xml-parser` to `@rgrove/parse-xml` — see the parser-swap changeset — which
removes `fast-xml-parser` and its transitive closure from the tree entirely.)
