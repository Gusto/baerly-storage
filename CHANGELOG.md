# @gusto/baerly-storage

## 0.7.0

### Breaking Changes

0.7.0 is one breaking release. To upgrade from 0.6.0, follow the [0.7.0 upgrade guide](https://github.com/Gusto/baerly-storage/blob/main/docs/guide/upgrading-to-0.7.md), which groups the entries below by what an app author and an operator must do. Each entry also carries its own old-to-new block.

- c62004f: The `Conflict` error code is removed and split in two, `retriable` is derived from the code alone, and `BaerlyError` / `errorEnvelope` take their optional values in one options object.

  - `WriteConflict` (HTTP 409, `retriable: true`, generic public message): a lost conditional write or CAS race. Re-read, then retry with bounded backoff. `Storage` implementations throw it for every rejected precondition (stale `If-Match`, or an `If-None-Match: "*"` collision).
  - `AlreadyExists` (HTTP 409, `retriable: false`, message kept): a duplicate `_id` on `insert`, or `baerly admin restore` into an existing collection without `--force`. Never retry; pick a different `_id` or use `update` / `replace`.

  `BaerlyError.retriable` is a pure function of `code`: only `NetworkError`, `WriteConflict` and `MaintenancePending` are retriable. The HTTP envelope still carries `retriable`, derived from the code. The client SDK ignores the wire value and derives it from the code. A code the client doesn't know (`Conflict` from an older server, or one added by a newer server) decodes by HTTP status, the same way as a response without an envelope: `NetworkError` for 5xx, 408 and 429, otherwise `Internal`. Only the message carries over; the undecoded wire error, including its `resolution`, `issues` and `_id`, is kept on `cause`. The CLI exits 3 for both new codes.

  `new BaerlyError(code, message, options?)` and `errorEnvelope(code, message, options?)` (from `@gusto/baerly-storage/http`) take their optional values in one options object, like `new Error(message, { cause })`. `code` and `message` stay positional. The option types are exported as `BaerlyErrorOptions` (`cause`, `issues`, `status`, `resolution`, `_id`, `retryAfter`) and, from `@gusto/baerly-storage/http`, `ErrorEnvelopeOptions` (`issues`, `resolution`, `_id`, `retryAfter`). The `retriable` argument is gone from both, because no instance can override its code's retry meaning any more.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before
  err.code === "Conflict" && err.retriable; // CAS race
  err.code === "Conflict" && !err.retriable; // duplicate _id
  throw new BaerlyError("Conflict", msg); // custom Storage
  new BaerlyError("NetworkError", "PUT failed", err);
  new BaerlyError(code, msg, cause, issues, status, resolution, retriable);
  errorEnvelope(code, msg, issues, resolution, retriable);

  // after
  err.code === "WriteConflict";
  err.code === "AlreadyExists";
  throw new BaerlyError("WriteConflict", msg);
  new BaerlyError("NetworkError", "PUT failed", { cause: err });
  new BaerlyError(code, msg, { cause, issues, status, resolution, _id });
  errorEnvelope(code, msg, { issues, resolution, _id });
  ```

  An old positional call with more than three arguments, or with any non-options third argument (a string, or an `Error` as in `new BaerlyError(code, msg, err)`), no longer compiles in TypeScript; pass `{ cause: err }`.

  A plain object you passed as the cause is now read as the options. Wrap it: `{ cause: { notApplied: true } }`, not `{ notApplied: true }`. TypeScript flags this only for an object literal that has a key the options don't have; a typed variable, or an object that shares a key such as `status`, compiles and lands on that option instead of `cause`.

  Untyped JavaScript gets no error for any old form. `new BaerlyError(code, msg, err)` reads the options from the error's own `.cause`, so the error itself is dropped, as with `new Error(msg, someError)`, and a `retriable` boolean passed positionally is ignored. Update those call sites by hand. A custom `Storage` must throw `WriteConflict`, never `AlreadyExists`, for a rejected precondition: the kernel treats any other code as a hard failure, and `AlreadyExists` is a public message that would expose the bucket key.

  Splitting `Conflict` renames a capability rather than removing one: both of its meanings survive under the new codes. Under the [API surface lock](https://github.com/Gusto/baerly-storage/blob/main/docs/contributing/conventions/change-discipline.md#api-surface-lock) a rename needs a supersession record, and this entry is that record.

- 88de231: Writes now fail with the new non-retriable `BaerlyError{code:"CapacityExceeded"}` (HTTP 409) instead of silently stalling compaction when a collection reaches its host's fold ceiling (`E` rows or `C` snapshot bytes for the active maintenance profile). Nothing is committed when a write is refused.

  - An insert, or an update that makes a row larger, is refused once the projected snapshot would reach `E` rows or pass `C` bytes. Deletes and same-size or shrinking updates still commit and make room for later growth (on the bytes arm, once the snapshot itself is over the limit, after write-tick maintenance folds them).
  - When the stored snapshot is already past the ceiling (for example a collection folded on a larger host and served by a smaller one), or a pending insert cannot fold onto an `E`-row snapshot, every write is refused; serve it from a larger profile (`BAERLY_MAINTENANCE_PROFILE=cf-paid` or `node`) or export it with `baerly admin dump`. Reads keep working.
  - A batch `.where(...).update()` / `.delete()` is refused before its first row commits. Its per-row `_id` and schema checks also now run for every matched row before any row commits.
  - Concurrent writes cannot together pass the ceiling: when another write commits between a write's check and its own commit, the check runs again over those writes before committing, and the later write is refused. A batch refused this way part-way keeps the rows it already committed. With no concurrent write in between, the commit reads nothing extra.

  The decision is recomputed on every request from the collection's current state, so the refusal clears with no operator action. Direct `Writer` commits, including `baerly admin restore`, are not checked.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before: a collection past its host's fold ceiling kept accepting writes
  // while compaction silently stalled
  await tickets.insert(doc);

  // after: growth can be refused. CapacityExceeded is not retriable, so a
  // generic retry wrapper (retriable === false) will not loop on it.
  try {
    await tickets.insert(doc);
  } catch (err) {
    if (err instanceof BaerlyError && err.code === "CapacityExceeded") {
      // Nothing was committed. Delete or shrink rows, archive the collection,
      // or move it to a host with a larger ceiling; reads and deletes still work.
    } else {
      throw err;
    }
  }
  ```

  Over HTTP the refusal is `409` with `error.code: "CapacityExceeded"`. Alerting that matched `409` as a write conflict should match on `error.code` instead.

- 3d786fa: Adds the `BaerlyError{code:"MaintenancePending"}` error code: HTTP 503 with a `Retry-After` header, retriable, carrying the suggested delay in seconds on `err.retryAfter` (and `error.retryAfter` in the HTTP envelope). It means a write was refused, nothing was committed, and maintenance is catching up; wait the indicated delay and repeat the call.

  Near a collection's fold ceiling, writes now drive maintenance themselves instead of waiting for the usual fold trigger:

  - While a growth write (an insert, or an update that makes a row larger) would be refused with `CapacityExceeded`, an accepted write folds the pending changes in its own write tick once a full fold pass is pending, or as soon as folding them frees room, within the usual per-pass budget.
  - A growth write refused only because pending changes have not folded yet (they would make room once folded, and every pending fold pass lands within the ceiling) runs one bounded fold and fails with `MaintenancePending` (`retryAfter` 1 second) instead of `CapacityExceeded`. Each retry folds one more pass, and the write commits once the room is folded. On a single host the capacity check never admits the growth that leads here, so it follows a move to a host with a smaller fold ceiling, for example a collection written under a larger ceiling whose pending deletes have not folded yet. With nothing pending that would make room, or when no fold can make progress on this host, the refusal stays `CapacityExceeded`.
  - A full fold pass of the pending tail that would rebuild past the byte ceiling now also counts as no progress, alongside a stored snapshot past the ceiling: that pass would defer on every tick, so every write is refused with `CapacityExceeded`, and reads keep working.

  On Cloudflare that fold runs in `ctx.waitUntil` after the response, like every write tick. Reads still never run maintenance, and nothing new is configured.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before: no such code; a write near the ceiling either committed or stalled
  await tickets.insert(doc);

  // after: MaintenancePending is retriable (503 + Retry-After). Wait, then repeat.
  for (let attempt = 0; ; attempt++) {
    try {
      await tickets.insert(doc);
      break;
    } catch (err) {
      if (err instanceof BaerlyError && err.code === "MaintenancePending" && attempt < 2) {
        await new Promise((r) => setTimeout(r, (err.retryAfter ?? 1) * 1000));
        continue;
      }
      throw err;
    }
  }
  ```

  The bundled HTTP client already retries `MaintenancePending` itself (see the client retry entries); a raw-HTTP caller or a custom `fetch` wrapper must honor `Retry-After`. An exhaustive `switch (err.code)` over `BaerlyErrorCode` must add the new case.

- fb77bd5: Adds the `BaerlyError{code:"CursorExpired"}` error code: HTTP 410, not retriable. `GET /v1/since` returns it for a cursor that can no longer resume, because the changes after it are no longer retained or because `baerly admin restore --force` truncated the generation it was minted in. Both used to be `SchemaError` (400), the same code as a form-validation failure. A malformed cursor is still `SchemaError` (400). The resolution is to re-read, then restart with `cursor: ""`; the changes between the dead cursor and the restart are not replayed.

  The React subscription poll (`createBaerlyReact` / `useQuery`) now re-bootstraps on `CursorExpired` instead of `SchemaError`. A `SchemaError` from `/v1/since` now parks the poll like any other non-retriable code, until `refetch`.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before: a hand-rolled /v1/since consumer
  if (res.status === 400 && body.error.code === "SchemaError" && cursor !== "") cursor = "";
  // after
  if (res.status === 410 && body.error.code === "CursorExpired") cursor = ""; // re-read your rows first
  ```

  An exhaustive `switch` over `BaerlyErrorCode` needs a `CursorExpired` case.

- 5b1b607: Adds the `BaerlyError{code:"AmbiguousCommit"}` error code (HTTP 409 with a scrubbed message, CLI exit 3, `retriable: false`). A commit whose outcome cannot be decided from durable state now fails with it instead of reporting success or a retriable storage error. It is returned in two cases:

  - **The create won below the certified-deleted floor.** A create request or a lost-ack retry that straddles a fold plus a log-retirement pass can win its `log/<seq>` create at a sequence the collection has already certified deleted (`log_delete_floor`). The object lands beneath every reader's floor, so no reader will ever consult it, and whether the mutation is visible is undecidable: either the create re-filled a hole retirement had already certified deleted (invisible) or it landed in a live empty slot that a fold absorbed before retirement swept it (visible through the snapshot). Log retirement runs at the end of every maintenance pass that reaches it (scheduled maintenance, and any write tick that did not spend its one phase on a fold), so a collection with enough history to fold and then retire can surface the code; handle it from day one. The check costs one additional GET per commit, a Class B request, so per-write Class A billing is unchanged.
  - **Bounded readback cannot resolve a failed create.** The writer sends each log create once and reads the slot back when the outcome is uncertain. When that readback cannot decide the outcome, the writer returns `AmbiguousCommit` instead of the reported storage error, which could be a retriable `NetworkError` (HTTP 502) and trigger a duplicate write. A definitive `AccessDenied` (HTTP 403) or `InvalidConfig` from the slot's only send still surfaces as-is; the S3 and GCS adapters report one that follows an internally retried attempt as `NetworkError`. A create those adapters saw throttled on every attempt (`429`, or S3's `503 SlowDown`) was never applied, so it still surfaces as retriable `NetworkError`.

  `AmbiguousCommit` carries the affected row's `_id` (`BaerlyError._id`, and `error._id` in the HTTP envelope), including an auto-ID insert's minted id. Re-read that row to reconcile; absence does not prove failure. Under this fault the write contract is at-least-once rather than exactly-once: the writer cannot tell whether an earlier attempt of its own landed, so retrying is the intended recovery and may apply the mutation a second time. Retry an insert with the same `_id` so it cannot create a second document; a deliberate retry may still repeat logical work. `err.retriable` is `false` so a generic conflict-retry wrapper cannot absorb it silently; handle the code explicitly.

  A maintenance dispatcher failure after a durable commit no longer masks the commit result.

  Buckets written by earlier versions need no migration. A bucket whose previous GC already swept a long sub-floor log prefix carries `log_delete_floor = 0` for those sequences until retirement certifies them, so the floor check does not cover those legacy holes until the floor catches up.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before: an undecidable commit resolved as success, or as a retriable error
  await tickets.insert(doc);
  // after: it throws AmbiguousCommit (not retriable). Re-read before retrying.
  try {
    await tickets.insert({ ...doc, _id });
  } catch (err) {
    if (!(err instanceof BaerlyError && err.code === "AmbiguousCommit")) throw err;
    const row = await tickets.get(err._id ?? _id); // the write may or may not have landed
    if (row === undefined) await tickets.insert({ ...doc, _id }); // same _id: cannot duplicate
  }
  ```

  An exhaustive `switch (err.code)` must add `"AmbiguousCommit"`.

- 773169d: Concurrent inserts of the same `_id` now have at most one winner, and exactly one when storage doesn't fail: the first insert to commit keeps the row, and every other one throws `BaerlyError{code:"AlreadyExists"}` (HTTP 409, `retriable: false`) and commits nothing. Previously the duplicate check saw only rows committed before the insert started, so two concurrent inserts of one `_id` could both succeed, and the later one silently replaced the earlier one's body. This applies to caller-supplied and server-minted ids alike. The one exception is an HTTP insert that carries `mintedId` and resends an identical document: it is answered as a replay of the original success rather than `AlreadyExists` (see the `mintedId` entry of this release).

  The writer now reads the log entries committed between the insert's check read and its own commit, and refuses to commit over a live row it finds there. Uncontended, an insert makes no more storage requests than before; each entry a concurrent writer committed in that window costs one more GET. If log retention deleted part of that window before the writer could read it, the insert throws retriable `WriteConflict` instead, still committing nothing; call it again. An insert's `AlreadyExists` now also carries the `_id` (`BaerlyError._id`, and `error._id` in the HTTP envelope).

  The rule is enforced by the writer, so it holds once every process writing to a collection runs this release. A writer still on an older release does not check the window, and its insert can still land over a concurrent one.

  This narrows the `Collection.insert` contract rather than adding to it. Under the [API surface lock](https://github.com/Gusto/baerly-storage/blob/main/docs/contributing/conventions/change-discipline.md#api-surface-lock) a behavioural shift needs a supersession record, and this entry is that record: "concurrent inserts of one `_id` can both succeed" is superseded by "at most one concurrent insert of an `_id` commits".

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before: concurrent inserts of one _id could both resolve
  await tickets.insert({ _id: "t-1", by: "a" }).catch(() => undefined);
  // after: treat AlreadyExists as "someone else won"; re-read instead of retrying
  try {
    await tickets.insert({ _id: "t-1", by: "a" });
  } catch (err) {
    if (!(err instanceof BaerlyError && err.code === "AlreadyExists")) throw err;
    const winner = await tickets.get("t-1"); // the first committer's row
  }
  ```

  Code that used a duplicate insert as an unconditional upsert must call `replace(id, doc)` (last-writer-wins) or `update(id, patch)` instead.

