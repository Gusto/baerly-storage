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
import { defineCommand, runMain } from "citty";
import { compactCmd } from "./admin/compact.ts";
import { dumpCmd } from "./admin/dump.ts";
import { fsckCmd } from "./admin/fsck.ts";
import { migrateCmd } from "./admin/migrate.ts";
import { rebuildIndexCmd } from "./admin/rebuild-index.ts";
import { restoreCmd } from "./admin/restore.ts";
import { copy } from "./copy.ts";
import { deploy } from "./deploy.ts";
import { dev } from "./dev.ts";
import { doctor } from "./doctor.ts";
import { exportCmd } from "./export.ts";
import { init } from "./init.ts";
import { inspect } from "./inspect.ts";
import { setJsonMode } from "./output.ts";

// citty has no global-flag concept, so sniff --json off process.argv
// before runMain. This way a citty parse-time error (missing required
// flag, unknown subcommand) still emits the JSON envelope on stderr
// if the user / agent asked for one.
setJsonMode(process.argv.includes("--json"));

/**
 * `baerly admin <command>` — operator-side reconciliation, inspection,
 * data-shovel, and maintenance tools. Today: `rebuild-index`, `dump`,
 * `restore`, `compact`, `fsck`, `migrate`.
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
    fsck: fsckCmd,
    migrate: migrateCmd,
  },
});

const main = defineCommand({
  meta: {
    name: "baerly",
    version: "0.0.0",
    description:
      "Vendorless document database CLI\n\nSee docs/about/pricing-log.md for the running cost-ceiling history.",
  },
  subCommands: {
    copy,
    deploy,
    dev,
    doctor,
    init,
    inspect,
    export: exportCmd,
    admin,
  },
});

void runMain(main);
