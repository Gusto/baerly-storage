# `baerlyWorker` fall-through cast: investigate and decide

**Severity: LOW. Agent ergonomics, not correctness.**

## The signal

A Haiku 4.5 zero-shot trial extending the notes scaffold with a
custom `/api/notes/search` route produced this wrapper shape (with
`as any` triplet at the fall-through):

```ts
export default {
  async fetch(req: unknown, env: unknown, ctx: unknown): Promise<Response> {
    const request = req as Request;
    const appEnv = env as AppEnv;
    const context = ctx as ExecutionContext;
    // …custom-route branch using `request` / `appEnv`…
    return baerly.fetch!(request as any, appEnv as any, context as any);
  },
} satisfies ExportedHandler<AppEnv>;
```

The escalation chain: the agent hit `TS2345: Argument of type
'Request<unknown, CfProperties>' is not assignable to parameter
'Request<unknown, IncomingRequestCfProperties>'` on
`baerly.fetch!(req, env, ctx)`, took the wrong tool, and landed on
`as any` for all three args. That cast survived into the committed
code.

The AGENTS.md "Extending the Worker with a custom route" recipe
already shows the right shape:

```ts
export default {
  async fetch(req, env, ctx): Promise<Response> {
    // …custom-route branch with `verifier(req as unknown as Request)`…
    return baerly.fetch!(req, env, ctx);
  },
} satisfies ExportedHandler<AppEnv>;
```

The agent read the recipe but didn't follow it at the boundary.

## The open question

Does `baerly.fetch!(req, env, ctx)` actually typecheck when
`req: Request<unknown, IncomingRequestCfProperties>` (the
workers-types narrowing inside `ExportedHandler<E>`) and
`baerly: ExportedHandler<E>` come from the same `E`? Two
possibilities:

1. **It typechecks cleanly.** Then the recipe is correct as-is, the
   agent over-escalated, and the upstream gap is "the recipe needs
   one more sentence saying *no cast at the fall-through*." Fix:
   single-line addendum to the AGENTS.md recipe + a `// no cast
   needed here` comment in the code block.

2. **It needs a localised cast** (e.g. `baerly.fetch!(req as
   unknown as Request, env, ctx)` or some narrower assignment).
   Then the recipe is silently misleading — it shows the call but
   not the cast a real consumer needs. Fix: extend the recipe to
   model the cast exactly, or widen `baerlyWorker`'s return type
   so the cast is unnecessary.

The right call depends on which case is real, and I haven't run the
typecheck. The recipe ALREADY ends with `return baerly.fetch!(req,
env, ctx);` and `satisfies ExportedHandler<AppEnv>`, which compiles
green for the scaffold today (`pnpm verify:examples` is part of
`pnpm verify`). So case 1 is the load-bearing hypothesis.

## Investigation steps

1. Reproduce the agent's shape literally inside
   `examples/minimal-cloudflare/src/server/index.ts`: add a no-op
   `/api/echo` branch with `req: Request<...>` from workers-types
   and call `return baerly.fetch!(req, env, ctx)` at the fall-
   through with no cast. Does `pnpm verify` stay green?
2. If yes → case 1. Add the addendum to the AGENTS.md recipe.
3. If no → case 2. Either model the cast in the recipe, or look at
   `packages/adapter-cloudflare/src/worker.ts:209-211` (the
   `baerlyWorker` return-type signature) and consider widening it.

## Related public surface

- `baerlyWorker` in `baerly-storage/cloudflare` (returns
  `ExportedHandler<E extends BaerlyEnv>`)
- The "Extending the Worker with a custom route" recipe in
  `examples/minimal-cloudflare/AGENTS.md` and
  `examples/react-cloudflare/AGENTS.md`

## Source

Analyst triage report 2026-05-24 ("holler-back / extend-notes-with-
search"), Moment 4. Bundled fix for Moments 1/2/5/6 + this
followup shipped in the same change.
