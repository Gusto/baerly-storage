---
"@gusto/baerly-storage": minor
---

`createBaerlyClient` gains an optional `onWarning` callback that surfaces the `Baerly-Capacity-Warning` response header, so an app using the HTTP client learns its collection is near the host's capacity before writes start failing with `CapacityExceeded`. No per-verb return type changes: each warned write still resolves its usual result, and the callback receives `{ code: "CapacityWarning", message, method, path }`, where `message` is the server's warning text. A callback that throws or rejects cannot fail the request. Without `onWarning` the header is ignored, as before.

```ts
const client = createBaerlyClient({
  baseUrl: "https://api.example.com",
  onWarning: (w) => console.warn(`${w.method} ${w.path}: ${w.message}`),
});
```

Cross-origin browser apps also need their CORS layer to list `Baerly-Capacity-Warning` in `Access-Control-Expose-Headers`.
