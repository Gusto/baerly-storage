// Registers `resolve-ts.mjs` as a Node ESM module hook so the bench
// can `import { … } from "@baerly/protocol"` and transitively resolve
// the protocol package's extensionless internal imports (e.g.
// `./constants` → `./constants.ts`). See `resolve-ts.mjs` for why.
import { register } from "node:module";

register("./resolve-ts.mjs", import.meta.url);