- 8c8d7d6: `update` no longer loses a concurrent write to the same row or brings back a row that was deleted concurrently. Previously, if another write to the same `_id` committed between an update's read and its commit, the update overwrote it with the row as it was read: a concurrent `delete` that returned `{ deleted: 1 }` was undone, and a concurrent update to a different field was lost.

  Updates now follow PostgreSQL READ COMMITTED semantics. The patch is applied to the row's newest committed version, so both writes' fields survive. A row deleted in between is left deleted: `update(id, patch)` returns `{ modified: 0 }` (`404 NotFound` over HTTP), and `.where(p).update(patch)` skips the row and leaves it out of `modified`. For `.where(p).update()`, `p` is evaluated again on the newest version, and a row that no longer matches is skipped. `replace(id, doc)` is still last-writer-wins against a concurrent update, but it no longer resurrects a concurrent delete: it throws `NotFound` and commits nothing. No new error codes.

  `delete` follows the same rule. A row that was deleted after a delete's read, including one whose `_id` was inserted again since, is not deleted again, so of two racing deletes one returns `{ deleted: 1 }` and the other `{ deleted: 0 }` (previously both returned `1`, and the second could destroy the re-inserted row). `.where(p).delete()` evaluates `p` again on the newest version and skips a row that no longer matches, leaving it out of `deleted`. A delete racing an update still deletes the row.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before: update returned { modified: 1 } and could resurrect a row deleted
  // concurrently, or overwrite a concurrent update to another field
  const { modified } = await tickets.update(id, { status: "closed" });

  // after: the patch applies to the newest committed row. A concurrently
  // deleted row stays deleted and reports modified: 0 (HTTP 404 NotFound).
  const { modified } = await tickets.update(id, { status: "closed" });
  if (modified === 0) {
    // row is gone: re-create it explicitly with insert() if that is what you want
  }

  // before: replace() on a concurrently deleted row re-created it
  // after: it throws NotFound and commits nothing
  await tickets.replace(id, doc).catch((err) => {
    if (!(err instanceof BaerlyError && err.code === "NotFound")) throw err;
    return tickets.insert({ ...doc, _id: id });
  });
  ```

  `delete(id)` now returns `{ deleted: 0 }` for the loser of two racing deletes; do not assume `{ deleted: 1 }` means this call removed the row.

- 7245fde: An `update` patch can no longer change or remove a row's `_id`. A patch whose top-level `_id` is present and is not `===` the row's own `_id` (including `_id: null`, a number, or any other non-matching value) now throws `BaerlyError{code:"InvalidConfig"}` (HTTP 400 on `PATCH /v1/c/:collection/:id`) before any row commits. A patch that carries the row's own `_id`, or omits `_id`, or sets it to `undefined`, is accepted as before.

  Previously such a patch silently corrupted data: `update("a", { _id: "b" })` re-keyed the stored post-image so that `get("a")` returned `{ _id: "b", … }` and a later update of `"a"` produced two rows that both carried `_id: "b"`; `update(id, { _id: null })` stripped `_id`, after which a predicate `delete()` reported `{ deleted: 1 }` but tombstoned the wrong key and left the row in place.

  For a predicate update (`where(...).update(patch)`) the check runs for every matched row, with schema validation, before any row commits. When a row is re-applied at its commit to a newer version written concurrently, the check runs again on that version, and rows earlier in the batch are already applied. Atomicity stays per row.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before: renaming a document by patching its _id (silently corrupted the row)
  await db.collection("tickets").update("old-id", { _id: "new-id" });
  // after: insert under the new id, then delete the old one
  const row = await db.collection("tickets").get("old-id");
  await db.collection("tickets").insert({ ...row!, _id: "new-id" });
  await db.collection("tickets").delete("old-id");

  // before: removing _id with a merge-patch null
  await db.collection("tickets").update(id, { _id: null, status: "closed" });
  // after: omit _id from the patch
  await db.collection("tickets").update(id, { status: "closed" });
  ```

  Every insert or update commit now also requires the post-image to be a plain object whose own `_id` is the string the row is stored under. The public `insert` and `replace` already force `_id`, so this only rejects post-images an update patch made inconsistent (for example a patch that is an array or a scalar, which replaces the whole document).

  **Rows the old bug already corrupted.** A stored row whose `_id` is missing, not a string, or a different id from the one it is stored under now makes `update` and `delete` throw `BaerlyError{code:"InvalidResponse"}` (HTTP 502) instead of committing. Before, `update("a", …)` on a row re-keyed to `_id: "b"` wrote a second `_id: "b"` row, and `delete("a")` reported `{ deleted: 1 }` while the row survived. A predicate `update`/`delete` that matches such a row throws when it reaches it; rows earlier in the batch are already applied.

  `replace(id, doc)` repairs the row, because it forces `_id` to `id`. After that, `update` and `delete` work on it again:

  ```ts
  try {
    await db.collection("tickets").update(id, patch);
  } catch (err) {
    if (err instanceof BaerlyError && err.code === "InvalidResponse") {
      // The row stored at `id` carries a corrupt `_id`: rewrite it under `id`.
      const { _id, ...fields } = (await db.collection("tickets").get(id))!;
      await db.collection("tickets").replace(id, { ...fields, _id: id });
      await db.collection("tickets").update(id, patch);
    } else {
      throw err;
    }
  }
  ```

  To remove a corrupt row instead, `replace` it first and then `delete(id)`.

- e11f20a: **Behavior change:** `update` (by id or by predicate, in-process and over HTTP) applies its patch as RFC 7396 defines, with one exception: patch members named `__proto__`, `constructor` or `prototype` are skipped at every depth, so `update(id, { constructor: null })` reports `modified: 1` and changes nothing. A `null` member now deletes at every depth, so a patch never stores `null`: under a field that is absent or holds a scalar or array, an object patch merges into `{}` and its nulls are dropped. `update(id, { meta: { a: 1, b: null } })` on a row without `meta` now stores `meta: { a: 1 }`; before, it stored `meta: { a: 1, b: null }`. A `null` inside an array is still stored as written, and `insert` and `replace` are unchanged. Beneath an absent field, those three member names are now dropped too; before, the patch object was stored as written, including them. Rows written by an earlier release keep any stored nulls, and nothing rewrites them: setting such a field to a value overwrites it, only a `null` for that exact field deletes it, and a patch that touches only its parent leaves the stored `null` in place.

- 250894e: **Breaking:** `insert`, `replace` and `update` (by id or by predicate) now refuse a document or patch holding a value JSON cannot store as written, with `BaerlyError{code:"InvalidConfig"}` before any storage call. The message names the path of the first offending value, and `err.resolution` says how to convert it.

  Refused at any depth: `NaN`, `Infinity`, `-Infinity`, an `undefined` object member (on `insert` and `replace`), an `undefined` or missing array element, a function, a symbol, a bigint, a circular reference, and any nested object that is not a plain object or array (`Date`, `Map`, `Set`, typed arrays, boxed primitives, class instances). Callable or accessor `toJSON` properties are refused without invoking them, including nonenumerable and inherited hooks on objects, arrays, and the root. Convert the intended value to plain JSON explicitly instead. The document itself may still be a class instance without a serialization hook: its own fields are stored, as before. `update` checks the patch before any I/O and each merged post-image before any write; an `undefined` patch member is absent and leaves that field unchanged, as the same patch sent over HTTP does. Before, the write path's `JSON.stringify` silently stored `null` for `NaN`/`±Infinity` and for `undefined` array elements, dropped `undefined` members, functions and symbols, stored a `Date` as its ISO string and a `Map` as `{}`, and threw a raw `TypeError` for a bigint or a cycle. The HTTP client (`createBaerlyClient`) applies the same check before it sends, because a server only receives what `JSON.stringify` produced. `null` values, `-0`, and a top-level `_id: undefined` (treated as absent) are accepted as before. A raw-HTTP caller cannot express any of these values, so its requests are unaffected. Inputs must stay stable until the write completes; changing getters, proxies, and concurrent mutation of the input graph are unsupported.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before: silently stored { due: "1970-01-01T00:00:00.000Z", score: null, tags: {} }
  await db.collection("tasks").insert({ due: new Date(0), score: NaN, tags: new Map() });
  // after: convert to plain JSON yourself
  await db.collection("tasks").insert({
    due: new Date(0).toISOString(),
    score: null,
    tags: Object.fromEntries(new Map()),
  });

  // before: a nested Date in a patch was merged away or stored as a string
  await db.collection("tasks").update(id, { meta: { due: new Date(0) } });
  // after
  await db.collection("tasks").update(id, { meta: { due: new Date(0).toISOString() } });
  ```

- 67ae5f9: **Breaking:** a document nests at most 100 levels (`MAX_DOCUMENT_DEPTH`, MongoDB's limit), where each object or array is a level and the document itself is the first. `insert`, `replace`, an `update` patch and each merged post-image (by id or by predicate) deeper than that throw `BaerlyError{code:"SchemaError"}` (HTTP 400) before any write. The message names the limit and the path to the first container past it, `err.issues` carries the full path, and `err.resolution` says how to flatten the data. The HTTP client (`createBaerlyClient`) applies the same check before it sends, and `baerly admin restore` refuses a deeper dump line with its line number. Before, nesting was unbounded: a document deep enough to overflow the call stack failed with `500 Internal`, and one that fit a deep-stack host could overflow a recursive path on a host with a shallower stack. A row an earlier release stored deeper stays readable and deletable, and an update that flattens it under the limit commits.

- 6553480: **Breaking:** a document is capped at 1 MiB (1,048,576 bytes) of JSON, `_id` included. `insert`, `replace` and `update` (by id or by predicate) refuse a write whose resulting row would encode larger, with `BaerlyError{code:"InvalidConfig"}` (HTTP 400) before that row is written; the message states the row's size and the limit, and `err.resolution` says how to split it. `update` checks each merged post-image, not the patch, so merge-patches that each fit the HTTP body cap can no longer grow a row past 1 MiB; a multi-row update that finds an over-cap row during initial validation commits none. Commit-time revalidation after a concurrent write can still refuse a later row after earlier rows committed; re-read before retrying. `baerly admin restore` refuses a dump line over the cap with its line number. Before, in-process writes had no size bound at all, and repeated HTTP patches could grow a row without limit. A row an earlier release stored over the cap stays readable and deletable, and an update that shrinks it under the cap commits; only a write producing an over-cap row is refused. `PayloadTooLarge` (413) still means the request body itself exceeded `MAX_BODY_BYTES`.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before: one row that keeps growing (now refused once it passes 1 MiB)
  await db.collection("threads").update(threadId, { messages: [...messages, next] });
  // after: one row per item, keyed back to its parent
  await db.collection("messages").insert({ threadId, ...next });
  ```

- 52afb9e: **Breaking:** `insert` now refuses a present, non-string `_id`, and `get` refuses an id no row can be stored under. Both throw `BaerlyError{code:"InvalidConfig"}` (HTTP 400) before any storage call.

  `insert({ _id: 42 })` and every other present non-string `_id` (`true`, `{}`, `[]`, `-0`, `NaN`, `null`) used to be silently replaced by a generated UUIDv7, so the row landed under an id the caller never saw. It now throws, in-process and in the HTTP client (which throws before sending). An absent `_id`, `_id: undefined` and `_id: ""` still get a generated id.

  `get(id)` and `GET /v1/c/:collection/:id` with an id that breaks the `_id` key rules (empty, `/`, `.` or `..`, a control character, a leading `_`, over 256 UTF-8 bytes) used to answer "not found" (`undefined`, HTTP 404) after reading storage. They now throw `InvalidConfig` (HTTP 400). Point reads do not require NFC, so a row an earlier release stored under a non-NFC `_id` stays readable. In the HTTP client, `get("")`, `get(".")` and `get("..")` used to resolve to the list route and return an array of rows; they now throw `InvalidConfig` without a request.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before: a numeric id was silently replaced by a generated one
  await db.collection("orders").insert({ _id: 42, total: 10 });
  // after: pass the id as a string, or omit it to have one generated
  await db.collection("orders").insert({ _id: String(42), total: 10 });

  // before: an invalid id read as "not found"
  const row = await db.collection("orders").get(userSuppliedId); // undefined
  // after: it throws InvalidConfig; treat that as "no such row" if the id is untrusted
  let found;
  try {
    found = await db.collection("orders").get(userSuppliedId);
  } catch (err) {
    if (!(err instanceof BaerlyError && err.code === "InvalidConfig")) throw err;
    found = undefined;
  }
  ```

  The HTTP client also refuses non-string ids on `get`, `update`, `replace` and `delete` before sending a request, instead of coercing them into a different row's id.

- 274c430: **Breaking (types only):** every row a read returns is typed with `_id: string`, and `insert` types `_id` as an optional string. This holds for collections with no bound config (row type `DocumentData`), for bound-config collections, and for the HTTP client. Runtime behavior is unchanged: a stored row's `_id` is always a string, and `insert` already refuses a non-string `_id` with `InvalidConfig`.

  `first()`, `all()` and `get(id)` on a collection, and `first()` / `all()` on a query, return `T & { _id: string }` instead of `T`. `insert(doc)` takes `Partial<T> & DocumentData & { _id?: string }`. A row's `_id` now passes straight to `get`, `update`, `replace` and `delete`, with dot access (`row._id`), on an unconfigured collection too.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before: `_id` typed as DocumentValue on an unconfigured collection
  for (const row of await notes.all()) await notes.delete(String(row["_id"]));
  // after: `_id` is a string
  for (const row of await notes.all()) await notes.delete(row._id);

  // before: a non-string `_id` compiled, then threw InvalidConfig at runtime
  await notes.insert({ _id: 42, title: "x" });
  // after: it is a compile error; pass a string, or omit `_id` to have one minted
  await notes.insert({ _id: String(42), title: "x" });

  // before: a cast to a row shape without `_id`
  const rows = (await notes.all()) as Array<{ title: string }>;
  // after: include `_id` in the asserted shape (or bind a config with a schema)
  const rows = (await notes.all()) as Array<{ _id: string; title: string }>;
  ```

  A hand-written fake or mock of `Collection<T>` / `ClientCollection<T>` whose row type lacks `_id` no longer compiles: `const fakeAll: Collection<Note>["all"] = async () => [] as Note[]` is TS2322. Add `_id: string` to the row type.

  Code that narrowed `_id` with `String(row._id)` or `row._id as string` keeps compiling. Row types that already declare `_id: string` are unaffected. Code that relied on a non-string `_id` type now gets a compile error.

- 9e81e63: **Breaking:** a document `_id` must now be in Unicode Normalization Form C (`id === id.normalize("NFC")`). `insert` with a caller-supplied `_id`, `replace`, their HTTP routes (`POST`, `PUT`), and `baerly admin restore` refuse any other `_id` with `InvalidConfig` (HTTP 400) before writing that row. Restore commits row by row, so rows before a rejected line are already written. SDK-minted UUIDv7 ids are ASCII and always pass. Ids that differ only by case (`A` / `a`) or by compatibility form (`ﬁ` / `fi`) are still distinct.

  R2 stores canonically-equivalent keys as one object (NFC `é` and NFD `e` + U+0301 list back as one key), so NFC gives each `_id` one spelling and one byte form for any object a future storage format keys by `_id`.

  Rows already stored under a non-NFC `_id` keep working for reads: `get` and `where` return them, and `delete` removes them. `update` and `replace` refuse them, because they would commit a new row version under the non-NFC id. To keep such a row writable, read it by `_id` and insert a copy under a fresh NFC id that is not canonically equivalent to the original (for example, omit `_id` for a UUID), then delete the original. If a collection already holds two rows whose ids are canonically equivalent, read both rows by `_id`, copy each under a fresh NFC id that is not canonically equivalent to either original, then delete the originals. An NDJSON export that contains a non-NFC `_id` must have that id normalized before `baerly admin restore` accepts it; ensure the resulting ids are unique.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before: any string was accepted as a caller-supplied _id
  await tickets.insert({ _id: "café", title: "hi" }); // NFD "é"
  // after: normalize ids you mint, or omit _id to get a UUIDv7
  await tickets.insert({ _id: "café".normalize("NFC"), title: "hi" });
  await tickets.insert({ title: "hi" });
  ```

  Normalizing an id gives a new identity, so apply it only to ids of rows that do not exist yet. For rows already stored under a non-NFC `_id`, use the copy recipe above; for a dump, rewrite the id in the NDJSON before `baerly admin restore`.

- 8032ebf: **Breaking:** app, tenant, and collection names must now be in Unicode Normalization Form C (`name === name.normalize("NFC")`), the rule `_id` writes already follow. `Db.create` (including `config.collections` keys), `db.collection`, every HTTP route, `ensureTable`, and the writing CLI verb (`baerly admin restore`) refuse any other name with `InvalidConfig` (HTTP 400). Names are never normalized for you, so two canonically-equivalent names never become one. Names that differ only by case (`Tickets` / `tickets`) or by compatibility form (`ﬁle` / `file`) stay distinct.

  R2 stores canonically-equivalent keys as one object, so a collection named with NFD `e` + U+0301 and one named with NFC `é` shared one key prefix on R2 and had two prefixes on every other host.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  First find stored non-NFC names: `baerly admin usage --target=node --bucket=<uri> --app=<app> --tenant=<tenant>` reports each non-NFC app, tenant, or listed collection name, and each pair of canonically-equivalent collection names, as a `names` warning. It scans only the `--tenant` you pass, so list every tenant your verifier can mint and scan each. Listed key spellings are not a complete inventory of the names stored in log and snapshot bodies. Normalizing is only safe for a name that has no stored data under its non-NFC spelling. The SDK and HTTP refuse non-NFC names, while the read-only CLI still accepts them. On R2 a normalized collection name can address legacy objects: reads and folds that encounter the other collection spelling refuse with `InvalidConfig` rather than skip those rows. Stored records do not identify the app or tenant, so this alias guard cannot detect a normalized legacy app or tenant; those aliases can still read and modify the same data. Migrate them to fresh namespaces instead of relying on rejection.

  For a name with no stored non-NFC data:

  ```ts
  // before
  const db = Db.create({ storage, app, tenant: claims.org });
  db.collection(userInput);
  // after
  const db = Db.create({ storage, app, tenant: claims.org.normalize("NFC") });
  db.collection(userInput.normalize("NFC"));
  ```

  To migrate stored data, dump it and restore it under an NFC name that is not canonically equivalent to the original (for example `café-v2`, not `café`), then point the app at the new name:

  ```sh
  baerly admin dump --bucket=$B --app=app --tenant=t --collection=<legacy name> > rows.ndjson
  baerly admin restore --bucket=$B --app=app --tenant=t --collection=café-v2 < rows.ndjson
  ```

  The normalized original name is not a safe target: on R2 it addresses the legacy objects. Before migrating, `baerly admin fsck` reports each non-NFC name as a `names` warning (exit 4), and `baerly admin dump` reports non-NFC names, non-NFC `_id`s, and groups of canonically-equivalent `_id`s in its `--json` envelope's `legacy` field (or as stderr warnings); give each listed row a fresh NFC `_id` in the NDJSON before `admin restore`. A non-NFC app or tenant migrates the same way, one collection at a time.

  If a legacy R2 log contains both collection spellings, ordinary dump and export refuse it. Stop writes and maintenance and preserve a copy of the source bucket. Recover each original spelling separately with `baerly admin dump --recover-legacy-names --bucket=$B --app=app --tenant=t --collection=<exact stored name> > rows.ndjson`, then restore each dump into a different fresh NFC collection. Recovery matches collection names byte-for-byte, so overlapping `_id`s, updates, and deletes from the other spelling never merge into the selected collection. Text mode warns on stderr; `--json` reports `recovery: { collection_match: "exact", historical_completeness: "not_guaranteed" }` in the result envelope.

  Recovery requires either no snapshot or a snapshot naming the selected spelling, and retains the normal snapshot hash and dense-log checks. A snapshot naming the other spelling is refused rather than treated as an empty base. Earlier compaction may already have discarded rows belonging to the other spelling; this command cannot reconstruct them or certify historical completeness. Keep the source copy for separate recovery if the snapshot does not match.

- 549b6dc: **Breaking:** a document `_id` and an app, tenant, or collection name may no longer contain an unpaired UTF-16 surrogate (`value.isWellFormed()` must be `true`). `insert` with a caller-supplied `_id`, `replace`, `POST /v1/c/:collection`, and `baerly admin restore` refuse such an `_id` with `InvalidConfig` (HTTP 400, message included) before writing. Every surface that refuses a non-NFC name (`Db.create`, `db.collection`, every HTTP route, `ensureTable`, and the writing CLI verbs) refuses such a name with `InvalidConfig`. When encoding an `_id` or collection name into a URL path, the HTTP client now throws `InvalidConfig` before sending a request instead of a `URIError`. Surrogate pairs (emoji and other astral characters) are well-formed and still accepted.

  Such a row was unaddressable over HTTP: the client's `encodeURIComponent` threw, and no percent-encoding reaches the route as the same id. The S3 and GCS adapters threw a raw `URIError` on any key holding one, and local-fs refused the key.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before: slicing can split a surrogate pair
  await notes.insert({ _id: title.slice(0, 40), title });
  // after: slice by code point, or let the SDK mint a UUID
  await notes.insert({ _id: Array.from(title).slice(0, 40).join(""), title });
  await notes.insert({ title });
  ```

  Rows already stored under such an `_id` stay readable and deletable in-process: `get`, `where`, and `delete` accept them, while `update` and `replace` refuse them. To find them, run `baerly admin dump --json --bucket=<uri> --app=<app> --tenant=<tenant> --collection=<name>`; its `legacy.ill_formed_ids` field lists them (text mode prints a stderr warning), including under `--recover-legacy-names`. To keep one writable, read it by `_id`, remove `_id` from the copy so `insert` generates a fresh UUID, then delete the original with the SDK. To migrate a whole collection, give each listed row a well-formed `_id` in the dump and `baerly admin restore` it into a new collection.

  A name with an unpaired surrogate never reached S3, GCS, or local-fs storage, and the CLI cannot pass one (Node decodes such argv bytes to U+FFFD); a programmatic `runDump` that does reports it in `legacy.ill_formed_names`. If a Worker on the R2 binding stored data under such a name, copy it to a fresh well-formed NFC name with that Worker on your current release before upgrading. Do not use `name.toWellFormed()` as the destination, which can address the original objects on R2.

