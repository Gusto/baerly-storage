/**
 * `create-baerly` bin entry. Imports the citty command from `./runner.ts`
 * and dispatches via citty's `runMain`. Kept as a thin shim so the
 * runner module has no import-time side effects — tests can import
 * `runCreateBaerly` from `./runner.ts` directly without citty running
 * and calling `process.exit` inside vitest. Mirrors the bin/runner
 * split in `packages/cli/src/baerly.ts` + the per-subcommand modules.
 */
import { runMain } from "citty";
import { main } from "./runner.ts";

void runMain(main);
