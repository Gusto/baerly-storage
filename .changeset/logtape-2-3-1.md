---
"@gusto/baerly-storage": patch
---

Update the bundled `@logtape/logtape` to 2.3.1. No public API changes.

The logtape closure grew across every shipped entry (`index.js`, `http.js`,
`cloudflare.js`, `s3.js`, `gcs.js`, `client.js`, `client-react.js`, `auth.js`).
Bundle-size budgets were rebaselined to match; gz/min-gz move with raw and no
entry crosses a ceiling.