- b2b1fc8: `baerly admin restore` now refuses a dump line whose `_id` repeats an earlier line, or whose `_id` is outside the write domain (key-segment rule, NFC), with `InvalidConfig` (exit 1) naming the line number and the escaped `_id`. Every restore failure reports how many rows were already committed: rows before the failing line stay committed, the failing line and later lines do not.

  **Migration — agents: if you relied on the LEFT, use the RIGHT:**

  ```text
  # before: a repeated _id silently overwrote the earlier row; a dump of
  # non-NFC ids failed only at commit time with no committed-row count
  baerly admin restore ... < dump.ndjson

  # after: the second occurrence is refused with the count of committed
  # rows. Fix or rewrite the _id in the dump (to a fresh NFC id that is not
  # canonically equivalent to the original), then restore into a fresh
  # target or with --force
  baerly admin restore ... --force < fixed-dump.ndjson
  ```

  Restore never rewrites an `_id`; see `docs/guide/backups.md`.

- b96d6d1: **Breaking:** `@gusto/baerly-storage/maintenance` exports one function, `runScheduledMaintenance(target, options)`. It is addressed by collection (`{ storage, app, tenant, collection }`, the names you pass to `Db.create` and `db.collection`), not by a `current.json` key, and sized by `tier` (the `BAERLY_MAINTENANCE_PROFILE` vocabulary: `"cf-free"`, `"cf-paid"`, or the unbounded default `"node"`). One call runs one whole pass (compact, GC, then log retirement) on every supported host. It returns `{ folded, deferred?: { reason }, gcDeleted, pending }`.

  - Removed from `@gusto/baerly-storage/maintenance`: `compact`, `runGc`, `CompactOptions`, `CompactResult`, `RunGcOptions`, `RunGcResult`, `MaintenanceArgs`, `MaintenanceProfile`, `MAINTENANCE_PROFILE_CF_FREE`, `MAINTENANCE_PROFILE_CF_PAID`, `MAINTENANCE_PROFILE_NODE`, `CLOUDFLARE_FREE_TIER`, `CLOUDFLARE_PAID_TIER` and `InternalMaintenanceOptions` (documented as internal, but its fields exposed knobs such as `gc.graceMillis`, where `0` risks deleting an object a retrying writer is about to find). `MaintenanceOptions` and `MaintenanceResult` keep their names with the new shapes; `MaintenanceTarget` is new.
  - Removed from `@gusto/baerly-storage/cloudflare`: `resolveCfMaintenanceProfile`. Pass the `BAERLY_MAINTENANCE_PROFILE` value as `tier`.
  - Scheduled maintenance folds whatever live tail exists. In 0.6 a scheduled pass inherited the in-band write tick's floor of 100 entries (50 for the Cloudflare Paid recipe), so a cron on a low-write collection ticked green while folding nothing. `minEntriesToCompact` is no longer an option: Node and `"cf-paid"` passes fold from one pending entry; under `"cf-free"`, a pass folds one 20-entry slice only when at least 20 entries are pending, and a remaining tail of 1–19 entries stays unfolded until more writes arrive. Every fold rewrites the whole snapshot, so to batch rewrites, run passes less often. A pass that skips a non-empty tail below its floor counts `db.compaction.below_min_total` (labelled by `collection`); an idle pass does not. The per-trigger floors are in `docs/spec/sync-protocol.md` § "Scheduled vs in-band fold floors".
  - Every pass fits its host's per-invocation request limit, counting every storage call (GETs and each LIST page): 900 through the R2 binding and 45 through `fetch` on Workers Free, 9,000 on Workers Paid. Under `"cf-free"` a pass is at most compaction 49 calls (147 with every call retried), GC 22 (66), log retirement 23 (69), and 94 (282) for the whole pass, so one call per invocation fits Workers Free with the R2 binding (Free CPU stays best effort). Compaction walks at most 25 stale-tail log slots per pass under `"cf-free"` and 1,000 under `"cf-paid"` (worst case 1,204 calls per pass, 3,612 retried). A pass that cannot yet prove its fold durably advances `tail_hint` and returns `deferred: { reason: "budget" }`; the next pass resumes from that checkpoint.
  - Workers Free with storage over `fetch` (S3 over HTTP, GCS) is not a supported host: a whole pass does not fit 45 calls. Run S3 on Workers Paid with `tier: "cf-paid"`. The even/odd-minute alternation of `compact()` and `runGc()` that 0.6 documented for Workers Free is gone with them.
  - Invalid `app` / `tenant` / `collection` names and an unknown `tier` throw `InvalidConfig` before any storage call.

  In-band maintenance is unchanged and still needs no import; a schedule stays optional.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before
  import { runScheduledMaintenance } from "@gusto/baerly-storage/maintenance";
  const res = await runScheduledMaintenance({
    storage,
    currentJsonKey: "app/helpdesk/tenant/acme/manifests/tickets/current.json",
  });
  console.log(res.compact.entriesFolded, res.gc.swept);
  // after
  import { runScheduledMaintenance } from "@gusto/baerly-storage/maintenance";
  const target = { storage, app: "helpdesk", tenant: "acme", collection: "tickets" };
  const res = await runScheduledMaintenance(target);
  console.log(res.folded, res.gcDeleted);

  // before (Cloudflare, R2 binding)
  await runScheduledMaintenance({ storage, currentJsonKey }, CLOUDFLARE_FREE_TIER); // or CLOUDFLARE_PAID_TIER
  // after
  await runScheduledMaintenance(target, { tier: "cf-free" }); // or "cf-paid"

  // before (Workers Free, storage over fetch)
  if (Math.floor(controller.scheduledTime / 60_000) % 2 === 0) {
    await compact({ storage, currentJsonKey }, CLOUDFLARE_FREE_TIER.compact);
  } else {
    await runGc({ storage, currentJsonKey }, CLOUDFLARE_FREE_TIER.gc);
  }
  // after: Workers Free with S3 is unsupported; on Workers Paid, one whole pass
  await runScheduledMaintenance(target, { tier: "cf-paid" });

  // before
  const profile = resolveCfMaintenanceProfile((k) => env[k]);
  // after
  const tier = env.BAERLY_MAINTENANCE_PROFILE === "cf-paid" ? "cf-paid" : "cf-free";

  // before
  await runScheduledMaintenance(args, { compact: { minEntriesToCompact: 10 } });
  // after: no floor option; run the pass on a slower cron to batch folds
  await runScheduledMaintenance(target);
  ```

- 37d833b: Stale log objects are now reclaimed by a sequence window rather than a timed mark-and-sweep. Steady-state log object count is bounded by a constant regardless of how long a collection runs.

  This replaces GC's `stale-log` category, and GC no longer lists the `log/` prefix. Log keys are computable, so the retirement pass issues DELETEs directly and needs no LIST. Reclamation no longer depends on object timestamps, so it behaves identically on every backend. Retirement records its progress in a new optional `current.json` field, `log_delete_floor`: the exclusive upper bound of the contiguous log prefix certified deleted. It is distinct from `log_seq_start`, the lowest sequence a reader may still need; the gap between them is the retained safety window. Absent or `0` means no deleted prefix is certified, so `schema_version` stays at `3` and existing buckets are unaffected. `baerly admin restore --force` drops the field when it reseeds. See invariants 5 and 12 in `docs/spec/sync-protocol.md`.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before
  const { marked } = await runGc(args);
  console.log(marked.stale_log);
  // after: runGc is no longer published. Log retirement runs in the maintenance
  // pass that reaches it (scheduled maintenance, or a write tick that did not fold).
  const { gcDeleted } = await runScheduledMaintenance({ storage, app, tenant, collection });
  ```

  Remove reads of `RunGcResult.marked.stale_log`. Code that relied on GC listing `log/` must not; keys are computed from the sequence window.

- 0933f51: **Breaking:** the published barrels drop undocumented kernel internals. None of these names was in `API.md`; they are snapshot-format and write-tick-runner internals that the snapshot format change will reshape.

  - `@gusto/baerly-storage` no longer exports `SnapshotBody`, `encodeSnapshotBody`, `snapshotKey`, `loadSnapshotAsMap`, `walkLogRange`, `probeTailFrom`, `resolveVerifier`, `collectionsToMaps` or `validateOrThrow`. `SchemaIssue` and `SchemaValidator` stay.
  - `@gusto/baerly-storage/maintenance` no longer exports `runBoundedMaintenance`, `BoundedMaintenanceOptions`, `dispatchWriteTick`, `dispatchInlineAwaited`, `MaintenanceDispatch`, `parseMaintenanceEnv`, `isFoldViable`, `resolveFoldCeilings`, `FoldCeilings`, `estimateTailBytes`, `shouldFireMaintenance` or `crossesGcBoundary`. `runScheduledMaintenance` and its types stay (see the entry of this release where `/maintenance` "exports one function").
  - `@gusto/baerly-storage/observability` no longer exports `logMaintenanceWarning`, `flushUnauthorizedAndRespond` (adapter wiring) or the `ReadEnvelope` type, and `ObservabilityContext` / `ObservabilityContextInit` drop the adapter-set `maintenance` and `readEnvelope` fields. Work inside a context you create runs write-tick maintenance inline at the default caps, with no read envelope; `baerlyWorker` / `baerlyNode` set the host values.
  - `Db` loses the `@internal` read seams `collectionReadContext`, `getCurrentJson`, `getLogEntry`, `probeLogTail` and `probeLogChunk`, so `CurrentJson` and `TailProbeChunk` leave the public types. Use the collection API (`db.collection(name)`) and `/v1/since` instead.

  The write-tick runner, dispatch, and env parsing are wired by `baerlyWorker` / `baerlyNode`; in-band maintenance needs no import. Scheduled maintenance keeps using `runScheduledMaintenance`.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before
  import { runBoundedMaintenance } from "@gusto/baerly-storage/maintenance";
  await runBoundedMaintenance(/* ... */);
  // after: schedule the public runner, or let baerlyWorker / baerlyNode tick in-band
  import { runScheduledMaintenance } from "@gusto/baerly-storage/maintenance";
  await runScheduledMaintenance({ storage, app, tenant, collection }, { tier: "cf-free" });

  // before
  import { loadSnapshotAsMap, walkLogRange } from "@gusto/baerly-storage";
  // after: read rows through the Db API
  const rows = await db.collection("tickets").all();
  ```

- d8cc108: **Breaking:** declared `indexes` are now validated no-ops: writes no longer create or delete index markers, reads never consult them, and the index-marker tooling is removed. Every read takes its rows from the complete snapshot and committed log, so a declared index does not speed up a read or change its result, and concurrent commits cannot hide live rows from a read or a mutation's target selection. A query whose row choice matters under `limit` needs an explicit `order`.

  - A declared index changes no storage call: an insert, update, or delete on a collection that declares indexes costs exactly what it costs on one that does not, and the committing `log/<seq>` create is the write's only storage write. Nothing is written under `<collection>/index/` any more, and an update or delete no longer reads back the row's previous log entries to find stale markers.
  - A row may now hold an array in a declared index field (that write used to throw `SchemaError`), or a value long enough that its marker key passed the 1024-byte key limit (that write used to throw `InvalidConfig`).
  - Under the `cf-free` profile with storage over `fetch` (S3 over HTTP), the most expensive write request, maintenance included, drops from 45 to 30 storage calls. The "3 indexes per write" bound and the refusal of an update that changes 9 or more indexed fields are gone; a write is refused only once 32 or more writes are pending, whatever indexes are declared.
  - `rebuildIndex` (and `RebuildIndexOptions` / `RebuildIndexResult`) is removed from `@gusto/baerly-storage/maintenance`, and `allIndexKeysFor` from `@gusto/baerly-storage`.
  - `baerly admin rebuild-index` is removed. `baerly admin fsck` loses `--indexes`, `--fix`, and `--config`; passing one fails as an unknown flag (exit 1). Plain `fsck` is unchanged and never reads `index/`. `baerly inspect` loses `--config` and the per-index key counts (`indexes` in the `--json` result).
  - `collections.<name>.indexes` stays in the config type. `Db.create` now validates every declaration and throws on a malformed one instead of failing at the first write: `SchemaError` for a bad name or empty `on`, `InvalidConfig` for a reserved leading-`_` name or a dotted `on` path (`"meta.owner"`, which already failed every write).
  - The `db.write.index_ops_per_logical_write` histogram and the `db.write.index_cleanup_errors_total` counter are no longer emitted; remove dashboards on them. `db.write.post_commit_refused_total` keeps only `phase: "delete-floor-check"`.

  **Legacy markers.** Objects that earlier releases wrote under `<collection>/index/` are inert: nothing reads, writes, or reclaims them, and keeping them is harmless. To reclaim the bytes once a rollback is no longer possible, delete the prefix (see "Legacy index markers" in `docs/guide/backups.md`):

  ```sh
  aws s3 rm --recursive --dryrun "s3://bucket/app/acme/tenant/t1/manifests/tickets/index/"
  ```

  **Rollback and mixed fleets.** A 0.6 instance takes an indexed query's rows from the markers, so while it reads a collection that 0.7 has written to (a rolling deploy, or after rolling back), its indexed queries miss every row 0.7 inserted or changed. 0.7 ignores markers a 0.6 writer keeps creating. 0.6's `baerly admin rebuild-index` aborts on a value 0.7 now accepts in a declared index field (an array, or a value too long for a marker key), leaving that index incomplete. First stop every app writer and any scheduled maintenance, then roll back one of two ways: remove `indexes` from the affected collections in the 0.6 configuration so 0.6 answers those queries with a full scan, or, while still on 0.7, rewrite every row holding such a value in a field an index you keep declares, then roll back and run 0.6's `baerly admin rebuild-index` once per kept index (with `--config` for a composite index; 0.6's `--on` takes one field). Either way, finish the index repair and check indexed query results before reopening traffic. See "Legacy index markers" in `docs/guide/backups.md`.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before
  import { rebuildIndex } from "@gusto/baerly-storage/maintenance";
  await rebuildIndex(storage, currentJsonKey, { name: "by_status", on: "status" });
  // after: delete the call. Reads do not depend on index markers.

  // before
  export default defineConfig({
    collections: { tickets: { indexes: [{ name: "by_status", on: "status" }] } },
  });
  // after: omit `indexes`. A query like `.where({ status: "open" })` returns the same rows either way.
  export default defineConfig({ collections: { tickets: {} } });
  ```

  ```sh
  # before
  baerly admin rebuild-index --bucket=$B --collection=tickets --index=by_status --on=status
  baerly admin fsck --bucket=$B --collection=tickets --indexes --fix --config=./dist/baerly.config.mjs
  # after: no reconciliation step exists; run the plain consistency walk
  baerly admin fsck --bucket=$B --collection=tickets
  ```

  Existing configs that declare `indexes` keep compiling and keep working.

