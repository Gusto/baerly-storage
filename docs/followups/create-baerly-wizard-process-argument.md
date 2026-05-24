# `create-baerly` wizard: unify flag/prompt path via `processArgument`

**Severity: MEDIUM. Internal cleanup. Removes the `WizardInput`
(partial) / `WizardOutput` (total) type duality and the
conditional-spread dance in the runner.**

## The current shape

`packages/create-baerly/src/prompts.ts` exposes:

```ts
interface WizardInput {
  readonly projectName?: string;
  readonly target?: "cloudflare" | "node";
  // …each field optional…
}
interface WizardOutput {
  readonly projectName: string;
  readonly target: "cloudflare" | "node";
  // …each field required…
}
export const runWizard = async (input: WizardInput): Promise<WizardOutput>
```

And `packages/create-baerly/src/runner.ts:122-128` builds the
`WizardInput` with a conditional-spread ladder:

```ts
const w = await runWizard({
  projectName: args.projectName,
  ...(args.target !== undefined && { target: args.target }),
  ...(args.starter !== undefined && { starter: args.starter }),
  ...(withAddonsFromFlag !== undefined && { withAddons: withAddonsFromFlag }),
  ...(args.install !== undefined && { install: args.install }),
});
```

Each per-field prompt (`promptProjectName`, `promptTarget`,
`promptStarter`, `promptDocker`, `promptInstall`) repeats the same
clack `isCancel(v) → cancel("Cancelled.") → process.exit(1)`
boilerplate.

## The shape to land

Adopt the `processArgument(args, key, promptConfig)` pattern (C3's
`packages/create-cloudflare/src/helpers/args.ts:417` is the
reference implementation). One helper that:

- Returns `args[key]` if it's not `undefined`.
- Otherwise prompts via `@clack/prompts` per the prompt config, with
  uniform cancel-sentinel handling.
- Caches the result back into `args[key]` so reads downstream are
  idempotent.

After the refactor:

- `WizardInput` and `WizardOutput` collapse to one `Args` shape
  (the existing `ParsedArgs<typeof CREATE_BAERLY_ARGS>`-ish, but
  with the required fields nullable).
- The runner's conditional-spread block disappears — wizard mode
  just calls `processArgument` once per field on the same `args`
  object the flag-driven branch already uses.
- The five per-field prompt helpers collapse to single `processArgument`
  calls with inline prompt configs (or a small `PROMPTS` table
  keyed by arg name).

## Concrete signature

```ts
type PromptConfig =
  | { type: "text"; message: string; placeholder?: string; validate?: (v: string) => string | undefined }
  | { type: "select"; message: string; options: { value: string; label: string; hint?: string }[]; initialValue?: string }
  | { type: "confirm"; message: string; initialValue?: boolean };

export const processArgument = async <K extends string, V>(
  args: Record<string, unknown>,
  key: K,
  config: PromptConfig,
): Promise<V> => {
  if (args[key] !== undefined) return args[key] as V;
  const value = await /* dispatch on config.type via @clack/prompts */;
  if (isCancel(value)) { cancel("Cancelled."); process.exit(1); }
  args[key] = value;
  return value as V;
};
```

Validate the field after assignment (matches today's
`promptProjectName` regex check that mirrors `scaffold.ts`'s).

## Cross-field validation

The current `--with=docker only applies to --target=node` check in
`runner.ts:157-163` runs after the wizard returns. That stays where
it is — it's an args-level invariant, not a per-prompt one.

The wizard's existing per-target gating (`if target === "node":
prompt for docker; else skip`) keeps working as long as
`processArgument(args, "target", …)` is awaited before any
docker-prompt branch.

## Tests

`packages/create-baerly/src/prompts.test.ts` and
`runner-wizard.test.ts` are the two test files. The contract under
test stays the same — pre-filled values bypass prompts; missing
values prompt; cancel sentinel exits with code 1; project-name
regex enforced. The helpers under test change shape; rewrite the
tests against the new `processArgument`-based wizard.

## Out of scope

- `--accept-defaults` / `-y` (C3's pattern of "fill every prompt
  with the default"). Not needed; baerly's wizard is only 3-5 prompts.
- Go-back navigation. Not needed; only 3-5 prompts.
