/**
 * `baerly` — vendorless document database CLI. Entry point bundled
 * to `dist/baerly.js` by `rolldown.config.ts` with a `#!/usr/bin/env
 * node` banner.
 *
 * Subcommands live in their own modules and register via citty's
 * `defineCommand`. Adding a new subcommand: write its module, export
 * a `defineCommand` block, drop it into `subCommands` below. citty
 * auto-generates `--help` / `--version` / dispatch from there — no
 * hand-rolled `case` arm, no `HELP` constant.
 *
 * Exit codes are documented in `packages/cli/README.md` and per-
 * subcommand in each module's docstring.
 */
import { defineCommand } from "citty";
import { compactCmd } from "./admin/compact.ts";
import { copy } from "./admin/copy.ts";
import { dumpCmd } from "./admin/dump.ts";
import { fsckCmd } from "./admin/fsck.ts";
import { gcCmd } from "./admin/gc.ts";
import { migrateCmd } from "./admin/migrate.ts";
import { rebuildIndexCmd } from "./admin/rebuild-index.ts";
import { restoreCmd } from "./admin/restore.ts";
import { usageCmd } from "./admin/usage.ts";
import { cost } from "./cost.ts";
import { deploy } from "./deploy.ts";
import { dev } from "./dev.ts";
import { doctor } from "./doctor.ts";
import { exportCmd } from "./export.ts";
import { init } from "./init.ts";
import { inspect } from "./inspect.ts";
import { runBin } from "./bin-runner.ts";

/**
 * `baerly admin <command>` — operator-side reconciliation, inspection,
 * data-shovel, and maintenance tools. Today: `rebuild-index`, `dump`,
 * `restore`, `compact`, `gc`, `fsck`, `migrate`, `copy`, `usage`.
 */
const admin = defineCommand({
  meta: {
    name: "admin",
    description: "Operator commands — reconciliation and inspection.",
  },
  subCommands: {
    "rebuild-index": rebuildIndexCmd,
    dump: dumpCmd,
    restore: restoreCmd,
    compact: compactCmd,
    gc: gcCmd,
    fsck: fsckCmd,
    migrate: migrateCmd,
    copy,
    usage: usageCmd,
  },
});

const main = defineCommand({
  meta: {
    name: "baerly",
    version: "0.0.0",
    description: "Vendorless document database CLI.",
  },
  // Order matters: citty renders --help in declaration order.
  // Day-1 verbs (init → dev → deploy) come first, then operator
  // reads (doctor → inspect → export → cost), then `admin`.
  subCommands: {
    dev,
    init,
    deploy,
    doctor,
    inspect,
    export: exportCmd,
    cost,
    admin,
  },
});

void runBin(main, process.argv.slice(2), "baerly");