- 555683b: New insert and update commits no longer create `content/<sha>.json` side objects, and GC's `orphan-content` category is removed. The committing `log/<seq>.json` create remains the commit point.

  Existing content objects, and any a v0.6.0 node creates during a mixed rollout, are inert: no kernel reader opens one and GC no longer LISTs, reads, or deletes anything under `<collection>/content/`. They cost storage and nothing else, and are left on the bucket. No cleanup is required for correctness or migration. To reclaim the bytes after legacy writers are quiesced, follow the [backups and recovery runbook](https://github.com/Gusto/baerly-storage/blob/main/docs/guide/backups.md#legacy-content-cleanup), which preserves the configured bucket key prefix and requires verifying the target before recursive deletion.

  `RunGcResult.marked.orphan_content` (and `RunGcResult` itself; see the entry of this release where `/maintenance` "exports one function") is gone. `gc/pending.json` loses `content_scan_cursor`, and `GC_PENDING_SCHEMA_VERSION` stays at `1`. A ledger written by v0.6.0 still decodes: the field is ignored on read and dropped on the next write, and a legacy `orphan-content` candidate is evicted from the ledger on the next pass without deleting the object it names, so it cannot crowd out new marks.

  A GC tick is cheaper as a result: a maximally contended Cloudflare Free write-tick GC pass costs 26 storage operations, down from 50. Every GC tick also refreshes a stale `tail_hint` afterwards, so a collection that GCs without ever folding, or that has an unreadable log entry or snapshot, keeps its read and write forward-probes bounded instead of re-walking a growing live tail. Any one maintenance tick publishes `tail_hint` at most once.

  **Migration — direct-bucket consumers: if you did the LEFT, use the RIGHT:**

  ```ts
  {
    // before: derive, fetch, and decode the post-image side object
    if (entry.after === undefined) throw new Error("entry has no post-image");
    const bytes = encodeJsonBytes(entry.after);
    const version = await versionFromContent(bytes);
    const got = await storage.get(`${collectionPrefix}/content/${version}.json`);
    if (got === null) throw new Error("legacy content object is missing");
    const body = decodeJsonBytes<DocumentData>(got.body);
  }

  {
    // after: the committed post-image is inline
    if (entry.after === undefined) throw new Error("entry has no post-image");
    const body: DocumentData = entry.after;
  }
  ```

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before (0.6.0)
  const { marked } = await runGc(args);
  console.log(marked.orphan_content);
  // after: runGc is no longer published; a scheduled pass reports deletions
  const { gcDeleted, pending } = await runScheduledMaintenance({
    storage,
    app,
    tenant,
    collection,
  });
  ```

  Normal `@gusto/baerly-storage` API consumers and existing v0.6.0 buckets require no migration.

- 5d7631f: The `Storage` interface no longer has `versionId`, conditional GET, or `StorageListEntry.lastModified`. Objects are read unconditionally and carry only an `etag`; a listed object is `key` + `etag` only. Conditional PUT (`ifMatch`, `ifNoneMatch: "*"`) is unchanged and remains the commit primitive. The kernel never issued a conditional GET or read `versionId`, and GC, the only reader of `lastModified`, now anchors its grace period on when it marked a candidate (see the GC grace entry of this release). Wall-clock needs are served by `StoragePutResult.serverDate`, which is unchanged. This only affects custom `Storage` adapters and code that called `storage.get` or `storage.list` directly. The conformance suite drops its `supportsConditionalGet` option and the conditional-get cases.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before
  const got = await storage.get(key, { ifNoneMatch: etag, versionId, signal });
  const { etag, versionId } = await storage.put(key, body);
  defineStorageConformanceSuite("MyStorage", factory, { supportsConditionalGet: false });
  yield { key, etag, lastModified }; // in a custom list()
  // after
  const got = await storage.get(key, { signal }); // always unconditional, current version
  const { etag } = await storage.put(key, body);
  defineStorageConformanceSuite("MyStorage", factory);
  yield { key, etag };
  ```

  Adapter authors: delete the `ifNoneMatch` / `versionId` handling from `get`, the `versionId` field from `get` and `put` results, any 304 mapping, and `lastModified` from listed entries (an adapter that still yields it fails its excess-property check). `StorageGetOptions` is now `{ signal? }`, `StorageGetResult` is `{ body, etag }`, and `StoragePutResult` is `{ etag, serverDate? }`. Pin a historical object by keying it (the protocol's log and snapshot keys are immutable), not by S3 version id.

- cf28a51: Storage requests now retry at one layer, with at most 3 attempts per request.

  - `S3HttpStorage` and `GcsHttpStorage` make at most 3 attempts per request, and each `list` page counts as one request. Previously a call could make 9 attempts, and a throttled `list` page up to 90. Backoff is full jitter, with a 1 s base after a throttle (429 or `SlowDown`) and a 50 ms base after other transient failures, capped at 20 s. A `Retry-After` hint still wins, clamped to 20 s.
  - The `retries` option now defaults to `2` (was `8`) and also bounds `list` 429s. A value that is not a non-negative integer throws `InvalidConfig`. `backoffMs`, when set, replaces both jitter bases.
  - `r2BindingStorage` now retries transient binding failures under the same policy. Previously it made one call.
  - The writer sends each log create once. When the outcome is uncertain, it reads the slot back instead of re-sending. A throttled create still fails with a retriable `NetworkError`, and a create whose fate cannot be resolved still fails with `AmbiguousCommit`. A failing commit now issues at most 3 creates and one readback, down from up to 81 creates.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before: 8 retries by default, any value accepted
  new S3HttpStorage({ ...cfg, retries: 8, backoffMs: 200 });
  // after: default retries is 2 (3 attempts). Pass a non-negative integer or omit it.
  new S3HttpStorage({ ...cfg });
  new S3HttpStorage({ ...cfg, retries: 2 });
  // retries: 1.5, -1, or "3" now throws InvalidConfig
  ```

  Raising `retries` above 2 is allowed but multiplies request cost under throttling; add retry in your own caller instead of in the adapter. `backoffMs`, when set, replaces both jitter bases (the 1 s throttle base and the 50 ms transient base), not a single fixed delay.

- 1264bea: Cache GCS credential providers on first use, reuse credentials until five minutes before expiration, and share concurrent resolution and refresh attempts. Failed attempts propagate to callers and allow a later request to retry. AWS providers also recover from synchronous throws.

  Migration: GCS providers without `expiration` now resolve once for the lifetime of the storage handle. Providers that rotate credentials must return an `expiration: Date` on every result to enable refresh; static credential objects need no changes.

  ```ts
  // Before: relies on resolving the provider for every request.
  credentials: async () => ({ accessKeyId, secretAccessKey });
  // After: refresh five minutes before the credentials expire.
  credentials: async () => ({ accessKeyId, secretAccessKey, expiration });
  ```

- 7e9941c: Fix `LocalFsStorage` (`localFsStorage` on the `/node` barrel, and the `baerlyDev()` Vite plugin) merging keys that differ only by case or Unicode normalization on a folding filesystem such as default macOS APFS.

  Keys were written to the path made of their raw segments, so `A` / `a` and NFC / NFD `é` landed on one file. Because collection names are interpolated raw into key prefixes, `Users` / `users` shared one collection. S3, Minio, and `MemoryStorage` were never affected; Linux filesystems are byte-exact, so this only diverged on macOS dev machines. R2 folds Unicode normalization (not case) the same way; that is addressed by requiring NFC `_id`s.

  Keys are now byte-exact on every filesystem. Each key segment is escaped on disk into a case- and normalization-invariant alphabet (`A` is stored as `%41`, NFC `é` as `%c3%a9`). Lowercase ids, base-32 index values, and `current.json` are stored verbatim. Segments too long for one filename are split into `~`-suffixed directories. Keys containing lone surrogates are now rejected with `InvalidConfig`, and dot-prefixed keys such as `.baerly-tmp-*` are ordinary keys instead of reserved. A stray file that no key can name (an editor backup such as `current.json~`) is skipped by `list`; on a case-folding filesystem, a stray that the filesystem resolves a key to (`README.md` is what `get("readme.md")` reads, and under APFS's full case folding `Straße` is what `get("strasse")` reads) makes `list` fail with `InvalidConfig` naming the file, rather than hide a key the other operations see.

  The data directory now carries a `.baerly-localfs.json` marker. A directory from an older release is adopted as-is only when every name in it, dot-prefixed names included, already reads the same under the new encoding: lowercase ASCII ids and collection, app and tenant names, nothing starting with `.`, and no snapshot. Leftover `.baerly-tmp-*` staging files and `.DS_Store` / `.gitkeep` files are ignored. Otherwise every operation refuses with `InvalidConfig`, listing the affected paths. The two common causes are a folded collection (snapshot files live under `snapshot/L9/`, now stored as `snapshot/%4c9/`) and an uppercase letter in a collection name or id, such as a camelCase name like `boardInvitees`. There is no in-place migration: keys a folding filesystem has already merged cannot be recovered.

  A refused directory is dev data from an older release: move it aside or delete it, and the next write starts a fresh one. For a collection worth keeping, dump it with the older release (`baerly admin dump`) and restore it into the fresh directory (`baerly admin restore`). A dump holds collection rows only; for blobs or other files the app stored through the same `Storage`, re-put them through `Storage` instead: read each with the older release and write it with this release. A raw file copy does not work, because a file whose name holds an uppercase letter or other escaped byte does not read back as the same key under the new encoding, and `list` refuses it. A listed path that is a stray file rather than data can simply be moved out.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```sh
  # before: 0.6.0 reused the data directory in place
  # after: when the directory is refused with InvalidConfig, move it aside
  mv ./data ./data-0.6
  # only for a collection worth keeping: dump with the older release, restore with this one
  baerly admin dump    --bucket=file://$PWD/data-0.6 --app=app --tenant=t --collection=tickets > tickets.ndjson   # 0.6.0 binary
  baerly admin restore --bucket=file://$PWD/data     --app=app --tenant=t --collection=tickets < tickets.ndjson   # this release
  ```

- 70a70b6: Invalid maintenance env values now fail with `BaerlyError{code:"InvalidConfig"}` instead of silently falling back to a default, disabling maintenance, or stalling folds. The error names the variable, the received value, and the accepted values. No value is trimmed.

  - `BAERLY_MAINTENANCE_DISABLE` accepts only the case-insensitive vocabulary unset / `""` / `"0"` / `"false"` (enabled) and `"1"` / `"true"` (disabled).
  - `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` (Node and Cloudflare) must be unset, `""` (both use the active profile default), or a plain positive decimal integer byte count no greater than `Number.MAX_SAFE_INTEGER` (`/^[1-9][0-9]*$/`). Zero, negative values, unit suffixes (`"8mb"`), typos (`"1O24"`), surrounding whitespace (`" 1024 "`), hex (`"0x400"`), exponents (`"1e6"`), fractions (`"1.5"`) and a leading `+` or `0` throw.
  - `BAERLY_MAINTENANCE_PROFILE` (Cloudflare) is a closed, case-sensitive vocabulary: unset, `""`, or `"cf-free"` select `cf-free`; `"cf-paid"` selects `cf-paid`; anything else (`"cf_paid"`, `"CF-PAID"`, `"cf-paid "`) throws. `runScheduledMaintenance` refuses an unknown `tier` the same way, so a `scheduled` callback that forwards the variable fails the same way.

  Where the error surfaces: an API request reaching maintenance dispatch fails — on Cloudflare as a Worker exception (matching the adapter's existing contract for a missing `SHARED_SECRET`), on Node as the JSON `InvalidConfig` response with the canonical error line — and keeps failing until the value is corrected; these values are re-read per request, so no restart is needed. On both hosts `/v1/healthz`, `/v1/spec`, and dev routes stay up for every invalid combination of these variables (Node's configured static short-circuits too), and Cloudflare `scheduled()` still runs the configured callback. This replaces the earlier behavior where a non-positive `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` failed Cloudflare health probes. `baerly inspect` reports a rejected value as a stderr warning.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  | LEFT (before) | RIGHT (now) |
  | --- | --- |
  | `BAERLY_MAINTENANCE_DISABLE=yes` | `BAERLY_MAINTENANCE_DISABLE=true` |
  | `BAERLY_MAINTENANCE_DISABLE=no` | `BAERLY_MAINTENANCE_DISABLE=false` (or unset) |
  | `BAERLY_MAINTENANCE_MAX_FOLD_BYTES=0` (or any negative value) | Unset it, or use a positive value such as `1048576` |
  | `BAERLY_MAINTENANCE_MAX_FOLD_BYTES=8mb` | `BAERLY_MAINTENANCE_MAX_FOLD_BYTES=8388608` (a byte count) or unset |
  | `BAERLY_MAINTENANCE_MAX_FOLD_BYTES=1e6` / `0x100000` / `1048576.0` | `BAERLY_MAINTENANCE_MAX_FOLD_BYTES=1048576` |
  | `BAERLY_MAINTENANCE_MAX_FOLD_BYTES=" 1048576 "` | `BAERLY_MAINTENANCE_MAX_FOLD_BYTES=1048576` (no whitespace) |
  | `BAERLY_MAINTENANCE_PROFILE=CF-PAID` / `cf_paid` / `paid` / `"cf-paid "` | `BAERLY_MAINTENANCE_PROFILE=cf-paid` |
  | `BAERLY_MAINTENANCE_PROFILE=free` (or any other value meant as the default) | Unset it, or `BAERLY_MAINTENANCE_PROFILE=cf-free` |

- c8ce05a: **Breaking:** `bearerJwt` and `cloudflareAccess` now reject a token that has no `exp` claim (RFC 9068 §2.2 makes `exp` required for access tokens). Before, jose checked `exp` only when present, so a token minted without one was accepted forever. Standard IdPs (Auth0, Okta, Azure AD, Keycloak, Cloudflare Access) always set `exp`; a custom token issuer that omits it now gets 401 on every request.

  Both presets also refuse a negative or `NaN` `clockSkewMs` / `jwksCacheTtlMs`, and an infinite `clockSkewMs`, with `InvalidConfig` at construction. Before, a negative skew silently rejected valid tokens and an infinite one disabled the expiry check.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before: a self-minted token without exp was accepted
  const token = await new SignJWT({ tenant: "acme" })
    .setProtectedHeader({ alg: "ES256" })
    .sign(key);
  // after: set an expiry on every token
  const token = await new SignJWT({ tenant: "acme" })
    .setProtectedHeader({ alg: "ES256" })
    .setExpirationTime("15m")
    .sign(key);
  ```

- 703d2dd: **Breaking for raw HTTP callers:** `POST`, `PATCH` and `PUT` now require `Content-Type: application/json` (or a `+json` type such as `application/merge-patch+json`; parameters such as `charset` are allowed). A missing type or any other type, including `text/plain` and `application/x-www-form-urlencoded`, gets `415` with the new `UnsupportedMediaType` error code, before the body is read. Those types make a CORS-simple request, which a page on another origin can send without a preflight, so under ambient auth (`auth: "none"` on localhost or an intranet, or Cloudflare Access cookie sessions) another site could forge inserts. `createBaerlyClient` and the React hooks already send the header, so SDK callers need no change; add `-H "Content-Type: application/json"` to `curl -d` scripts.

- c28a4c1: **Breaking:** `ensureTable` (from `@gusto/baerly-storage/dev`) now takes the collection name under `collection`, matching `db.collection(name)` and the rest of the API. The old `table` key is gone, with no alias: passing `table` is a type error, and at runtime it is refused with `InvalidConfig` (the message names `collection`) before any write.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before
  await ensureTable(storage, { app: "helpdesk", tenant: "demo", table: "tickets" });
  // after
  await ensureTable(storage, { app: "helpdesk", tenant: "demo", collection: "tickets" });
  ```

  The `baerlyDev` Vite plugin's own pre-warm is updated; projects that only use the plugin need no change.

- 40449ca: **Breaking:** `baerly cost --json` reports a monthly object-storage cost band instead of an exact dollar figure. `trajectory.projectedUsdPerMonth` is replaced by `trajectory.projectedUsdBand`: `null` for providers without a dollar model (self-hosted), otherwise one of `"$0"`, `"<$25"`, `"$25-$50"`, `"$50-$100"`, `"$100-$250"`, `"$250-$500"` or `"$500+"`, each including its lower bound. `"$0"` appears only inside a modeled free tier (R2's 1M Class A ops a month is inside it, inclusive); every other priced projection is `"<$25"` or above, however small, including zero writes on a provider with no free tier (AWS S3). Text output prints the band the same way.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before
  const free = result.trajectory.projectedUsdPerMonth === 0;
  const usd = result.trajectory.projectedUsdPerMonth; // number | null
  // after
  const free = result.trajectory.projectedUsdBand === "$0";
  const band = result.trajectory.projectedUsdBand; // "$0" | "<$25" | … | "$500+" | null
  ```

  The projection covers only the selected collection, with zero other account usage and zero stored bytes. The JSON envelope now carries `scope` and `assumptions` (pricing provider, maintenance profile, whether that profile was inferred or set) and `trajectory.profile`. The maintenance profile is a separate input from the provider: `cf-free` for R2 and `node` otherwise, or set it with the new `--profile=cf-free|node`. `gcs://` buckets are now priced as GCS Standard (regional, flat namespace) instead of falling through to self-hosted, and `--provider` accepts `gcs`. With `--provider=gcs`, a new `--region=<location>` flag applies GCS's always-free allowance (5,000 Class A ops and 5 GB-month) only in `us-west1`, `us-central1` and `us-east1`; for any other location the projection drops the allowance and the `$0` band and reports the region in `assumptions.bucketRegion`. Omitting the flag keeps the allowance and discloses the assumption; `--region` on a non-GCS provider is an `InvalidConfig` error. See `docs/about/cost-model.md#cli-cost-bands`.

  `baerly cost` and `baerly admin usage` sample each collection's trailing log by reading `current.json` and probing the live tail, instead of listing the collection's whole `log/` prefix, so per-collection sampling (and therefore `baerly cost`) no longer grows with retained history. `baerly admin usage` still discovers collections by listing every key under the tenant's `manifests/` prefix, so its discovery LIST pages still grow with retained objects.

- 6915922: **Breaking:** `engines.node` is now `>=26` (was `>=24`) for `@gusto/baerly-storage`, `@gusto/create-baerly-storage`, and the apps it scaffolds; older Node gets an engine warning from your package manager (or a refusal with `engine-strict`). Node 26 is the current LTS and ships `Uint8Array.{toBase64,fromBase64}` unflagged, so no runtime flag is needed. Scaffolded apps declare `packageManager: pnpm@12.22.0` and enable pnpm's supply-chain guardrails (`minimumReleaseAge`, `trustPolicy: no-downgrade`, `blockExoticSubdeps`) in `pnpm-workspace.yaml`. The Docker add-on builds on `node:26-trixie-slim` and runs on `gcr.io/distroless/nodejs26-debian13`.

### Minor Changes

- 826b2a1: Every request now runs under a storage request budget, and a storage call past it is refused before it is sent with `CapacityExceeded` (HTTP 409, not retriable) instead of failing on the host's own limit. The budget counts every attempt, retries and `list` pages included, and covers the write-tick maintenance a request dispatches through `ctx.waitUntil`.

  On Cloudflare the budget follows `BAERLY_MAINTENANCE_PROFILE`: `cf-free` (the default) allows 900 storage calls per invocation, of which at most 45 may leave through `fetch` (S3 over HTTP, GCS); `cf-paid` allows 9,000. R2 binding calls count toward the 900 only. A cron invocation gets its own budget. Node counts calls and never refuses one.

  No app code changes. A multi-row write refused part-way keeps the rows it already committed; re-read before retrying it.

- 7c46c33: A read that cannot fit in one request is now refused whole with `CapacityExceeded` (HTTP 409, not retriable unchanged) instead of failing part-way or on the host's own limit. When `current.json` alone shows the read needs more storage calls than the request has left, it is refused before loading the snapshot; a forward probe past `tail_hint` that runs out of request budget is refused the same way. A read never returns a truncated row set and never triggers maintenance.

  No app code changes. Reads that fit return exactly what they did before.

- f501fdc: A write that leaves its collection within 90% of the host's growth-refusal point now carries an early warning, so apps can shed rows before the first `CapacityExceeded`. Over HTTP the success response gains a `Baerly-Capacity-Warning` header (the body is unchanged), and the same text is the `capacity_warning` field on the request's canonical log line. The text names the state and the app-side remedy (delete rows, shrink documents, export with `baerly admin dump`), never a host setting.

  The warning is computed per request from `current.json` and the pending tail, and nothing is persisted: it disappears as soon as a delete, a shrinking update or a larger host brings the collection back under the threshold.

- d116ebd: `createBaerlyClient` gains an optional `onWarning` callback that surfaces the `Baerly-Capacity-Warning` response header, so an app using the HTTP client learns its collection is near the host's capacity before writes start failing with `CapacityExceeded`. No per-verb return type changes: each warned write still resolves its usual result, and the callback receives `{ code: "CapacityWarning", message, method, path }`, where `message` is the server's warning text. A callback that throws or rejects cannot fail the request. Without `onWarning` the header is ignored, as before.

  ```ts
  const client = createBaerlyClient({
    baseUrl: "https://api.example.com",
    onWarning: (w) => console.warn(`${w.method} ${w.path}: ${w.message}`),
  });
  ```

  Cross-origin browser apps also need their CORS layer to list `Baerly-Capacity-Warning` in `Access-Control-Expose-Headers`.

- f5bbd21: The canonical log line's `outcome` gains a `refused` value for capacity refusals (`CapacityExceeded`, `MaintenancePending`), logged at `warn`. A `CapacityExceeded` 409 no longer counts as `conflict`, and a `MaintenancePending` 503 no longer counts as `error` or logs at error level. Alert on `outcome:"refused"` to see collections at their host's fold ceiling.

- 458dfe6: A Cloudflare Worker on the free profile (`BAERLY_MAINTENANCE_PROFILE` unset or `cf-free`) whose storage is not the R2 binding (for example `S3HttpStorage`) now folds a collection's log once 7 writes are pending, instead of waiting for the pending log to grow as large as the snapshot. Every storage call there is charged to the free profile's 45-call `fetch` budget, and a write or read replays the pending log, so with the old trigger the tail outgrew what a request could afford and the fold never fit. With the early fold, a write plus the fold it triggers, and a read of the longest tail it leaves, stay within 45 calls, GC slice included (30 at most; the Worker makes no Cache API calls). The storage is detected from the storage the Worker is given, so no configuration is needed; the R2 binding, `BAERLY_MAINTENANCE_PROFILE=cf-paid`, and Node keep the existing trigger. There a GC slice also deletes at most 3 replaced snapshots instead of 10, which still outpaces the one snapshot each fold replaces.

  A Worker cannot tell Free from Paid, so the free profile caps storage over `fetch` at 45 calls per request: past it a request gets a typed `CapacityExceeded` instead of the platform throwing at Free's 51st subrequest, and the early fold keeps ordinary writes and reads inside the cap. Workers Free with S3 over HTTP is not a supported host; a Paid Worker on S3 sets `BAERLY_MAINTENANCE_PROFILE=cf-paid` to leave the cap. Under the free profile on storage over `fetch`, folding every ~7 writes means GC, which reclaims about 1,000 replaced snapshots per collection per 7-day grace period, keeps pace at about 900 writes per day per collection (bursts are fine); at that rate a collection keeps ~900 replaced snapshots, at most ~450 MiB for 512 KiB snapshots, and above it replaced snapshots accumulate.

- 5b24985: Give each host profile its own snapshot fold ceiling.

  All three maintenance profiles shared `C = 512 KiB` (`maxFoldBytes`) and `E = 2048` (`maxFoldRows`), both calibrated for a Cloudflare free isolate's ~10 ms CPU budget. Serverful Node and Cloudflare paid inherited them. Because the fold gate was `snapshot_rows + maxFoldEntriesPerPass <= E`, and those two profiles fold a 200-entry slice against free's 20, the bigger host capped _lower_: ~1,848 live documents against free's ~2,028.

  Each profile now carries a ceiling measured against its own wall:

  | Profile | `C`     | `E`    | Documents at 1-5 KB/doc |
  | ------- | ------- | ------ | ----------------------- |
  | cf-free | 512 KiB | 2,048  | ~100-500 (unchanged)    |
  | cf-paid | 8 MiB   | 32,768 | ~1,600-8,200            |
  | node    | 32 MiB  | 65,536 | ~6,500-32,800           |

  **Behaviour change.** A collection on serverful Node or Cloudflare paid that was deferring its fold against the old shared ceiling starts folding again on the next write tick, and its log tail begins collapsing into the snapshot again. Nothing else moves: a read already folded snapshot plus live tail, so the materialized view is unchanged either way, and the per-pass rate caps are untouched.

  Cloudflare paid takes its ceiling only when `BAERLY_MAINTENANCE_PROFILE=cf-paid` is set — a paid Worker runs the free-tier profile by default. The Node adapter selects its profile automatically. `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` still overrides `C` on any host; there is still no override for `E`, so a row-arm defer is cleared by moving to a larger host profile rather than by configuration.

  Bytes now bind before rows on every host for documents of ~512 B and up, so `E` acts as the tiny-document backstop it was designed to be rather than as the effective ceiling.

  The Cloudflare adapter's init-time over-raised-ceiling warning is now scoped to the free profile. It reports free's ~10 ms CPU wall and its first stated remedy is "run on CF PAID" — an operator on `BAERLY_MAINTENANCE_PROFILE=cf-paid` has already taken that remedy, and the paid profile's own ceiling is 8x the bound being warned about.

- 7a761c3: In-band compaction now folds the longest prefix of its pass that stays within the host's ceilings, sized entry by entry, instead of deferring the whole pass. Previously a fold deferred whenever `snapshot_rows + maxFoldEntriesPerPass > E`, or whenever the pass as a whole would rebuild past `C`, so a collection within one pass of a ceiling stopped compacting even when its tail was only updates or deletes; the tail then grew without bound and every read paid one GET per entry.

  - **Rows.** A fold counts real rows against `E` instead of assuming every log entry adds one, and stops before the first entry that would add a row past `E`. Updates and deletes fold a full pass right up to `E`, and a delete-only tail drains in place at `E`.
  - **Bytes.** A fold applies the longest prefix whose rebuilt snapshot stays within `C`. A byte-heavy pending change no longer pins the changes before it: they fold, and the next pass starts at the heavy change, so a delete or shrinking update behind it can fold with it and the collection recovers on the same host.

  The `CapacityExceeded` "no fold can make progress" state for bytes is decided from the pending log alone, not from where fold passes fall: it applies when a fold pass's worth of pending changes in a row each leave the snapshot past `C`. A write that would complete such a run is refused too, since it could never fold on that host; a write that brings the collection back within `C` still commits. Reads keep working in every case, and nothing new is configured.

- f5fd97b: A collection whose snapshot cannot fold on its host profile (past `C` bytes, or a row-adding entry at `E` rows) now says so loudly. While a fold defers, `log_seq_start` and log retention freeze and the live tail grows; writes that would grow the collection further are refused with `CapacityExceeded` (see that entry of this release). Previously the only signals were an unlabeled counter that never reached the canonical line on Cloudflare and a `console.warn` that recommended `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` even when rows had tripped, where it does nothing.

  - **Structured warning.** Each deferral emits a `fold_deferred` LogTape record at `warning` on the new `["baerly", "maintenance"]` category, with fields `collection`, `dimension` (`bytes` / `rows`), `gate` (`pre-fold` / `rebuild`), `snapshot_bytes`, `snapshot_rows`, `ceiling_bytes`, `ceiling_rows`, `live_log_tail`, and `log_seq_start`. On Cloudflare this record is the signal, since the fold runs in `ctx.waitUntil` after the canonical line is written. The record's `detail` field carries the human line, which names both ceilings, the tripped arm, that retention is paused, and the remedy for that arm. With no `warn` sink bound (a bare `Db.create()`), or one that throws, that line is written as a `console.warn` instead, so an adapter logs one line per deferral, not two, and a throwing sink never skips the rest of the tick. It fires on a collection's first deferral and then at most once per 1,000 writes.
  - **Metrics.** `db.compaction.deferred_total` gains a `gate` label, and the new `db.compaction.deferred_bytes_total` / `db.compaction.deferred_rows_total` carry the dimension onto the canonical line, which drops labels. A deferral is counted once per deferral.
  - **Rebuild-gate deferrals.** When the stored snapshot is under `C` but the rebuilt one is over it (the usual way bytes first cross `C`), the write tick now signals and refreshes `tail_hint` like any other deferral, instead of ending silently.
  - **`baerly inspect`** reports `fold_gate` per host profile (`cf-free`, `cf-paid`, `node`): `open`, `closed:bytes`, or `closed:rows` (once stored `snapshot_rows > E`), with the profile's `C` and `E` and a `retention_stalled` flag. `--profile=<name>` narrows it to one host, and `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` from the CLI's environment overrides `C`. It also reports `maintenance` (`enabled`, `disabled`, or `invalid-config`) from `BAERLY_MAINTENANCE_DISABLE`. A maintenance env value the adapters would reject is a stderr warning rather than a failure, so the exit code stays 0.

  Both shipped adapters (`baerlyWorker`, `baerlyNode`) bind the structured `warn` sink; the dispatch types are not published.

- 86a5835: Auto-ID inserts over HTTP are now safe to resend. The HTTP client mints an auto-ID insert's `_id` (a UUIDv7, timestamped by the client's clock) before sending it, and sends it in both `doc._id` and a new optional `mintedId` field of `POST /v1/c/:collection`. If a live row with that `_id` already holds exactly the same document, the insert returns the original `201 { _id }` instead of `409 AlreadyExists`, and commits nothing. Key order does not matter; any other difference in the body is still a `409`. Replay compares the current live row: deletion permits reinsertion, an update to a different body yields `AlreadyExists`, and updating back to the original body permits replay. Calling `insert(doc)` again is a new operation and mints a new auto-ID. Caller-supplied `_id`s are sent unchanged, without `mintedId`. When the client resends an insert itself is described in the client retry entry of this release.

  `mintedId` must be a canonical UUIDv7 equal to `doc._id`; anything else is `400 SchemaError`. An insert without `mintedId` keeps strict `409 AlreadyExists` on any live row, even an identical one, so a caller-chosen `_id` used as a run-once guard still has at most one winner. In-process `Collection.insert` is unchanged. A server without this change ignores `mintedId` and answers a resend `409`, never with a duplicate row.

  ```sh
  curl -X POST "$BASE/v1/c/tickets" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"doc":{"_id":"0195f1c2-7a3b-7c4d-8e5f-0123456789ab","title":"hi"},"mintedId":"0195f1c2-7a3b-7c4d-8e5f-0123456789ab"}'
  # first send, or identical resend while the current live row matches: 201 {"_id":"0195f1c2-7a3b-7c4d-8e5f-0123456789ab"}
  ```

- f2b0986: The HTTP client now retries requests that are safe to resend, with up to 3 attempts per request in total, jittered backoff, and `Retry-After` honoured up to 10 s (a longer hint is not waited on; the error surfaces at once). The final failure is thrown unchanged, an abort stops at once, and `retry: false` on a request turns every retry off.

  - **`MaintenancePending` (HTTP 503), on every verb.** The server refuses with this code only before the write commits, and each client write is one row, so the identical request is resent, waiting the server's `Retry-After` (or `retryAfter`, whichever is longer) each time. `BaerlyError.retryAfter` on a client-side `MaintenancePending` is the longer of the two.
  - **`GET`, after a thrown `fetch` or an envelope-less 5xx, 408 or 429** from a proxy or CDN in front of the server.
  - **Auto-ID `insert`, after the same transport failures.** The resend carries the same minted `_id`, so an insert that had already committed replays as `201 { _id }` instead of adding a second row.

  An error the server itself returned is never retried, apart from `MaintenancePending`; enveloped `NetworkError` is never retried. An insert with a caller-chosen `_id`, `update`, `replace` and `delete` are still sent once after a transport failure.

  The React subscription poll now waits at least `retryAfter` (capped at 10 s) before re-polling after `MaintenancePending`, and a `CapacityExceeded` poll error parks the table like any other non-retriable error until `refetch`.

- d3d70e6: Add `useQuery(callback, deps, { live: false })` for typed React reads that run initially and when dependencies change without opening a `/v1/since` subscription. Every `UseQueryResult` state now includes a stable `refetch()` function; calling it refreshes the current query and preserves the previous successful data while refreshing or on error.

  Live queries now stop and surface non-retriable `/v1/since` failures, including `Unauthorized`, instead of retrying forever behind stale data. Retriable transport failures use bounded exponential backoff with jitter, and a `CursorExpired` cursor re-bootstraps automatically (see the `CursorExpired` entry of this release). `refetch()` on any query sharing a stopped subscription clears the error on all of them, not just the caller.

  An HTTP error response carrying no `baerly` error envelope — what a load balancer, CDN, or service mesh returns when it answers for the server — is now classified from its status: 5xx becomes a retriable `NetworkError` rather than a terminal `Internal`. A transient gateway 502 during a rolling deploy therefore backs off and recovers instead of stopping every live query until remount.

- c193b84: `update` patches are typed `MergePatch<T>` instead of `Partial<T>`, on `Collection.update(id, patch)`, `Query.update(patch)` and the HTTP client's `ClientCollection.update`, so the type matches the RFC 7396 runtime: `null` on an optional field type-checks and deletes it, and a required nested object with a single object type takes a nested patch. `null` on a required field is a compile error; remove a required field with `replace`. An optional object member takes its whole value or `null`, never a nested patch: to change part of an optional object, pass the whole object or use `replace`. Union-valued members take a whole value because the stored value may belong to another variant. Whole objects still merge with existing fields; use `replace` to discard fields. Arrays and scalars are still replaced whole. On an unconfigured collection every field accepts `null`. `MergePatch` is exported (type only) from `@gusto/baerly-storage` and `@gusto/baerly-storage/client`.

  Types only: no runtime or wire change. A `null as never` cast on a patch member is no longer needed, but a generic helper that types its patch as `Partial<T>` no longer type-checks against `update`: type it as `MergePatch<T>`. The `/v1/spec` method table carries the new `update` signatures; `specVersion` stays `"1"`, since only a TypeScript type string changed and no request, response or route did.

- 6cc5920: Every collection read now reports its work on the request's canonical log line, on every host: `db.read.decoded_entries_total` (snapshot rows plus log entries decoded, before predicate and limit — entries, not documents, so updates and deletes count once each), `db.read.live_documents_total` (distinct documents live after the fold) and `db.read.returned_rows_total` (rows left after predicate, order and limit). A point read or a `limit(1)` read still folds the whole collection, so a large decoded count beside one returned row is that read's real cost. Write verbs' pre-commit reads report the same counters.

  The counters come from counts the read already holds: no extra storage calls, no change to query results, and no new threshold, warning or read cap.

- de50b04: `baerly doctor --bucket` now also checks that the bucket's LIST returns keys exactly as written. It puts two throwaway objects whose keys hold `%` (including `%2F`, `%25`, and a bare `%`), spaces, `+`, `&<>"'`, and a non-ASCII letter under a fresh `__baerly_list_probe__/` prefix, lists them, and compares the listed keys byte-for-byte. A mismatch is an error (exit 2) naming the likely cause — keys left URL-encoded, decoded twice (the backend ignores `encoding-type=url`), or decoded wrongly — because app, tenant, and collection names may hold those characters. The probe makes six storage calls, deletes its objects even when a step fails, and reports a sentinel it could not delete as a warning naming the key.

- 5a1c238: `baerly admin fsck` now flags an app, tenant, or collection name with an unpaired UTF-16 surrogate (check `names`), and snapshot `_id`s with one (check `ids`), as `warning` findings that exit 4, next to the existing non-NFC name check. 0.7 refuses such names and `_id`s as write targets, so run `fsck` before upgrading to find legacy data that needs migrating. `fsck` does not decode the log, so for `_id`s committed since the last fold use `baerly admin dump --json`, whose `legacy.ill_formed_ids` covers every live row.

- 0fb8a2b: `baerlyNode().listen(port, { hostname })` binds a single address, for example `"127.0.0.1"` to accept loopback connections only. Without `hostname`, `listen(port)` still binds every interface. The new `BaerlyNodeListenOptions` type is exported from `@gusto/baerly-storage/node`. `listen()` now binds the HTTP server once (it previously bound `0.0.0.0:0` and then re-listened on `port`, which worked only because the second call won a race), `close()` waits for a pending bind so the listener cannot remain open after shutdown, and `listen()` after `close()` rejects with `InvalidConfig` instead of binding a server that nothing would ever close.

### Patch Changes

- ff6a8ea: `cloudflareAccess` now replaces an `Authorization` header the app sent itself with the Cloudflare Access token, instead of appending to it. Before, an app that also sent `Authorization` got a 401 for a valid Access session.

  `cloudflareAccess` refuses a `teamDomain` that is not a bare team name (lowercase letters, digits and `-`, such as `acme`) with `InvalidConfig` at construction, so a stray `/`, `@`, `.` or `:` can't point the JWKS fetch at another host. A full host such as `acme.cloudflareaccess.com` never verified a token, and now fails at startup instead. The `baerly` CLI config loader and `baerly doctor` apply the same rule to `cloudflareAccess.teamDomain`.

  On Node, the `auth: "none"` startup line is logged with `console.warn` when the process looks deployed (`NODE_ENV=production` or a known PaaS marker), and says that every request gets full access to the configured tenant. Nothing is refused; local runs and Workers keep the info line.

  The `bearerJwt` and `cloudflareAccess` docs now say `tenantClaim` must name a claim only an IdP admin can set.

- c6eb9ce: Storage adapters (S3, GCS, the R2 binding) no longer resend an `If-Match` PUT. When a compare-and-swap landed but its reply was lost or came back as a 5xx, the resend met its own write as a 412 and reported a false `WriteConflict`, so a fold that had published reported `cas-lost`. A failed compare-and-swap now surfaces its first error to the caller, and every in-tree caller (the compactor, the `tail_hint` refresh, log retirement's floor, the GC pending ledger) skips and re-reads on its next pass. Every other request keeps the 3-attempt retry policy.

- 05a0de2: A Cloudflare Worker now answers a throw around the router, such as `Db.create` refusing an invalid tenant, with the JSON error envelope and the mapped status, and flushes one canonical line with that status, as the Node adapter does. Before, the throw was recorded as a 500 and rethrown, so workerd answered with its own error page, which the client SDK cannot parse. A throw while resolving the Worker's config, such as a missing `SHARED_SECRET`, likewise answers with a 500 `Internal` envelope that omits the setting name, and the full error is still written to the Worker's console log for the operator.

- 8f7e4f8: `baerly --version` and `create-baerly-storage --version` print the package version instead of `0.0.0`.

- df52c3f: A `useQuery` fetch is now cancelled when its query is superseded (its dependencies change) or unmounted: the in-flight GET and any retry wait, transport or `MaintenancePending`, stop at once instead of running on in the background. A fetch shared by several components is cancelled only when the last one detaches, and a cancelled fetch never surfaces as an error.

- 6c58bef: The docs now name a support tier for each Cloudflare host. Workers Paid, with S3 or R2, is the first guaranteed tier. Workers Free with the R2 binding is the supported floor, with best-effort CPU. Workers Free with `S3HttpStorage` is not supported, because every storage call there is a `fetch` and counts against the free plan's 50 subrequests per request; R2 binding calls don't. S3 storage on Workers needs Paid with `BAERLY_MAINTENANCE_PROFILE=cf-paid`; a Paid Worker that has not set it keeps the free profile's 45-call `fetch` budget.

  The R2 binding buys request headroom (tail length, retries), not a bigger collection. See `docs/spec/scale-ceilings.md` § Host support tiers. No runtime behavior changes.

- 6e4625a: A write now keeps enough of its request's storage budget to resolve its own commit. Before its commit, and again before each retry at a new log slot after losing a race, it checks that the budget still covers the commit and the calls that confirm it (9 storage calls), and holds that much so that other work in the same request, such as write-tick maintenance running in `ctx.waitUntil`, cannot spend it; if the budget is short, it fails with `CapacityExceeded` (not retriable unchanged) and nothing is written. Previously a write could commit with no budget left to confirm it and fail with `AmbiguousCommit`, and a commit the budget refused before sending was also reported as `AmbiguousCommit` although nothing had been sent; it is now `CapacityExceeded`.

  A multi-row `.where(...).update()` / `.delete()` that runs out of budget part-way keeps the rows it committed and commits nothing after the refused row; re-running it on a fresh request is safe.

- 03f082a: The fold-ceiling warnings (the deferred-fold warning and the Cloudflare `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` init warning) and the related `BaerlyEnv` docs now describe the configured ceilings as conservative budgets: a larger fold may exceed an invocation's CPU or memory resources, rather than being asserted to be CPU-killed. Ceilings and behavior are unchanged.

- 7851316: Update the bundled runtime dependencies: `hono` to 4.13.19, `@hono/node-server` to 2.1.8, `jose` to 6.2.17, `@rgrove/parse-xml` to 5.2.0, `@logtape/logtape` to 2.4.2, and the scaffolder's `@clack/prompts` to 1.9.0. No public API changes.

  The `s3.js` and `gcs.js` closures grew about 3.7 KB raw (about 380 B min-gz) from `@rgrove/parse-xml`; `http.js`, `cloudflare.js` and `observability.js` grew about 34 KB raw (about 3 KB min-gz) each from `@logtape/logtape`.

- 55540d4: `baerly deploy --target=cloudflare` no longer probes `wrangler deploy --help` for the experimental `--x-provision` flag or prints "wrangler --x-provision unavailable". It always creates any missing declared R2 bucket with `wrangler r2 bucket create`, then runs a plain `wrangler deploy`; Wrangler 4.45+ provisions declared buckets on deploy itself. The Cloudflare scaffolds now set the `enable_request_signal` compatibility flag so `GET /v1/since` sees client disconnects and settles the long-poll, matching the Node adapter. The flag becomes the default at `compatibility_date` 2026-11-17, so drop it when you move the date past that.

- 2f63c7e: Fix the `create-baerly-storage --with=docker` add-on's container failing to start. Distroless images keep `node` at `/nodejs/bin/node`, off `PATH`, so the template's `ENTRYPOINT ["node", …]` and `HEALTHCHECK ["node", …]` could not exec. The Dockerfile now passes the server entry as `CMD` to the image's own node entrypoint and names node absolutely in the healthcheck.

- 73e5089: Error-contract text fixes:

  - A read refused with `CapacityExceeded` now carries the remedy for the bound it hit as `resolution` (narrow the predicate or add a limit; delete or shrink rows; or retry once maintenance has absorbed pending writes), instead of the write remedy. The code, status, and `cause.bound` are unchanged.
  - `CapacityExceeded`'s JSDoc, its `/v1/spec` summary, and the API.md table describe read refusals as well as write refusals. The `/v1/spec` IR lists `CapacityExceeded` under the read verbs (`get`, `first`, `all`, `count`).
  - The `AlreadyExists` resolution now says that after an insert that omitted `_id` (the client resends it under its minted `_id`) the row may be that insert's own first attempt: re-read it, and do not insert again without an `_id`, which mints a second row.

- b90fec4: Fence GC deletion candidates to the collection generation that marked them, re-check `stale-log` candidates at sweep time, and clear the GC ledger on `baerly admin restore`.

  Before, a candidate was a bare key, so a decision made against one view of the bucket could run up to seven days later against another. After `baerly admin restore --force` re-created a log object an earlier pass had already marked, GC could delete it, leaving a hole in the live log that made every read and fold of the collection fail with `Internal`.

  - Each candidate now records the `current.json` generation it was marked under. A pass drops (never deletes) a candidate whose generation no longer matches, or a `stale-log` candidate that is live again. This adds no storage calls.
  - `baerly admin restore` deletes `gc/pending.json` before its first commit, so a reseeded collection does not inherit the old ledger.
  - A GC pass that finds `gc/pending.json` deleted under it reports a retriable `WriteConflict` rather than `InvalidResponse`, so a restore no longer makes a concurrent maintenance pass fail with a corrupt-data code.
  - New metric `db.gc.dropped_total`, labelled by cause (`stale-generation`, `still-live`), counts candidates resolved without a DELETE. A sustained `still-live` rate means marking is misjudging liveness.

  A pass already in flight when a restore lands still holds the old manifest, so a window of one pass remains; run a restore that matters without a maintenance pass racing it.

  **On upgrade.** No migration or configuration. `generation` is optional, so `GC_PENDING_SCHEMA_VERSION` stays 1. Expect one `stale-generation` drop spike on the first pass after upgrading: each older candidate is dropped and, if still orphaned, marked again, which delays its reclamation by one grace period. Each `baerly admin restore` causes another, self-healing spike.

- 560175e: Give GC's grace period its full length on every storage backend. On S3, GCS and R2 it was effectively `max(0, grace − object age)`, so a candidate older than the seven-day default was marked already due and deleted on the next pass, with no window for a retrying writer. Only `MemoryStorage` and `LocalFsStorage` got the full grace.

  GC now anchors a candidate's due time on when it was marked (`now() + grace`) and no longer reads the listed object's `lastModified` (which this release removes from `StorageListEntry`). This is strictly more conservative on every backend, so nothing is deleted sooner than before.

  Not retroactive: candidates already recorded in `gc/pending.json` keep the due time they were marked with, so the first pass after upgrading still sweeps that backlog on the old horizon.

- 14c8268: Reclaim replaced snapshots at the rate folds create them, so bucket storage stops growing on a busy collection.

  GC's mark pass only looked at the oldest `maxMarks` snapshot keys (20 per pass on Cloudflare, 200 on Node). Snapshots that were already marked sat in that window for their full 7-day grace, so newer replaced snapshots went unmarked until the older ones were deleted. Each collection could reclaim only about `maxMarks` snapshots per week. Any collection that folded faster than that kept every extra replaced snapshot, and on Cloudflare Free each one can be up to 512 KiB.

  The mark pass now skips past snapshots that are already pending and marks up to `maxMarks` new ones each pass. The scan still fits one LIST page (one request unless the provider truncates the page short). At steady state a collection keeps about one week of replaced snapshots (fold rate × grace period). The grace period, sweep budget, and deletion checks are unchanged.

  The GC ledger still holds at most 1000 pending snapshots, so one collection reclaims at most about 1000 replaced snapshots per 7-day grace, roughly 143 folds a day. A collection that folds faster than that still accumulates the excess until the ledger has room.

- 9079e4f: A GC pass now stops deleting once it has run longer than a tenth of the GC grace (about 16.8 hours against the 7-day default) since the `current.json` read its deletions rest on. Before each batch of DELETEs the pass compares the elapsed time against that bound; past it, the remaining due candidates stay in `gc/pending.json` for a later pass, which reads the manifest again. A pass on any supported host lasts seconds, so this only affects a process that was paused or starved mid-pass, which could previously delete against liveness it had read arbitrarily long before. No configuration, no lease, and no change in storage requests.

- 27f369d: GC proves an orphan snapshot is obsolete before deleting it.

  A due `orphan-snapshot` candidate is now checked against a freshly read `current.json`: a candidate the fresh pointer names is rescued, and every other one must prove its `max_seq` is strictly below the observed `log_seq_start` before it is deleted. Previously a compactor that published a snapshot between GC's classification and its DELETE could have that live snapshot removed. Snapshot keys GC cannot parse — unknown levels, non-canonical names, inverted ranges — are left untouched and resolved out of the bounded candidate ledger rather than being swept. This is on the default path: it applies on every host, not only under a bounded maintenance profile.

- fb9d0da: HTTP `count()` now honors `limit`, as the server SDK's `count()` does: `client.collection("tickets").limit(3).count()` returns at most 3 instead of the full count. `GET /v1/count` accepts `&limit=<n>` and validates it as the list route (`GET /v1/c/:collection`) does, so a `limit` that is not a non-negative integer is a `SchemaError` (400).

- 1411e33: `baerly inspect --json` is documented as a storage-format diagnostic, not a stable contract. Its fields (`tail_hint`, `snapshot_bytes`, `fold_gate`, `writer_fence`, …) follow the storage format, and any release can rename, reshape, or drop them. Don't build automation on them. `baerly inspect --help` says the same.

- 54228cf: Fix `LocalFsStorage.put` failing with `EXDEV` whenever the bucket root and `os.tmpdir()` are on different filesystems.

  The write path that serves unconditional and `ifMatch` puts staged its temp file in `os.tmpdir()` and then `rename`d it onto the destination under the bucket root. `rename(2)` refuses to cross filesystems, so on any host where those are separate volumes _every_ such put failed with `BaerlyError{code:"InvalidResponse"}` wrapping `EXDEV`, with no fallback.

  That is the ordinary self-hosted shape, not an exotic one. The default root is `<cwd>/.baerly-data`, which in a container is a mounted data volume while `/tmp` is a tmpfs or the image layer, and the same split is routine on systemd hosts (`/tmp` on tmpfs), for `$BAERLY_DATA_DIR` pointed at a network mount, and for `baerly export` / `admin restore` against a `file:///…` URI on another disk. It made the documented zero-credential path — `baerlyNode({ config, storage: localFsStorage() })`, from that factory's own `@example` — dead on arrival there.

  Both write paths now stage a `.baerly-tmp-*` temp file as a sibling of the destination, which is what the `ifNoneMatch:"*"` branch already did (its `link(2)` create has the same cross-device constraint). `list` skips dot-prefixed names and no encoded key starts with `.`, so a crash between staging and publishing leaves a file invisible to `list` rather than a bogus key. A temp stranded by a hard crash stays inside the bucket directory, where nothing reclaims it; remove it with `find . -name '.baerly-tmp-*' -delete`. Non-crash failures are cleaned up in a `try/finally`, so a failed write no longer strands the partial body.

  A temp-write failure also now surfaces as `BaerlyError{code:"InvalidResponse"}` like every other error from this adapter; previously the `writeFile` sat outside the `try` and escaped as a raw Node `ErrnoException`.

- 6832730: Fix `LocalFsStorage` admitting multiple winners for a concurrent `ifMatch` CAS on the same base etag. Concurrent callers could all read the same etag, all pass the comparison and all publish, so every update but the last was silently lost; 16 racers produced 16 winners and no `WriteConflict`.

  `LocalFsStorage` now serializes every mutation of a key (`ifMatch`, unconditional, create-if-absent and `delete`) behind one in-process lock per key, shared by every instance over the same directory and keyed on the canonical file path, so case variants and symlinked roots (`/tmp` and `/private/tmp`) share it too. The guarantee is single-process: within a process, concurrent CAS on a key admits exactly one winner across any number of instances; across processes nothing is guaranteed, which is why horizontally scaled deploys need S3 or R2.

  A key deleted while `list()` walks it is now skipped, instead of escaping as a raw Node `ENOENT` rather than a `BaerlyError` (reachable whenever GC deletes while the compactor lists).

- ed795b8: `GET /v1/since` reports a cursor whose seq token is not canonical, or decodes outside the safe-integer range, as `SchemaError` ("invalid shape") instead of a misleading "folded into a snapshot" error. A stored log entry whose body is valid JSON but not an object (`null`, a number, a string, an array) is now rejected with `InvalidResponse` when read, instead of crashing the fold with a raw `TypeError`.

- edbc84a: An unreadable `schema_version` in `current.json`, a snapshot, or `gc/pending.json` now reports the found and supported versions; a version written by a newer release says to run that release or newer, and the message no longer suggests recreating a bucket.

- 7edf452: `baerlyNode({ webRoot })` now serves files through `@hono/node-server/serve-static` and refuses two things the old server allowed: a symlink inside `webRoot` that resolves outside it, and any dotfile or dot-directory (`/.env`, `/.git/config`) other than `/.well-known/*`. Both return the 404 envelope. An HTML navigation to an escaping symlink is treated as a miss and gets `index.html`; a dotfile request gets the 404 even for an HTML navigation. The same symlink containment applies to the SPA fallback shell.

  Other differences from the previous static server:

  - Responses carry `Last-Modified`, and a `Range` request gets `206 Partial Content` (or `416` when unsatisfiable).
  - Percent-encoded names still work (`/my%20file.txt`, `/caf%C3%A9.txt`), but a path holding an encoded reserved character (`%2F`, `%3F`, `%23`) or a literal `%` (`%25`, so `/100%25.txt`) returns 404. Rename such files; Vite's hashed output never contains them.
  - MIME types follow Hono's table: `.json` and `.map` lose the `; charset=utf-8` suffix, `.svg` gains it, and more extensions are recognized.
  - A request for a directory without a trailing slash (`/docs`) serves that directory's `index.html`.
  - A `webRoot` that does not exist is logged with `console.error` when the server is built.

- 7950d1f: Published types no longer reference a test-only package. Every entry's `.d.ts` reached a shared chunk carrying `import "@fast-check/vitest";`, so a consumer type-checking with `skipLibCheck: false` on TypeScript 7 got `TS2882: Cannot find module or type declarations for side-effect import of '@fast-check/vitest'`. The `Verifier` JSDoc example now imports from `@gusto/baerly-storage` instead of the nonexistent `baerly-storage`.

- 197f3a3: On the Cloudflare R2 binding, R2's same-key rate limit (error `10058`, one write per second per key) is now retried as a throttle, with the longer throttle backoff, rather than as a transient failure. A throttled commit reads its log slot back: when a concurrent writer took the slot, the commit moves on to the next slot; an own entry is adopted. R2 does not document that error `10058` proves an unapplied write, so an empty or unreadable slot remains `AmbiguousCommit`, including when a later retry was definitively rejected.

  The Workers per-invocation call limit on the R2 binding ("Too many API requests by single Worker invocation", after 1,000 calls on Free) is no longer retried, since every later call in the same invocation is refused too. When no earlier attempt has an uncertain outcome, a commit refused this way fails with a retriable `NetworkError` when its slot is empty or its readback fails, since no attempt applied or can still apply.

- a9ee788: Lower CPU and memory per request. Results, signatures and auth behavior are unchanged.

  - `order(...).limit(k)` with `k` up to 64 selects the top `k` rows without sorting every matching row.
  - Filtered reads and `count()` evaluate the predicate in one pass per query.
  - S3 requests signed by `sigV4Signer` or the S3, R2 and Minio storage factories no longer copy the request body to sign it, so a large PUT no longer holds a second copy of its body.
  - `goog4Signer` and `gcsStorage` reuse the derived signing key for the same secret and UTC day.
  - `cloudflareAccess` verifies the `Cf-Access-Jwt-Assertion` token without rebuilding the request.
  - Snapshot hashing no longer copies the snapshot bytes.

- 0adc8fa: Three small hardening changes on the Node and Cloudflare hosts:

  - An inbound `x-request-id` is used as the log line's `request_id` only when it is at most 128 characters of letters, digits and `_ . : / + = @ -`. Anything else (whitespace, quotes, control or non-ASCII characters, or a longer value) is replaced with a generated id, so a caller cannot forge or bloat log lines through the header.
  - Every response from `baerlyNode` and `baerlyWorker`, including static assets served from `webRoot`, carries `X-Content-Type-Options: nosniff`.
  - `fromEksPodIdentity()` (and `fromEks()` on its Pod Identity branch) throws `InvalidConfig` when `AWS_CONTAINER_CREDENTIALS_FULL_URI` is not an http(s) URL on loopback, `169.254.170.2`, `169.254.170.23` or `[fd00:ec2::23]`, before reading the token, so the token is never sent to another host.

- 91574f2: An S3 `400 ExpiredToken` or `TokenRefreshRequired` response (an expired STS session token whose provider returned a missing or wrong `expiration`) now drops the cached credentials and resends the request once with a fresh provider call. The resend counts against the request budget like any attempt. If the resend is rejected the same way, or the credentials are static, the call throws `AccessDenied` naming the S3 code instead of `InvalidResponse`. `s3Storage`, `r2Storage` and `minioStorage` wire it up; the `AccessDenied` message says the provider must return fresh credentials with an accurate `expiration`. GCS is unchanged.

- 30c71aa: The S3 adapter now treats AWS S3's `409 ConditionalRequestConflict` on a contended `If-Match` PUT (such as the compactor's `current.json` CAS) as a retryable `NetworkError`, as it already did for contended `If-None-Match: "*"` creates. Previously it surfaced as a non-retriable `InvalidResponse`.

