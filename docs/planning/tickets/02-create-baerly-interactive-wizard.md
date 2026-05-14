# 02 — `create-baerly` interactive wizard via `@clack/prompts`

**One-liner.** When `create-baerly` is run on a TTY without all
required args, enter a `@clack/prompts` wizard (intro → text →
select → confirm → outro); when stdin is non-TTY (CI / agent /
`| cat`), retain the existing flag-driven behavior and the JSON
envelope unchanged.

**Estimated effort.** 1.5 days. **Risk.** Low-medium — first
clack integration in the repo; care needed to keep `--json` and
non-TTY modes regression-free.

---

> **Self-contained.** You don't need to consult any planning notes
> or chat logs. Everything you need is in this file, the repo
> source, `CLAUDE.md`, and the path-scoped conventions referenced
> at the bottom.

## Why we're doing this

`create-baerly` is the first thing a user runs. Today
`packages/create-baerly/src/index.ts:18-54` declares
`projectName` (positional, required) and `target` (string,
required), and `npm create baerly@latest` with no args fails with
a `MissingRequiredArg` error from citty. World-class scaffolders
default to interactive when args are missing — Astro and
SvelteKit's `sv` use `@clack/prompts`, Next.js uses
`@inquirer/prompts`, Vite uses `prompts`. The user picked
`@clack/prompts` (cleanest visuals, modern API, used by Astro and
the SvelteKit `sv` CLI).

`@clack/prompts` is also what the new `outro` will use: today the
post-scaffold output at `src/index.ts:82-86` is plain `process.
stdout.write` lines with `pc.green("✓")`. That works but doesn't
feel framed — the canonical post-scaffold experience is a clack
`outro()` with a clearly-bordered next-steps block.

Critical invariant: anything that scripts / CI / the existing JSON
envelope path relies on **must not regress**. Tests today exercise
the flag-driven path; the new wizard path is additive.

## Current state

- Entry: `packages/create-baerly/src/index.ts` (lines 1-102). The
  citty `defineCommand` block declares `projectName` (positional,
  required) and `target` (string, required); other args are
  optional. The `run` block (line 55) validates `target`, calls
  `scaffold()`, and on success either writes the JSON envelope
  (when `args.json === true`, lines 69-80) or the plaintext
  "Next steps" block (lines 82-86).
- `scaffold()` lives in `packages/create-baerly/src/scaffold.ts`
  and returns `{ outDir, filesWritten, nextSteps }`. It is
  unchanged by this ticket.
- The package's `package.json` `dependencies` (lines 28-31)
  currently lists only `citty` and `picocolors`. The bundle is
  ESM-only and rolldown-bundled with `citty` + `picocolors`
  externalized (`rolldown.config.ts` `external:` field).
- `process.stdin.isTTY` is the canonical Node check for "user has
  a real terminal." It returns `undefined` when piped, when run
  inside non-interactive CI, and inside the agent harness — i.e.
  exactly the cases where we must **not** enter the wizard.
- There is **no** existing test that asserts wizard behavior
  (no prompts file yet), but `packages/create-baerly/src/scaffold.test.ts`
  and `packages/create-baerly/src/substitute.test.ts` show the
  test-harness shape: vitest, `import { describe, test, expect }
  from "vitest"`, `tmpdir()` fixtures.

`@clack/prompts` API used in this ticket (verified against the
public API as of v0.7+):

- `intro(title: string): void`
- `text({ message, placeholder, defaultValue?, validate? }): Promise<string | symbol>`
- `select({ message, options: Array<{ value, label, hint? }>, initialValue? }): Promise<string | symbol>`
- `confirm({ message, initialValue?: boolean }): Promise<boolean | symbol>`
- `outro(message: string): void`
- `isCancel(value): boolean`  (cancellation signal sentinel)
- `cancel(message: string): void`

`isCancel` returns `true` when the user `Ctrl+C`s mid-prompt. The
wizard must handle this: print `cancel()` and exit non-zero (we
use code 1, same as a user error).

## Implementation steps

### Step 1. Add the dependency

Edit `packages/create-baerly/package.json`. Add to
`dependencies`:

```json
"@clack/prompts": "^0.7.0",
```

(Use the latest stable as of the install; the API surface above
has been stable since v0.6.) Run `pnpm install`.

Add `@clack/prompts` to the rolldown `external:` array in
`packages/create-baerly/rolldown.config.ts` so it isn't bundled
into `dist/index.js` (npm installs it at consumer time, same as
citty + picocolors).

### Step 2. Implement the wizard helper

Create `packages/create-baerly/src/prompts.ts`:

```ts
import { intro, text, select, confirm, outro, isCancel, cancel } from "@clack/prompts";
import pc from "picocolors";

const TARGETS = [
  { value: "cloudflare", label: "Cloudflare Workers", hint: "R2 + Workers, deploy via wrangler" },
  { value: "node", label: "Self-hosted Node", hint: "S3-compatible bucket, Docker/pm2/systemd" },
] as const;

export interface WizardInput {
  /** When non-undefined, skip the projectName prompt and use this. */
  readonly projectName?: string;
  /** When non-undefined, skip the target prompt and use this. */
  readonly target?: "cloudflare" | "node";
  /** When non-undefined, skip the install confirm and use this. */
  readonly install?: boolean;
}

export interface WizardOutput {
  readonly projectName: string;
  readonly target: "cloudflare" | "node";
  readonly install: boolean;
}

export const runWizard = async (input: WizardInput): Promise<WizardOutput> => {
  intro(pc.bold(pc.cyan("create-baerly")));
  const projectName = input.projectName ?? await promptProjectName();
  const target = input.target ?? await promptTarget();
  const install = input.install ?? await promptInstall();
  return { projectName, target, install };
};

const promptProjectName = async (): Promise<string> => {
  const v = await text({
    message: "Project name",
    placeholder: "my-app",
    validate: (raw) => {
      if (raw.length === 0) return "name must be non-empty";
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(raw)) {
        return "lowercase, alphanumeric + - / _, starting with [a-z0-9]";
      }
      return undefined;
    },
  });
  if (isCancel(v)) { cancel("Cancelled."); process.exit(1); }
  return v as string;
};

const promptTarget = async (): Promise<"cloudflare" | "node"> => {
  const v = await select({
    message: "Deploy target",
    options: [...TARGETS],
    initialValue: "cloudflare",
  });
  if (isCancel(v)) { cancel("Cancelled."); process.exit(1); }
  return v as "cloudflare" | "node";
};

const promptInstall = async (): Promise<boolean> => {
  const v = await confirm({ message: "Install dependencies?", initialValue: true });
  if (isCancel(v)) { cancel("Cancelled."); process.exit(1); }
  return v as boolean;
};
```

The validation logic in `promptProjectName` mirrors the regex in
`scaffold.ts:57` exactly. Keep them in sync — see `Conventions`
below for a comment marker on both sites.

### Step 3. Wire the wizard into `index.ts`

Replace the `run` block in `packages/create-baerly/src/index.ts`
(starting at line 55) so the new flow is:

```ts
run: async ({ args }) => {
  try {
    const isInteractive = process.stdin.isTTY === true && args.json !== true;
    const wantWizard =
      isInteractive && (args.projectName === undefined || args.target === undefined);
    let projectName: string;
    let target: "cloudflare" | "node";
    let install = args.install ?? false;
    if (wantWizard) {
      const w = await runWizard({
        projectName: args.projectName,
        target: args.target === "cloudflare" || args.target === "node" ? args.target : undefined,
        install: args.install,
      });
      projectName = w.projectName;
      target = w.target;
      install = w.install;
    } else {
      // Existing flag-driven path. Errors thrown here match
      // current behavior.
      if (args.target !== "cloudflare" && args.target !== "node") {
        throw new Error(`--target must be "cloudflare" or "node", got ${JSON.stringify(args.target)}`);
      }
      projectName = args.projectName;
      target = args.target;
    }
    const result = await scaffold({
      projectName,
      target,
      ...(args.tenant !== undefined && { tenant: args.tenant }),
      ...(args.domain !== undefined && { domain: args.domain }),
      ...(args.pm !== undefined && { pm: args.pm as "npm" | "pnpm" | "yarn" }),
    });

    if (args.json === true) {
      process.stdout.write(`${JSON.stringify({
        result: { command: "create-baerly", status: "ok", outDir: result.outDir,
                  filesWritten: result.filesWritten.length, nextSteps: result.nextSteps },
      })}\n`);
    } else if (isInteractive) {
      outro(
        `${pc.green("✓")} ${result.outDir}\n` +
        `\n  Next steps:\n` +
        result.nextSteps.map((s) => `    ${s}`).join("\n"),
      );
    } else {
      // Non-TTY, non-JSON: keep the existing plaintext output
      // bit-for-bit so any scripts parsing it don't break.
      process.stdout.write(`${pc.green("✓")} scaffolded ${result.outDir}\n`);
      process.stdout.write(`\n  Next steps:\n`);
      for (const s of result.nextSteps) process.stdout.write(`    ${s}\n`);
      process.stdout.write("\n");
    }
    // (install handling unchanged — current code path)
  } catch (err) {
    // (unchanged from current handler at lines 87-97)
  }
},
```

