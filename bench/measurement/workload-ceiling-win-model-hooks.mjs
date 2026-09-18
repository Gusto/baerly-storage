/* eslint-disable no-underscore-dangle -- `__enc` is the encode-hook counter bag, seeded in this realm. */
// Registers the win-model encode-counter load hook AND `resolve-ts.mjs`.
// The encode hook is a `load` hook; protocol internals are extensionless
// relative imports, so the resolver has to chain or `@baerly/protocol`
// fails with ERR_MODULE_NOT_FOUND. Same pairing `bench/register-hooks.mjs`
// uses for every other bench entrypoint.
//
// Seed the counter bag HERE, in the application realm. The load-hook module
// runs in a separate context, so initializing `__enc` there would not be
// visible to the wrapped encode functions or to the win-model script.
import { register } from "node:module";

if (globalThis.__enc === undefined) {
  globalThis.__enc = {
    jsonCalls: 0,
    jsonBytes: 0,
    chunkCalls: 0,
    chunkBytes: 0,
    chunkDocs: 0,
    bodyCalls: 0,
    bodyBytes: 0,
    hashCalls: 0,
    hashBytes: 0,
  };
}

register("../resolve-ts.mjs", import.meta.url);
register("./workload-ceiling-win-model-hook.mjs", import.meta.url);