- 3898949: The Cloudflare scaffolds now start on `compatibility_date` `2026-10-23` instead of `2026-05-01`.

- 6a582cd: The Node scaffolds list no dependency in `allowBuilds`, since nothing in their tree needs an install script, so pnpm now fails the install when a dependency gains one instead of running it; review it, then add it to `allowBuilds` in `pnpm-workspace.yaml`. They also start with `node src/server/index.ts` (Node 26 strips types without `--experimental-strip-types`) and drop the unused `aws4fetch` dependency. Every scaffold drops its `Uint8Array` base64 type shim, which Node 26's types now provide.

- 9b67b4c: `@gusto/create-baerly-storage` now bundles its dependencies and declares none, so `npm create @gusto/baerly-storage` runs exactly the code our lockfile resolved instead of resolving `^` ranges on your machine. It colors output with Node's `util.styleText`, which honors `NO_COLOR` and `FORCE_COLOR`. Its bundled notices ship in `dist/THIRD-PARTY-LICENSES.txt`.

- 333271a: Give `/v1/since` cursors a generation, so a `baerly admin restore --force` truncation can no longer silently gap a long-poll stream. Before, a pre-restore cursor could resume into the restored collection and skip every restored row beneath it with no error.

  `current.json` now carries an opaque `generation` nonce, and a collection that has one hands out cursors of the form `<generation>.<lsn>`. A resume whose generation no longer matches is refused with `CursorExpired` (410; see that entry of this release). `generation` is an optional field of `schema_version: 3`, so existing buckets and cursors keep working; a collection that was never truncated resumes normally.

  Cursors are opaque, so no client action is required. The React subscription poll re-bootstraps on the refusal instead of retrying the dead cursor every second. A custom `/v1/since` consumer should back off, then restart with an empty cursor: re-bootstrapping without a delay turns a mixed-version fleet mid-deploy into a hot loop.

