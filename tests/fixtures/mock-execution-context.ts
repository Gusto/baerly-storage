/**
 * Minimal `ExecutionContext` test double.
 *
 * `@cloudflare/workers-types` keeps growing `ExecutionContext` with new
 * required members (`exports`, `restore`, `abort`, `tracing`, …) that
 * these tests never touch. Casting a partial through `unknown` pins the
 * mock to the only surface under test — `waitUntil` — so a workers-types
 * bump can't break every worker test at once. Node-import-free, so it
 * loads inside the Workerd (`cloudflare-pool`) project too.
 *
 * Pass a `waitUntil` to collect / observe the post-response continuation;
 * the default drops it (fire-and-forget), which is what most tests want.
 */
export const mockExecutionContext = (
  waitUntil: (promise: Promise<unknown>) => void = () => {},
): ExecutionContext =>
  ({
    waitUntil,
    passThroughOnException(): void {},
    props: {},
  }) as unknown as ExecutionContext;
