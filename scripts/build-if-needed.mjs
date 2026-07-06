// scripts/build-if-needed.mjs
// Build dist/ unless BAERLY_SKIP_BUILD is set (meaning: a caller already
// produced a current dist/ and a rebuild would be redundant). Used by the
// `pretest` lifecycle hook and `verify:package` (and a future `prepack`
// hook, once added) so CI — where `pnpm install`'s `prepare` hook already
// built dist/ — doesn't re-bundle, while a local `pnpm test` after editing
// source still rebuilds.
import { spawnSync } from "node:child_process";

if (process.env.BAERLY_SKIP_BUILD) {
  process.exit(0);
}
const result = spawnSync("pnpm", ["run", "build"], { stdio: "inherit" });
process.exit(result.status ?? 1);
