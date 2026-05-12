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
import { rebuildIndexCmd } from "./admin/rebuild-index";
import { copy } from "./copy";
import { deploy } from "./deploy";
import { doctor } from "./doctor";
import { setJsonMode } from "./output";

// citty has no global-flag concept, so sniff --json off process.argv
// before runMain. This way a citty parse-time error (missing required
// flag, unknown subcommand) still emits the JSON envelope on stderr
// if the user / agent asked for one.
setJsonMode(process.argv.includes("--json"));

/**
 * `baerly admin <command>` — operator-side reconciliation +
 * inspection tools. Today: `rebuild-index`. Future: `inspect`,
 * `fsck`, `compact`.
 */
const admin = defineCommand({
  meta: {
    name: "admin",
    description: "Operator commands — reconciliation and inspection.",
  },
  subCommands: {
    "rebuild-index": rebuildIndexCmd,
  },
});

const main = defineCommand({
  meta: {
    name: "baerly",
    version: "0.0.0",
    description: "Vendorless document database CLI",
  },
  subCommands: {
    copy,
    deploy,
    doctor,
    admin,
    // Future subcommands (each a ~10-line defineCommand block):
    //   init, inspect, compact, fsck, export, migrate, dump, restore
    // See packages/cli/package.json description and the docs in
    // docs/operating/ for the planned surface.
  },
});

void runMain(main);