Note the gating: `wantWizard` requires **both** TTY **and** not
`--json`. Even on a TTY, `--json` keeps the script-friendly path.
This is intentional — agents on a TTY frequently pass `--json`.

### Step 4. Tests in `packages/create-baerly/src/prompts.test.ts`

Cover:

1. `runWizard({ projectName: "my-app", target: "cloudflare",
   install: false })` returns the same values back without
   prompting (all inputs pre-filled).
2. `runWizard({ projectName: undefined, ... })` invoked with a
   mock `text()` returning `"my-app"` returns `"my-app"`. Use
   vitest's `vi.mock("@clack/prompts", ...)` to intercept.
3. `runWizard(...)` invoked with a mock returning the `isCancel`
   sentinel: the helper calls `process.exit(1)`. Assert via
   `vi.spyOn(process, "exit").mockImplementation(...)`.
4. Validation regression: project-name regex mirrors
   `scaffold.ts`'s — assert that the message returned matches what
   `scaffold.ts:57-60` throws today.

### Step 5. Integration test: non-TTY mode unchanged

Add a case to `packages/create-baerly/src/scaffold.test.ts` (or
a new `index.test.ts` if you'd rather isolate) that drives the
entry via a child-process spawn with `stdio: "pipe"` (forces
non-TTY) and asserts:

- Missing `--target` still produces the same error message as
  today.
- `--json` envelope on success is byte-identical to the pre-clack
  output.
- Plaintext output on non-TTY success matches today's lines.

If `index.test.ts` is created, gate it on `process.platform !==
"win32"` (subprocess stdio behavior diverges on Windows; this
repo's CI is Linux/macOS).

## Conventions to follow

- Tests use vitest. `import { describe, test, expect, vi } from
  "vitest"`. See `docs/conventions/tests.md`.
- Relative imports use the `.ts` extension. Cross-package imports
  use the package name (`"@clack/prompts"`).
- Project-name regex lives in two places now (`scaffold.ts:57`
  and `prompts.ts`). Add a JSDoc comment on both sites like:
  `// MUST mirror the regex in <other file>. See ticket 02.` so a
  future drift is caught at review.
- No new branded-type widenings (none should be needed).
- The `--json` envelope shape is part of the agent contract.
  Do not change a single field name or order without a follow-up
  ticket.

## Verification

```sh
# Static
pnpm verify
pnpm format:check packages/create-baerly/src

# Unit
pnpm -F create-baerly test                   # incl. prompts.test.ts

# Manual: interactive wizard
pnpm -F create-baerly build
node packages/create-baerly/dist/index.js    # → clack intro, text, select, confirm, outro

# Manual: non-TTY regression
echo "" | node packages/create-baerly/dist/index.js   # → existing error message
node packages/create-baerly/dist/index.js my-app --target=cloudflare --json   # → JSON envelope unchanged

# Manual: TTY but --json suppresses wizard
node packages/create-baerly/dist/index.js my-app --target=cloudflare --json   # plain envelope, no clack frames
```

Done when:
- All prompts tests pass.
- All existing `scaffold.test.ts` / `substitute.test.ts` tests
  still pass.
- Manual TTY smoke shows clack intro / outro frames.
- Non-TTY error path is byte-identical to pre-change.

## Out of scope

- **Multi-language i18n.** English-only prompts.
- **`--template=<name>`** option. v1 only knows `--target` (the
  user's existing arg). A future ticket can layer multiple
  templates per target.
- **Progress spinners during install.** Clack supports them but
  the install step is delegated to the user's package manager;
  spawning `pnpm install` and animating around it is fiddly and
  not worth shipping in v1.
- **Auto-detecting a "Y/n" answer from a single keystroke without
  Enter.** Clack's `confirm` already does this with arrow-keys +
  Enter; that's enough.

## Conflict notes

- **Depends on**: none. Can land in parallel with ticket 01
  (`baerly dev`) — different package.
- **Blocks**: ticket 04 (the pnpm pack flow includes manual
  verification of the wizard).
- **No file overlap** with tickets 00 (docs only), 01 (cli/),
  03 (examples/).

## Pointers

- `packages/create-baerly/src/index.ts` — current entry shape and
  arg declarations.
- `packages/create-baerly/src/scaffold.ts:57` — project-name regex
  (mirror this in `prompts.ts`).
- `packages/create-baerly/rolldown.config.ts` — externals list for
  the new dep.
- `packages/create-baerly/src/scaffold.test.ts` — test-harness
  pattern.
- `docs/conventions/tests.md` — vitest conventions.
- `CLAUDE.md` — toolchain + import-extension convention.
- `@clack/prompts` README (npm) — API reference; pin to v0.7+.
