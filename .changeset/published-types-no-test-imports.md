---
"@gusto/baerly-storage": patch
---

Published types no longer reference a test-only package. Every entry's `.d.ts` reached a shared chunk carrying `import "@fast-check/vitest";`, so a consumer type-checking with `skipLibCheck: false` on TypeScript 7 got `TS2882: Cannot find module or type declarations for side-effect import of '@fast-check/vitest'`. The `Verifier` JSDoc example now imports from `@gusto/baerly-storage` instead of the nonexistent `baerly-storage`.
