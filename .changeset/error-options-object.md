---
"@gusto/baerly-storage": minor
---

`new BaerlyError(code, message, options?)` and `errorEnvelope(code, message, options?)` (from `@gusto/baerly-storage/http`) take their optional values in one options object instead of positional slots, like `new Error(message, { cause })`. `code` and `message` stay positional. The option types are exported as `BaerlyErrorOptions` (`cause`, `issues`, `status`, `resolution`, `_id`) and, from `@gusto/baerly-storage/http`, `ErrorEnvelopeOptions` (`issues`, `resolution`, `_id`).

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before
new BaerlyError("NetworkError", "PUT failed", err);
new BaerlyError("SchemaError", "bad doc", undefined, issues);
new BaerlyError("InvalidConfig", "bad", undefined, undefined, undefined, "do X");
errorEnvelope("InvalidConfig", "bad", undefined, "do X");

// after
new BaerlyError("NetworkError", "PUT failed", { cause: err });
new BaerlyError("SchemaError", "bad doc", { issues });
new BaerlyError("InvalidConfig", "bad", { resolution: "do X" });
errorEnvelope("InvalidConfig", "bad", { resolution: "do X" });
```

An old positional call with more than three arguments, or with any non-options third argument (a string, or an `Error` as in `new BaerlyError(code, msg, err)`), no longer compiles in TypeScript; pass `{ cause: err }`.

A plain object you passed as the cause is now read as the options. Wrap it: `{ cause: { notApplied: true } }`, not `{ notApplied: true }`. TypeScript flags this only for an object literal that has a key the options don't have; a typed variable, or an object that shares a key such as `status`, compiles and lands on that option instead of `cause`.

Untyped JavaScript gets no error for any old form. `new BaerlyError(code, msg, err)` reads the options from the error's own `.cause`, so the error itself is dropped, as with `new Error(msg, someError)`. Update those call sites by hand.