- a711368: `GET /v1/since` now stays inside the request's storage budget instead of failing with `CapacityExceeded` (409, not retriable), which stopped a React subscription for good. Under the `cf-free` profile with storage over `fetch` (S3 over HTTP) an idle long-poll used to run out of its 45 calls about 22 s into the 25 s default and return 409.

  A long-poll now ends when its budget runs out: with the events it read so far, whose `next_cursor` resumes exactly after the last one, or, after at least one poll interval, with an empty batch at the same cursor. Under `cf-free` over `fetch` an idle long-poll holds for about 22 s; with the R2 binding, under `cf-paid` and on Node it holds for the full timeout as before. A request that cannot afford even one poll returns `MaintenancePending` (503, retriable, `Retry-After: 1`), never an empty batch at once. An idle poll also costs two storage reads however far `tail_hint` lags the tail, and a busy poll reads each entry once instead of twice.

  No app code changes; the response shape and cursor contract are unchanged. The bundled client already retries `MaintenancePending`.

- d8b7bf6: Aborting an S3, GCS or R2 binding storage call through its `AbortSignal` now stops it after the attempt in flight, whatever the abort reason: a plain `abort()`, a custom reason, or a deadline's `TimeoutError` (as from `AbortSignal.timeout()`). No further attempt is signed, backed off or sent. An S3 or GCS call cancels its request in flight and rejects with the signal's reason, as the memory and local-fs adapters already did; an R2 binding call already in flight runs to its end and surfaces its own result. Before, an S3 request kept running after the abort, a GCS abort was wrapped as a retriable `NetworkError` and resent until the retry limit ran out, and a reason other than an `AbortError` was retried on every adapter. Code that treated a cancelled call as a `NetworkError` should check `signal.aborted` (or the reason it aborted with) instead. An aborted write is not proof that it was not applied.

