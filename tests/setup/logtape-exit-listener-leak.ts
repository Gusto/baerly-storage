// Suppress the `MaxListenersExceededWarning: … 11 exit listeners added to
// [process]` that floods the (forked) test workers.
//
// Root cause is an upstream LogTape bug, not baerly code:
// `@logtape/logtape@2.2.2`'s `configure()` calls
// `process.on("exit", dispose)` on **every** invocation
// (`dist/config.js` → `registerDisposeHook`) and never removes that hook
// on `reset()`. `configureObservability`
// (`packages/server/src/observability/logger.ts`) is documented as
// idempotent — production adapters configure once at boot, but the test
// suite reconfigures it in many `beforeEach` blocks across dozens of
// files that share one forked worker process. Each `configure()` appends
// another copy of the *same* `dispose` reference, and Node warns once the
// count passes its default `MaxListeners` of 10.
//
// This is a pure test artifact: shipped code configures once, so the
// kernel bundle carries no workaround. We fix it where the multiplicity
// happens — the test process — by making `process.on/addListener("exit",
// fn)` idempotent for an already-registered reference. That removes the
// leak (the count never grows past one per distinct listener) rather than
// masking it with `setMaxListeners`, and it only affects the `"exit"`
// event with duplicate references, so genuinely-distinct listeners are
// untouched.
//
// Guarded by `typeof process` so it's a no-op under Workerd, matching
// LogTape's own env guard (Workerd has no `process` and never hits the
// leaking branch anyway).

if (typeof process !== "undefined" && typeof process.on === "function") {
  const target = process as unknown as {
    on: (event: string, listener: (...args: unknown[]) => void) => unknown;
    addListener: (event: string, listener: (...args: unknown[]) => void) => unknown;
    listeners: (event: string) => readonly ((...args: unknown[]) => void)[];
  };

  const dedupe = (original: (event: string, listener: (...args: unknown[]) => void) => unknown) =>
    function (this: unknown, event: string, listener: (...args: unknown[]) => void): unknown {
      if (event === "exit" && target.listeners("exit").includes(listener)) {
        // Identical reference already registered — skip the duplicate so
        // the listener count stays flat across repeated configure() calls.
        return this;
      }
      return original.call(this, event, listener);
    };

  target.on = dedupe(target.on.bind(process));
  target.addListener = dedupe(target.addListener.bind(process));
}
