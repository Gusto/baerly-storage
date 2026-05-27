/**
 * `baerly` — vendorless document database CLI. Entry point bundled
 * to `dist/baerly.js` by `rolldown.config.ts` with a `#!/usr/bin/env
 * node` banner.
 *
 * Subcommands live in their own modules and register via citty's
 * `defineCommand`. Adding a new subcommand: write its module, export
 * a `defineCommand` block, drop it into `subCommands` below as a
 * lazy `() => import("./x.ts").then(m => m.x)` factory. citty 0.2.2
 * supports `Resolvable<CommandDef>` in `subCommands`, so the factory
 * shape is type-correct and only the dispatched module's transitive
 * imports are evaluated at startup.
 *
 * Exit codes are documented in `packages/cli/README.md` and per-
 * subcommand in each module's docstring.
 */
import { defineCommand } from "citty";
import { runBin } from "./bin-runner.ts";

/**
 * `baerly admin <command>` — operator-side reconciliation, inspection,
 * data-shovel, and maintenance tools. Today: `rebuild-index`, `dump`,
 * `restore`, `fsck`, `usage`.
 */
const admin = defineCommand({
  meta: {
    name: "admin",
    description: "Operator commands — reconciliation and inspection.",
  },
  subCommands: {
    "rebuild-index": () => import("./admin/rebuild-index.ts").then((m) => m.rebuildIndexCmd),
    dump: () => import("./admin/dump.ts").then((m) => m.dumpCmd),
    restore: () => import("./admin/restore.ts").then((m) => m.restoreCmd),
    fsck: () => import("./admin/fsck.ts").then((m) => m.fsckCmd),
    usage: () => import("./admin/usage.ts").then((m) => m.usageCmd),
  },
});

const main = defineCommand({
  meta: {
    name: "baerly",
    version: "0.0.0",
    description: "Vendorless document database CLI.",
  },
  // Order matters: citty renders --help in declaration order.
  // Day-1 verbs (deploy) come first, then operator reads
  // (doctor → inspect → export → cost), then `admin`. Scaffolding +
  // bolt-on into an existing wrangler project both live in the
  // `create-baerly` package — invoke via `pnpm create baerly` /
  // `pnpm create baerly .`, not a `baerly` subcommand.
  subCommands: {
    deploy: () => import("./deploy.ts").then((m) => m.deploy),
    doctor: () => import("./doctor.ts").then((m) => m.doctor),
    inspect: () => import("./inspect.ts").then((m) => m.inspect),
    export: () => import("./export.ts").then((m) => m.exportCmd),
    cost: () => import("./cost.ts").then((m) => m.cost),
    admin,
  },
});

void runBin(main, process.argv.slice(2), "baerly");