- af4c482: The 1 MiB request-body cap now holds on Cloudflare Workers for chunked uploads without a `Content-Length`. The router counts bytes as it reads and returns `413 PayloadTooLarge` as soon as a body passes the cap, instead of buffering the whole upload before checking. The 413 envelope is unchanged, and Node keeps its existing cap.

- 49f122d: Serve Cloudflare Worker point reads directly from storage so completed PUT, PATCH, and direct SDK writes are visible, including across overlapping reads and query-string variants. Remove the response-body cache and its `cache_status` log field. Repeated reads now pay the storage-backed read cost; request limits, maintenance thresholds, and the supported read envelope stay unchanged.

- b78a8c2: Write-tick maintenance now refreshes `tail_hint` whenever the refresh is due, including when the tick's fold publishes nothing or the fold or GC throws. Previously a collection whose folds and GC kept failing (for example a persistent 503 with no adapter retries) never advanced `tail_hint`. Each commit's tail search then cost more GETs as writes piled up since the last refresh, and once the lag neared 100,000 writes, reads and then commits started failing. The lag now stays within about 132 writes (the 128-write refresh interval plus the 4-write GC cadence) whatever the tick's outcome.

- 8f7e4f8: Both packages now publish from GitHub Actions with npm trusted publishing, so every release carries a provenance attestation (`npm audit signatures` verifies it). Scaffolded apps set pnpm's `trustPolicy: no-downgrade`, which refuses a later version that lacks provenance, so a release published outside this workflow can't reach them.

- c73bd78: The Node and Cloudflare adapters now run the `Verifier` inside the per-request observability context, so `getCurrentContext()` is defined for work the verifier does (for example a JWKS fetch). Responses, status codes and canonical log lines are unchanged.

- e840ce8: A `Verifier` that throws no longer rejects the request handler with no log line. A thrown `BaerlyError` now answers with its own mapped status and error envelope (for example `NetworkError` from a failed JWKS fetch is a retriable 502, never a 401), any other throw answers an enveloped 500 `Internal`, and each emits exactly one canonical log line. Returning `null` still answers 401.

- e5b8d7c: A deployed Cloudflare Worker no longer bundles the Node-only `LocalFsStorage` code (and its `node:fs`, `node:os`, `node:path` and `node:crypto` imports), which it pulled in only for the dev landing page and could never run under workerd. `dist/cloudflare.js` is about 12.7 KB raw and 1.8 KB min-gzipped smaller, and it now imports no Node builtin except `node:async_hooks`.

- 43168b0: Write-tick maintenance now fits inside the request's storage request budget. Before each phase it checks what the request has left: a fold that does not fit is skipped until a later write, and a GC slice or log-retirement pass deletes fewer objects. If a call is still refused part-way through, the tick stops quietly. The new counters `db.maintenance.request_budget_skipped_total` (label `phase`) and `db.maintenance.request_budget_refused_total` record both cases; neither counts toward `db.maintenance.unexpected_error_total`. Node has no budget, so nothing changes there. No app code changes.

## 0.6.0

### Minor Changes

- c806852: `baerlyDev` can now load `baerly.config` itself instead of requiring the caller to import it and pass the object.

  `BaerlyDevOptions.config` is now optional; two new resolution modes:

  - `configPath` — absolute path to the config module, loaded lazily at dev-server startup via Vite's `ssrLoadModule`.
  - **convention** (nothing passed) — loads `<viteRoot>/src/baerly.config.ts`, mirroring how `reactRouter()` loads `react-router.config.ts`.

  Passing an explicit `config` object still works and is unchanged, including fail-fast verifier resolution at factory time.

  **Why:** when an app's `vite.config.ts` imports its `baerly.config` to pass the object in, Nx's `@nx/vite` / `@nx/vitest` inference plugins bundle that config during project-graph creation, dragging the config module's transitive imports (`@gusto/baerly-storage/config`, `zod`) into the config bundle. Those fail to resolve in CI and crash graph creation, forcing every baerly app into the root `nx.json` inference-plugin exclusion lists — a global edit that marks the whole monorepo affected. Letting `baerlyDev` load the config itself keeps the caller's `vite.config` import-free, so the exclusion is no longer needed.

- 6336a06: Native Google Cloud Storage adapter: `gcsStorage` now drives GCS's own generation-precondition conditional writes over the native XML API (`x-goog-if-generation-match`), promoting GCS to a Tier-1 backend.

  **Migration.** The `gcsStorage({ bucket, credentials })` signature is unchanged, so existing callers keep compiling. What changes is the wire behavior: the factory previously produced an S3-interop client whose conditional headers GCS silently ignored on writes (it could not linearize the commit log and was unsupported); it now speaks the native GCS XML API and gains real create-if-absent + CAS, returning `412` → `Conflict` on a lost write. Credentials remain GCS HMAC interop keys (`accessKeyId` / `secretAccessKey`). Node host only — no Worker `/gcs` subpath and no GCP deploy target in v1.

### Patch Changes

- 8322ce2: Canonical HTTP log lines now classify by wire status alone: any 4xx is `warn`, not `error`, even when a structured error is attached. Previously an attached error forced `error` level regardless of status, so a `409 Conflict` logged at `error`.

  **Why:** a 4xx is the caller's fault, not a server fault. The reachable 409 is a duplicate-`_id` insert (a reused id or a double-submitted POST); ordinary storage write contention is absorbed internally by the log forward-probe and never reaches the client as a 409. Logging these at `error` polluted error budgets and could page on-call for normal operation. `error` is now reserved for genuine server faults: 5xx, a 2xx/3xx that anomalously carries an error, or a thrown error with no wire status to classify by. The line still carries the structured `{ code, message }` on the failure path; only the stack (unneeded for a routine client error) drops off at `warn`.

- a1cd0a3: Bump `@logtape/logtape` 2.2.2 → 2.2.4 to pick up the upstream fix for the `configure()` process exit-listener leak ([dahlia/logtape#192](https://github.com/dahlia/logtape/issues/192)). Previously each `configure()` registered a new `process.on("exit", …)` hook without removing the prior one; 2.2.4 unregisters the previous dispose hook before registering a new one. Production adapters call `configureObservability` once so nothing shipped broken, but repeated reconfiguration in one process (test suites, hot-reload) no longer leaks listeners. No public API changes.

- 3387380: S3/GCS adapter `delete()` now surfaces an unexpected non-2xx/404 status as an error instead of silently treating it as success. `200`/`204`/`404` stay a success (delete is idempotent; a `404` is a no-op); anything else maps through the shared classifier (`403` → `AccessDenied`; `429` and `≥500` → retryable `NetworkError`; anything else → `InvalidResponse`).

  **Why:** the previous inline path swallowed every non-2xx as success, so a `403` on delete during GC/compaction looked like it removed an object it never touched — the bucket would grow while maintenance reported success. Surfacing the status is a correctness fix. It is safe on the write path: GC deletes in parallel and a thrown delete aborts only the rest of that sweep (landed deletes are durable, `pending.json` is CAS-merged), and the maintenance runner already swallows every non-`Conflict` throw after counting + logging it, so a delete error never propagates to crash a write-tick.

## 0.5.0

### Minor Changes

- 5afe09a: Observability: coexist with a host app's LogTape config instead of clobbering it.

  baerly-storage is a library, and LogTape's guidance is that only the application configures LogTape. Previously the Node and Cloudflare adapters called `configure({ reset: true })` at boot unconditionally, which silently wiped the sinks and loggers of any app that had already configured LogTape (and, depending on boot order, could itself be wiped). The documented "leave the field unset to skip configuration" escape hatch never actually worked.

  Now:

  - `configureObservability` checks `getConfig()` first. When LogTape is already configured by something other than baerly-storage, it leaves that config intact and emits a single `["logtape", "meta"]` notice rather than resetting it. baerly-storage's own config is still reconfigured last-call-wins, so standalone servers and dev hot-reload are unchanged.
  - `baerlyNode` / `baerlyWorker` accept `observability: false` to skip auto-configuration entirely, for apps that own the process-wide (isolate-wide on Workers) LogTape configuration themselves.

### Patch Changes

- d94b57b: Rename the `/v1/spec` field `kernelVersion` → `serverVersion`.

  `kernelVersion` was a build-provenance stamp (= the published package version) whose name wrongly implied a separate "kernel" contract axis. `serverVersion` names it honestly. The value and meaning are unchanged, and `specVersion` stays `"1"`: the wire-contract axis is `specVersion`, and pre-consumer wire shape may change without bumping it (see `docs/contributing/conventions/versioning.md`).

  **Migration — agents: if you read the LEFT, read the RIGHT:**

      GET /v1/spec → { "specVersion": "1", "kernelVersion": "0.4.1", ... }   // before
      GET /v1/spec → { "specVersion": "1", "serverVersion": "0.4.1", ... }   // after

  Key contract decisions off `specVersion`, never off `serverVersion` — the latter is build provenance, equal to the package version.

## 0.4.1

### Patch Changes

- Stamp the correct kernelVersion into the served /v1/spec. 0.4.0 shipped kernelVersion "0.3.0" because changeset:version did not regenerate baerly.spec.json; gen:spec now runs on every bump.

## 0.4.0

### Minor Changes

- 878bd78: Fail closed on ephemeral storage in production

  `MemoryStorage` now refuses to construct in a detected deployment (`NODE_ENV=production` or a known PaaS marker) unless you explicitly acknowledge that it's ephemeral. This closes a silent-data-loss failure mode: an app that falls back to in-memory storage in production, where writes "succeed" into process RAM and vanish on every restart with no loud signal.

  **What changed**

  - `new MemoryStorage()` throws `BaerlyError("InvalidConfig")` in a detected deployment. Tests and local dev are unaffected — neither sets those signals.
  - New `resolveStorageFromEnv(env?)` export on `@gusto/baerly-storage/node`: the safe, tested storage selector the Node example scaffolds now use, so apps don't hand-roll one with a silent fallback.
  - New `assertStorageReachable(storage)` export on `@gusto/baerly-storage/node`: an opt-in boot/readiness check that fails closed on an unreachable or CAS-broken bucket — the wrong-bucket-name gap a missing-bucket guard can't catch.
  - New pure `isDeployedEnv(env)` predicate on `@gusto/baerly-storage`.

  **Migration**

  - To run in-memory storage in a deployment on purpose (e.g. a throwaway demo), opt in explicitly — either in code:

    ```ts
    new MemoryStorage({ ephemeral: true });
    ```

    or via the environment:

    ```sh
    BAERLY_ALLOW_EPHEMERAL_STORAGE=true
    ```

  - No action needed for tests, local dev, or apps already using a real S3/R2 bucket.

  **Platform note**

  - The guard is effectively Node-only. A Cloudflare Worker requires an R2 binding and has no silent in-memory fallback, and the deploy-detection predicate reads `process.env`, which is empty on Workerd — so the guard never fires (and never needs to) on Cloudflare.
  - CI is never treated as deployed. When `CI` is set to a non-empty, non-`false` value, PaaS-marker detection is suppressed, so `MemoryStorage` still constructs in CI — including Kubernetes-hosted CI agents that set `KUBERNETES_SERVICE_HOST`. An explicit `NODE_ENV=production` still trips the guard.

- ab1d80e: Node apps can now run with zero storage credentials, using the new `localFsStorage()` factory from `@gusto/baerly-storage/node`. The Node examples default to local filesystem storage in development and promote to S3 or R2 once bucket environment variables are set.

  `localFsStorage()` is a local-dev convenience only — single-process, with no cross-process CAS and no crash durability. So the Node example servers fail loud in a detected deployment (`NODE_ENV=production` or a known PaaS) and require a real bucket: a missing or typo'd bucket aborts startup instead of running production on non-durable storage. There is deliberately no opt-in to run local-fs in a deployment. When self-hosting without a cloud bucket, run MinIO on the box or use SQLite + Litestream.

- 7ded765: Cloudflare Workers can now talk to S3-compatible storage over HTTP instead of a native R2 binding. This is opt-in; the R2 binding remains the default.

  New exports and options:

  - New Worker-safe subpath `@gusto/baerly-storage/s3` exports `S3HttpStorage` and `sigV4Signer`. Their closure pulls in no `node:` builtins, so it loads in a Worker.
  - `baerlyWorker` accepts an optional `storage` in its factory options. It defaults to the `env.BUCKET` R2 binding.
  - `BaerlyEnv.BUCKET` is now optional, so an S3-only Worker need not declare an R2 binding.

  `sigV4Signer` fails fast with `InvalidConfig` when `accessKeyId`, `secretAccessKey`, or `region` is empty or whitespace-only (for example, a blank or accidentally-spaced wrangler `var`). This replaces signing with blank credentials — or building a malformed empty-region SigV4 scope — and drawing an opaque 403.

  This path ships at the same support tier as AWS-via-`S3HttpStorage`: credential-gated, with production validation owned by the operator. CI guards the closure under workerd on two levels:

  - a bundle probe that it stays `node:`-free (so it loads in a Worker), and
  - an in-isolate wire test that `S3HttpStorage` + `sigV4Signer` actually run there — signing, XML parse, request/response plumbing — against an in-memory S3 stub.

  CI does not drive a real S3 endpoint from workerd. Verify yours with `baerly doctor --bucket` before relying on it. Note that `baerly deploy` and `doctor --target=cloudflare` still expect an R2 binding in `wrangler.jsonc`.

- df232a4: Add IRSA (web-identity) credential support for S3 on EKS. Previously `fromEksPodIdentity()` handled only the EKS Pod Identity agent (`AWS_CONTAINER_CREDENTIALS_FULL_URI`). Clusters that inject credentials via IRSA (`AWS_ROLE_ARN` + `AWS_WEB_IDENTITY_TOKEN_FILE`) threw `InvalidConfig` on first sign, so every S3 call failed.

  Two new credential providers in `@gusto/baerly-storage/node`:

  - `fromWebIdentity()` — exchanges the projected service-account token for short-lived credentials via STS `AssumeRoleWithWebIdentity`. The call is unsigned; the token is the auth. It returns `expiration`, so the signing layer rotates the ~1h credentials automatically. No AWS SDK dependency — it uses `fetch` plus the existing hardened XML parser.
  - `fromEks()` — auto-detects the mechanism on each resolve: Pod Identity when `AWS_CONTAINER_CREDENTIALS_FULL_URI` is present, otherwise IRSA. It throws a clear `InvalidConfig` when neither is configured. Prefer this over the mechanism-specific providers unless you have a reason to pin one.

  Both EKS providers now fail with actionable errors instead of a bare status. A missing, unreadable, or empty projected token throws `InvalidConfig`. A failed STS `AssumeRoleWithWebIdentity` call folds the STS error `Code`/`Message` (for example, `InvalidIdentityToken`) into the thrown message, so credential misconfigs are diagnosable at a glance.

  `fromEksPodIdentity()` keeps its behavior; it only gains the same `InvalidConfig` token-file guards.

- 73110de: Add public exports `PredicateArg` / `Predicate` / `Collection`; fix `Path<T>` for optional array fields

  **New public exports**

  - `PredicateArg`, `Predicate`, and `Collection` are now exported from `@gusto/baerly-storage`.
  - `PredicateArg` is now exported from `@gusto/baerly-storage/client` (which already exported `ClientCollection` and `Predicate`).

  These let you name the `.where(...)` argument and predicate types directly instead of hand-rolling a structural interface to accept a `Db` or a `BaerlyClient`. The client handle type stays `ClientCollection`; the in-process `Collection` type is root-only, because the client's HTTP handle is structurally distinct (read-only `.where(...)`, `TerminalOptions`).

  **Bug fix — optional array fields**

  `Path<T>` (the dotted-path key type behind `Predicate<T>` and `.where(...)`) now runs its leaf test on `NonNullable<T[K]>`, so `Path<{ tags?: string[] }>` is `"tags"` — an optional array ends path recursion exactly like a required one. Previously the `undefined` arm of `string[] | undefined` defeated the array-is-a-leaf check and synthesized bogus `Array.prototype` keys (`tags.map…`), which broke assignability of a bound `Db<Config>` / `BaerlyClient<Config>` to a hand-rolled structural `collection(name: string)` interface — even for collections that never used the array field.

  **Migration**

  No action required — both changes are additive. If you hand-rolled a structural `collection(name: string)` shim to read collections by a runtime-computed name, you can now import the real types or narrow at the boundary:

  ```ts
  (db as Db<UnboundConfig>).collection(name);
  ```

### Patch Changes

- 29bb00c: Refresh dependencies ahead of release. No public API changes.

  Runtime deps that ship to consumers:

  - `@logtape/logtape` 2.1.3 → 2.2.2
  - `hono` 4.12.25 → 4.12.27
  - `@hono/node-server` 2.0.4 → 2.0.6
  - `jose` caret floor `^6.2.0` → `^6.2.3`

  The `@gusto/create-baerly-storage` scaffolder picks up `@clack/prompts` 1.6.0.

  The `@logtape/logtape` growth was rebaselined with a dated note in the bundle-size budgets. (The XML parser was separately swapped from `fast-xml-parser` to `@rgrove/parse-xml` — see the parser-swap changeset — which removes `fast-xml-parser` and its transitive closure from the tree entirely.)

- 4813d9e: Swap `fast-xml-parser` for `@rgrove/parse-xml` in the S3 XML decode path (`@baerly/adapter-node`). No public API changes — all exported functions and types are unchanged.

  **Smaller bundle:** −87 KiB raw / −24 KiB gz / −14 KiB min-gz on the `s3.js` closure. `@rgrove/parse-xml` also has zero transitive dependencies, where `fast-xml-parser` pulled in `strnum` and `@nodable/entities` — so the supply-chain and audit surface both shrink.

  **CVE-class defense-in-depth (not an active-hole fix):** `fast-xml-parser` shipped ~6 CVEs across 5.x (CVE-2026-25896, CVE-2026-26278, CVE-2026-33036, and others), all in the DOCTYPE/entity surface. Our `<!DOCTYPE` regex guard already made those vectors unreachable — the pinned `fast-xml-parser@5.8.0` was never itself vulnerable — but each new CVE still forced a version-pin review. `@rgrove/parse-xml` parses and discards DTDs without resolving custom entities, so the entity-expansion CVE _class_ cannot recur even if that regex guard ever regressed. Removing the dependency also ends its dependabot cadence.

  **Intended entity-set difference (not a bug):** `@rgrove/parse-xml` decodes only the 5 predefined XML entities (`&amp; &lt; &gt; &quot; &apos;`) plus decimal and hex numeric character references. It does NOT decode HTML named entities (`&nbsp;`, `&mdash;`, etc.); the old code enabled `htmlEntities: true` solely to get numeric refs. S3/R2/MinIO wire data is XML, not HTML — no backend emits HTML-only named entities in `ListObjectsV2` or error responses — so the narrower set is more spec-correct.

  The swap was validated during development with a one-time differential-oracle test asserting field-for-field parity between the two parsers on generated S3-shaped XML (predefined entities, decimal/hex numeric refs, CDATA, singular and plural `<Contents>`). That check is not retained; going forward, parser behavior is pinned by the example-based contract tests in `packages/adapter-node/src/xml.test.ts`.

- e18e9c4: Reject `.` / `..` / empty object keys at the Storage boundary

  Every `Storage` adapter (`MemoryStorage`, `S3HttpStorage`, `r2BindingStorage`, `LocalFsStorage`) now validates the key on `get` / `put` / `delete` and throws `BaerlyError("InvalidConfig")` when the key is empty or has a `.` or `..` segment in its `/`-delimited path. Such keys can't be addressed over the S3/R2 HTTP API: RFC 3986 dot-segment removal rewrites `<bucket>/.` to the bucket root before the request is signed, so a naive PUT fails as a confusing bucket-root `403` instead of a clear error. The check runs client-side, before any network call, so every backend rejects identically and the behavior ports cleanly to other languages.

  **What changed**

  - `get` / `put` / `delete` on all adapters reject `""`, `.`, `..`, and any key with a `.` or `..` path segment, with `InvalidConfig`. `list(prefix)` is unaffected — a prefix rides the `?prefix=` query component, where `.` / `..` are harmless.
  - The 1024-byte full-key ceiling is still enforced on the write path (`assertKeyWithinLimit`), where multi-segment keys are assembled.

  **Migration**

  - No action for normal use. The kernel never emits these keys, and caller-controlled segments (`_id`, `collection`, `app`, `tenant`) are already screened one layer up. If you call a `Storage` adapter directly with a bare `.` / `..` / empty key, catch `BaerlyError` and check `code === "InvalidConfig"`.
  - Shipped as a patch, not a minor: these keys were never addressable — a `.` / `..` / empty key already failed with an opaque bucket-root `403` — so no working call site changes behavior.

- b8b87e5: Write down the durable-contract promises: LogEntry is versionless, version axes are named and drift-gated, and backend capabilities are split into required vs. optional

  Documentation and internal tooling only. Nothing changes in the emitted bytes, the public API, or runtime behavior — this just records compatibility promises the project already relied on, so anyone building on the durable contract (the CDC-style `LogEntry` export, the bucket layout) can depend on them in writing.

  **LogEntry is versionless and additive-only (ADR-005, `docs/adr/005-logentry-versionless.md`)**

  - `LogEntry` carries no `schema_version`; the live wire contract is owned by `docs/spec/log-entry-shape.md`. Consumers **must ignore unknown keys** — a compatible release can add new optional fields at any time. Renaming a field, repurposing a value, removing a field, or widening `op` requires an explicit compatibility decision, a migration note, and a versioned release.

  **Version matrix + drift gate**

  - `docs/contributing/version-matrix.json` names every version axis in one place: package semver, `specVersion`, the per-artifact durable `schema_version`s, the `layout_version` cordon, and a reserved conformance `corpusVersion`.
  - `docs/contributing/conventions/versioning.md` states the pre-1.0 rules: no breaking wire/schema/layout change ships as a patch; while `0.x` it takes a minor plus a migration note.
  - `scripts/check-version-matrix.ts` fails `verify` on drift — it derives `specVersion` from the wire IR so the matrix can't diverge, and enforces package lockstep plus the LogEntry/layout/corpus sentinels. `gen:version-matrix` regenerates the artifact from the reference implementation.

  **Required vs. optional storage capabilities**

  - `docs/spec/capabilities.md` records what a backend MUST support to certify as a full `Storage` (CAS — exactly-one-winner conditional create — is required, not optional), what is optional, and a planned read-only `ReaderStorage` tier.

  **Migration**

  - No action required. Nothing in the emitted bytes, the public API, or runtime behavior changes. `SNAPSHOT_SCHEMA_VERSION` replaces a `1` literal with a named constant of the same value.

## 0.3.0

### Minor Changes

- 79cc324: First public release. `baerly-storage` is a vendorless document database that runs over any S3-compatible bucket — the data lives in your bucket and there is no runtime to operate. Commit is one conditional log append (`If-None-Match`) per collection, so each collection is linearizable; compaction and GC run in-band on writes (reads never tick); no operator cron or sidecar. First-class on Cloudflare Workers (R2) and self-hosted Node (S3), with day-one templates for both.

  Versions `0.1.x`–`0.2.0` were internal/experimental builds. They remain published, but this is the first release intended for outside use. **Still pre-1.0:** the on-disk format and public API may change between minor versions until 1.0 — pin your version.

  **New here? You're done — everything above is what you get.** The rest is for the few of you who ran an internal `0.1`–`0.2` build and need to know what changed since `0.2.0`. Reach out and I'll help you migrate.

  **Migrating from an internal build**

  - **Cheaper commits, and a breaking on-disk format (schema v3).** A write now costs 2 Class-A PUTs instead of 3 — appending the numbered `log/<seq>` entry _is_ the commit, so there is no separate `current.json` write. `current.json` becomes compactor-owned compaction state (`next_seq` → `tail_hint`, `+mean_entry_bytes`, `−tail_bytes`), and readers discover the true tail by forward-probe. **Buckets written under schema v2 are rejected with no migration path** — re-create the bucket (or `admin dump` on a v2 build → `admin restore` on this one). See ADR-004.
  - **`Db.transaction` removed — the document is the atomic unit.** Single-document writes are each atomic; there is no batch. Replace `db.transaction(name, tx => { tx.update(a); tx.update(b) })` with individual `db.collection(name).update(...)` calls. The both-or-neither guarantee is gone; model a single document as your consistency boundary. Re-adding transactions later is additive (under the API surface lock).
  - **Tighter key-segment validation.** One shared rule validates every caller-controlled segment (`_id`, `collection`, `app`, `tenant`), rejecting empty / `/` / `.` / `..` / control chars / reserved leading `_` / over-length as `InvalidConfig`. The per-segment byte cap drops 1024 → 256 (an existing `_id` of 257–1024 bytes can no longer be read-modified), and over-long assembled keys now fail early as `InvalidConfig` instead of an opaque provider `KeyTooLong`. HTTP (`/v1/since`) and the `baerly admin` CLI route through the same rule.

  **Fixed**

  - **The change feed no longer dies after 1024 writes to a collection.** The `/v1/since` cursor's sequence segment was 10-bit (`0..1023`); the 1025th write produced an invalid cursor the server then rejected with a `400`, permanently killing the feed. It is now 53-bit from a single source of truth.
  - **Concurrent create-if-absent has exactly one winner.** `LocalFsStorage` now uses an atomic `link(2)` exclusive create (was a TOCTOU read-then-write that could admit two winners and split-brain the commit path), and `baerly doctor --bucket` gains an `ifNoneMatch-concurrent` linearizability check. The property is asserted for every shipped adapter by the conformance suite.
  - **Adapter error contract + CVE floor.** Terminal socket failures from `S3HttpStorage` now surface as `BaerlyError{code:"NetworkError"}` instead of raw `fetch` throws; the `fast-xml-parser` floor is raised past the disclosed entity/numeric-reference advisories (bundle byte-neutral); and schema-mismatch errors now name the required version and prescribe recovery.
  - **GC stays bounded under backlog and concurrency.** The live-content-hash scan now walks the log in bounded chunks (was an unbounded `Promise.all` that could exceed Cloudflare's subrequest cap on a backlogged tail), and `gc/pending.json` is merged under CAS with bounded retry so a concurrent GC pass can no longer silently lose candidate marks.
  - **Scaffolded Node + Docker apps boot.** The `--with=docker --target=node` template now copies `baerly.config.ts` into the runtime image (the server entrypoint imports it), so the container no longer crashes on an unresolved-import error at startup.

## 0.2.0

### Minor Changes

- React hooks are now bound to your config via the `createBaerlyReact` factory.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before — loose hook exports (removed)
  import {
    BaerlyProvider,
    useQuery,
    useMutation,
    useBaerlyClient,
  } from "@gusto/baerly-storage/client/react";

  // after — factory bound to your defineConfig collections
  import { createBaerlyReact } from "@gusto/baerly-storage/client/react";
  const { Provider, useQuery, useMutation, useClient } = createBaerlyReact<typeof config>();
  ```

  The loose exports no longer exist; obtain the hooks from the factory so they are typed against your config (additive-only surface lock).

## 0.1.2

### Patch Changes

- In-band maintenance landed: compaction + GC run opportunistically on the write path (reads never tick), gated so idle buckets pay zero. No operator cron or sidecar required.
- **`LogEntry` wire shape tightened** (affects `baerly export` / log consumers): `new` → `after`, `old` → `before`; `op` narrowed to `"I" | "U" | "D"`; `patch` and `schema_version` removed; `doc_id` is now required.
- Leading-underscore names are reserved for collections and indexes (one `InvalidConfig` contract). A config using a `_`-prefixed collection name is rejected.
- `adapter-node` parses S3 `<Error>` response bodies and guards against `Invalid Date`.
- `baerly doctor --bucket <uri>` performs a live CAS probe.

## 0.1.1

### Patch Changes

- Internal tooling only: `pnpm dev:storage` ports are parameterised so two worktrees can run stacks side by side; added a package-layer DAG lint. No public API changes.

## 0.1.0

### Minor Changes

- Initial release of `@gusto/baerly-storage` — a vendorless document database over any S3-compatible bucket. Public surface: `Db.create()`, `db.collection(...)` with the eight-verb / three-modifier / six-operator query API, `defineConfig`, `createBaerlyClient`, the Cloudflare Workers and self-hosted Node adapters, and the `baerly` CLI. See `dist/API.md` for the full surface.

---

_Maintained by [Changesets](https://github.com/changesets/changesets); entries at and below `0.2.0` were backfilled by hand from the git history. This file ships in the published package at `dist/CHANGELOG.md` so an agent that expected an older API can recover the current call. The `.d.ts` types are the canonical authority — if this file and the types disagree, the types win. (The footer sits below all versions because Changesets prepends new releases under the H1.)_
